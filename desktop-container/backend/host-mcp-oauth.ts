import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const HOST_MCP_DIRECTORY_NAME = "host-mcp";
const HOST_MCP_OAUTH_DIRECTORY_NAME = "oauth";
const CALLBACK_PATH_PREFIX = "/host-mcp/oauth/callback/";
const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface HostMcpOAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
  clientName: string | null;
  clientUri: string | null;
  clientMetadataUrl: string | null;
  scope: string | null;
  tokenEndpointAuthMethod: string | null;
}

export function createDefaultHostMcpOAuthConfig(): HostMcpOAuthConfig {
  return {
    clientId: null,
    clientMetadataUrl: null,
    clientName: null,
    clientSecret: null,
    clientUri: null,
    scope: null,
    tokenEndpointAuthMethod: "none",
  };
}

export type HostMcpBrowserOpener = (url: string) => Promise<void> | void;

interface PersistedHostMcpOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string | null;
  tokens?: OAuthTokens;
}

interface PendingAuthorization {
  opened: boolean;
  promise: Promise<string>;
  reject: (error: Error) => void;
  resolve: (authorizationCode: string) => void;
}

function createPendingAuthorization(): PendingAuthorization {
  let resolvePending!: (authorizationCode: string) => void;
  let rejectPending!: (error: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
  });

  return {
    opened: false,
    promise,
    reject: rejectPending,
    resolve: resolvePending,
  };
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function isHttpsMetadataUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname !== "/";
  } catch {
    return false;
  }
}

function normalizeTokenEndpointAuthMethod(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ?? null;
}

function getOAuthStateDirectory(dataDirectory: string): string {
  return resolve(
    dataDirectory,
    HOST_MCP_DIRECTORY_NAME,
    HOST_MCP_OAUTH_DIRECTORY_NAME,
  );
}

function getOAuthStatePath(dataDirectory: string, serverId: string): string {
  return resolve(getOAuthStateDirectory(dataDirectory), `${serverId}.json`);
}

export function clearPersistedHostMcpOAuthState(
  dataDirectory: string,
  serverId: string,
): void {
  rmSync(getOAuthStatePath(dataDirectory, serverId), { force: true });
}

function createAuthorizationResultHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #111827;
        color: #f9fafb;
      }
      main {
        width: min(32rem, calc(100vw - 2rem));
        padding: 2rem;
        border-radius: 1rem;
        background: rgba(17, 24, 39, 0.92);
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.5rem;
      }
      p {
        margin: 0;
        line-height: 1.55;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${body}</p>
    </main>
    <script>
      setTimeout(() => window.close(), 1200);
    </script>
  </body>
</html>
`;
}

function defaultBrowserOpener(url: string): Promise<void> {
  return awaitSpawnedBrowser(url);
}

function awaitSpawnedBrowser(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const command =
      process.platform === "darwin"
        ? { file: "open", args: [url] }
        : process.platform === "win32"
          ? { file: "cmd", args: ["/c", "start", "", url] }
          : { file: "xdg-open", args: [url] };

    const child = spawn(command.file, command.args, {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

class HostMcpOAuthStateStore {
  private readonly statePath: string;

  constructor(
    private readonly dataDirectory: string,
    private readonly serverId: string,
  ) {
    this.statePath = getOAuthStatePath(dataDirectory, serverId);
  }

  load(): PersistedHostMcpOAuthState {
    if (!existsSync(this.statePath)) {
      return {};
    }

    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Record<
        string,
        unknown
      >;
      return {
        clientInformation:
          parsed.clientInformation &&
          typeof parsed.clientInformation === "object" &&
          !Array.isArray(parsed.clientInformation)
            ? (parsed.clientInformation as OAuthClientInformationMixed)
            : undefined,
        codeVerifier: normalizeOptionalString(
          typeof parsed.codeVerifier === "string" ? parsed.codeVerifier : null,
        ),
        tokens:
          parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
            ? (parsed.tokens as OAuthTokens)
            : undefined,
      };
    } catch {
      return {};
    }
  }

  save(state: PersistedHostMcpOAuthState): void {
    const directory = getOAuthStateDirectory(this.dataDirectory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      this.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
  }

  clear(): void {
    rmSync(this.statePath, { force: true });
  }
}

export class HostMcpOAuthManager {
  private callbackServer: HttpServer | null = null;
  private callbackServerPort: number | null = null;
  private callbackServerPromise: Promise<number> | null = null;
  private readonly pendingAuthorizations = new Map<string, PendingAuthorization>();

  constructor(
    private readonly options: {
      browserOpener?: HostMcpBrowserOpener;
      callbackHost?: string;
      callbackPort?: number;
      timeoutMs?: number;
    } = {},
  ) {}

  async getRedirectUrl(serverId: string): Promise<string> {
    const port = await this.ensureCallbackServer();
    return `http://${this.callbackHost}:${port}${this.getCallbackPath(serverId)}`;
  }

  async beginAuthorization(serverId: string, authorizationUrl: URL): Promise<void> {
    await this.ensureCallbackServer();
    let pending = this.pendingAuthorizations.get(serverId);
    if (!pending) {
      pending = createPendingAuthorization();
      this.pendingAuthorizations.set(serverId, pending);
    }

    if (pending.opened) {
      return;
    }

    pending.opened = true;
    try {
      await (this.options.browserOpener ?? defaultBrowserOpener)(
        authorizationUrl.toString(),
      );
    } catch (error) {
      this.pendingAuthorizations.delete(serverId);
      pending.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async waitForAuthorizationCode(
    serverId: string,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS,
  ): Promise<string> {
    const pending = this.pendingAuthorizations.get(serverId);
    if (!pending) {
      throw new Error(`No OAuth authorization is pending for host MCP server ${serverId}.`);
    }

    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        pending.promise,
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            this.pendingAuthorizations.delete(serverId);
            reject(
              new Error(
                `Timed out waiting for OAuth authorization for host MCP server ${serverId}.`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  dispose(): void {
    for (const [serverId, pending] of this.pendingAuthorizations) {
      this.pendingAuthorizations.delete(serverId);
      pending.reject(
        new Error(`Host MCP OAuth flow for ${serverId} was cancelled.`),
      );
    }

    if (this.callbackServer) {
      this.callbackServer.close();
      this.callbackServer = null;
      this.callbackServerPort = null;
      this.callbackServerPromise = null;
    }
  }

  private get callbackHost(): string {
    return this.options.callbackHost?.trim() || "127.0.0.1";
  }

  private getCallbackPath(serverId: string): string {
    return `${CALLBACK_PATH_PREFIX}${encodeURIComponent(serverId)}`;
  }

  private async ensureCallbackServer(): Promise<number> {
    if (this.callbackServerPort !== null) {
      return this.callbackServerPort;
    }
    if (this.callbackServerPromise) {
      return await this.callbackServerPromise;
    }

    this.callbackServerPromise = new Promise<number>((resolvePromise, rejectPromise) => {
      const server = createServer((request, response) => {
        void this.handleCallbackRequest(request, response);
      });

      server.once("error", (error) => {
        this.callbackServerPromise = null;
        rejectPromise(error);
      });

      server.listen(this.options.callbackPort ?? 0, this.callbackHost, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          this.callbackServerPromise = null;
          rejectPromise(
            new Error("Host MCP OAuth callback server did not expose a TCP port."),
          );
          return;
        }

        server.removeAllListeners("error");
        server.on("error", () => {});
        this.callbackServer = server;
        this.callbackServerPort = address.port;
        resolvePromise(address.port);
      });
    });

    return await this.callbackServerPromise;
  }

  private async handleCallbackRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(
      request.url || "/",
      `http://${this.callbackHost}:${this.callbackServerPort ?? 0}`,
    );
    if (!requestUrl.pathname.startsWith(CALLBACK_PATH_PREFIX)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const serverId = decodeURIComponent(
      requestUrl.pathname.slice(CALLBACK_PATH_PREFIX.length),
    );
    const pending = this.pendingAuthorizations.get(serverId);
    if (!pending) {
      response.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization session expired.");
      return;
    }

    const error = normalizeOptionalString(requestUrl.searchParams.get("error"));
    const code = normalizeOptionalString(requestUrl.searchParams.get("code"));
    this.pendingAuthorizations.delete(serverId);

    if (error) {
      pending.reject(
        new Error(`OAuth authorization failed for ${serverId}: ${error}`),
      );
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(
        createAuthorizationResultHtml(
          "Authorization Failed",
          `The OAuth flow for ${serverId} returned ${error}.`,
        ),
      );
      return;
    }

    if (!code) {
      pending.reject(
        new Error(`OAuth authorization for ${serverId} did not return a code.`),
      );
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(
        createAuthorizationResultHtml(
          "Authorization Failed",
          `The OAuth flow for ${serverId} did not return an authorization code.`,
        ),
      );
      return;
    }

    pending.resolve(code);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      createAuthorizationResultHtml(
        "Authorization Complete",
        "You can close this window and return to acon.",
      ),
    );
  }
}

export class PersistedHostMcpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;

  private readonly store: HostMcpOAuthStateStore;

  constructor(
    private readonly options: {
      serverId: string;
      oauth: HostMcpOAuthConfig;
      manager: HostMcpOAuthManager;
      dataDirectory: string;
      redirectUrl: string;
    },
  ) {
    this.store = new HostMcpOAuthStateStore(
      options.dataDirectory,
      options.serverId,
    );
    this.clientMetadataUrl = this.resolveClientMetadataUrl();
    this.addClientAuthentication = this.addClientAuthentication.bind(this);
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const tokenEndpointAuthMethod =
      normalizeTokenEndpointAuthMethod(
        this.options.oauth.tokenEndpointAuthMethod,
      ) ??
      (this.options.oauth.clientSecret ? "client_secret_post" : "none");

    const metadata: OAuthClientMetadata = {
      client_name:
        this.options.oauth.clientName ?? `acon host MCP ${this.options.serverId}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.options.redirectUrl],
      response_types: ["code"],
      token_endpoint_auth_method: tokenEndpointAuthMethod,
    };

    if (this.options.oauth.clientUri) {
      metadata.client_uri = this.options.oauth.clientUri;
    }
    if (this.options.oauth.scope) {
      metadata.scope = this.options.oauth.scope;
    }

    return metadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const staticClientId = this.options.oauth.clientId;
    if (staticClientId) {
      return {
        client_id: staticClientId,
        client_secret: this.options.oauth.clientSecret ?? undefined,
        token_endpoint_auth_method:
          this.options.oauth.tokenEndpointAuthMethod ?? undefined,
      };
    }
    return this.store.load().clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    if (this.options.oauth.clientId) {
      return;
    }

    const state = this.store.load();
    this.store.save({
      ...state,
      clientInformation,
    });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const state = this.store.load();
    this.store.save({
      ...state,
      codeVerifier: null,
      tokens,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.options.manager.beginAuthorization(
      this.options.serverId,
      authorizationUrl,
    );
  }

  async addClientAuthentication(
    headers: Headers,
    params: URLSearchParams,
    _url: string | URL,
    _metadata?: AuthorizationServerMetadata,
  ): Promise<void> {
    const clientInformation = this.clientInformation();
    if (!clientInformation?.client_id) {
      return;
    }

    const configuredMethod =
      normalizeTokenEndpointAuthMethod(
        "token_endpoint_auth_method" in clientInformation
          ? clientInformation.token_endpoint_auth_method
          : null,
      ) ??
      normalizeTokenEndpointAuthMethod(
        this.options.oauth.tokenEndpointAuthMethod,
      ) ??
      (clientInformation.client_secret ? "client_secret_post" : "none");

    params.set("client_id", clientInformation.client_id);

    if (configuredMethod === "client_secret_basic") {
      if (!clientInformation.client_secret) {
        throw new Error(
          `Host MCP server ${this.options.serverId} requires a client_secret for client_secret_basic authentication.`,
        );
      }

      const credentials = Buffer.from(
        `${clientInformation.client_id}:${clientInformation.client_secret}`,
        "utf8",
      ).toString("base64");
      headers.set("Authorization", `Basic ${credentials}`);
      return;
    }

    if (configuredMethod === "none") {
      return;
    }

    if (clientInformation.client_secret) {
      params.set("client_secret", clientInformation.client_secret);
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    const state = this.store.load();
    this.store.save({
      ...state,
      codeVerifier,
    });
  }

  codeVerifier(): string {
    const verifier = this.store.load().codeVerifier;
    if (!verifier) {
      throw new Error(
        `No OAuth code verifier is saved for host MCP server ${this.options.serverId}.`,
      );
    }
    return verifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    if (scope === "all") {
      if (this.options.oauth.clientId) {
        const state = this.store.load();
        this.store.save({
          codeVerifier: null,
          tokens: undefined,
          clientInformation: state.clientInformation,
        });
        return;
      }

      this.store.clear();
      return;
    }

    const state = this.store.load();
    const nextState: PersistedHostMcpOAuthState = { ...state };
    if (scope === "tokens") {
      delete nextState.tokens;
    } else if (scope === "verifier") {
      nextState.codeVerifier = null;
    } else if (scope === "client" && !this.options.oauth.clientId) {
      delete nextState.clientInformation;
    }
    this.store.save(nextState);
  }

  async waitForAuthorizationCode(timeoutMs?: number): Promise<string> {
    return await this.options.manager.waitForAuthorizationCode(
      this.options.serverId,
      timeoutMs,
    );
  }

  private resolveClientMetadataUrl(): string | undefined {
    if (isHttpsMetadataUrl(this.options.oauth.clientMetadataUrl)) {
      return this.options.oauth.clientMetadataUrl;
    }

    if (isHttpsMetadataUrl(this.options.oauth.clientUri)) {
      return this.options.oauth.clientUri;
    }

    return undefined;
  }
}
