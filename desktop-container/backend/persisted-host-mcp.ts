import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
  createRemoteProxyHostMcpServer,
  createStdioProxyHostMcpServer,
  type HostMcpRemoteTransport,
  type HostMcpServerRegistration,
} from "./host-mcp";
import {
  createHttpWrapperHostMcpServer,
  type HttpWrapperAuthConfig,
} from "./http-wrapper-mcp";
import {
  clearPersistedHostMcpOAuthState,
  createDefaultHostMcpOAuthConfig,
  getPersistedHostMcpOAuthClientSecret,
  setPersistedHostMcpOAuthClientSecret,
  type HostMcpOAuthConfig,
  type HostMcpOAuthManager,
} from "./host-mcp-oauth";
import {
  deletePersistedHostSecret,
  resolvePersistedSecretRefs,
} from "./host-secrets";

const HOST_MCP_DIRECTORY_NAME = "host-mcp";
const HOST_MCP_SERVERS_DIRECTORY_NAME = "servers";
const HOST_MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface PersistedHostMcpStdioServerRecord {
  id: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  envSecretRefs: Record<string, string>;
  name: string | null;
  version: string | null;
}

export interface PersistedHostMcpHttpServerRecord {
  headers: Record<string, string>;
  headerSecretRefs: Record<string, string>;
  id: string;
  name: string | null;
  oauth: HostMcpOAuthConfig | null;
  transport: HostMcpRemoteTransport;
  url: string;
  version: string | null;
}

export interface PersistedHostMcpHttpWrapperServerRecord {
  auth: HttpWrapperAuthConfig;
  baseUrl: string;
  id: string;
  name: string | null;
  transport: "http-wrapper";
  version: string | null;
}

export type PersistedHostMcpServerRecord =
  | PersistedHostMcpStdioServerRecord
  | PersistedHostMcpHttpServerRecord
  | PersistedHostMcpHttpWrapperServerRecord;

export interface PersistedHostMcpStdioInstallOptions {
  args?: string[];
  command: string;
  cwd?: string | null;
  env?: Record<string, string>;
  envSecretRefs?: Record<string, string>;
  id: string;
  name?: string | null;
  version?: string | null;
}

export interface PersistedHostMcpHttpInstallOptions {
  headers?: Record<string, string>;
  headerSecretRefs?: Record<string, string>;
  id: string;
  name?: string | null;
  oauth?: HostMcpOAuthConfig | null;
  transport?: HostMcpRemoteTransport;
  url: string;
  version?: string | null;
}

export interface PersistedHostMcpHttpWrapperInstallOptions {
  auth?: HttpWrapperAuthConfig | null;
  baseUrl: string;
  id: string;
  name?: string | null;
  version?: string | null;
}

export type PersistedHostMcpInstallOptions =
  | PersistedHostMcpStdioInstallOptions
  | PersistedHostMcpHttpInstallOptions
  | PersistedHostMcpHttpWrapperInstallOptions;

export interface PersistedHostMcpInstallResult extends PersistedHostMcpServerRecord {
  configPath: string;
  replaced: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeServerId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Host MCP server id must be a non-empty string.");
  }
  if (!HOST_MCP_SERVER_ID_PATTERN.test(normalized)) {
    throw new Error(
      "Host MCP server id may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  }
  return normalized;
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${label} must contain only strings.`);
    }
    return entry;
  });
}

function normalizeStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object of string values.`);
  }

  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new Error(`${label} must only contain string values.`);
    }
    normalized[key] = rawValue;
  }
  return normalized;
}

function normalizeSecretRefRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  const normalized = normalizeStringRecord(value, label);
  for (const [key, secretRef] of Object.entries(normalized)) {
    if (!secretRef.trim()) {
      throw new Error(`${label} secret ref for ${key} must be a non-empty string.`);
    }
  }
  return normalized;
}

function normalizeOptionalString(
  value: unknown,
  label: string,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when provided.`);
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeCwd(
  cwd: string | null,
  workspaceDirectory: string,
): string | null {
  if (!cwd) {
    return null;
  }

  return isAbsolute(cwd) ? cwd : resolve(workspaceDirectory, cwd);
}

function normalizeUrl(value: unknown): string {
  const raw = normalizeOptionalString(value, "Host MCP url");
  if (!raw) {
    throw new Error("Host MCP url must be a non-empty string.");
  }

  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Host MCP url must use http:// or https://.");
  }
  return url.toString();
}

function normalizeTransport(value: unknown): PersistedHostMcpServerRecord["transport"] {
  const normalized =
    typeof value === "string" && value.trim()
      ? value.trim()
      : "stdio";
  if (
    normalized !== "stdio" &&
    normalized !== "streamable-http" &&
    normalized !== "sse" &&
    normalized !== "http-wrapper"
  ) {
    throw new Error(`Unsupported persisted host MCP transport: ${normalized}.`);
  }
  return normalized;
}

function normalizeBaseUrl(value: unknown): string {
  const raw = normalizeOptionalString(value, "Host MCP baseUrl");
  if (!raw) {
    throw new Error("Host MCP baseUrl must be a non-empty string.");
  }

  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Host MCP baseUrl must use http:// or https://.");
  }
  return url.toString();
}

function normalizeHttpWrapperAuthConfig(value: unknown): HttpWrapperAuthConfig {
  if (value === undefined || value === null) {
    return {
      type: "none",
      secretRef: null,
      headerName: null,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HTTP wrapper auth must be an object when provided.");
  }

  const record = value as Record<string, unknown>;
  const type =
    typeof record.type === "string" && ["none", "bearer", "header"].includes(record.type)
      ? (record.type as HttpWrapperAuthConfig["type"])
      : "none";
  if (type === "none") {
    return {
      type,
      secretRef: null,
      headerName: null,
    };
  }

  const secretRef = normalizeOptionalString(record.secretRef, "HTTP wrapper auth secretRef");
  if (!secretRef) {
    throw new Error(`HTTP wrapper auth ${type} requires a non-empty secretRef.`);
  }

  if (type === "bearer") {
    return {
      type,
      secretRef,
      headerName: "Authorization",
    };
  }

  const headerName = normalizeOptionalString(record.headerName, "HTTP wrapper auth headerName");
  if (!headerName) {
    throw new Error("HTTP wrapper header auth requires a non-empty headerName.");
  }
  return {
    type,
    secretRef,
    headerName,
  };
}

function normalizeOauthConfig(value: unknown): HostMcpOAuthConfig | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Host MCP OAuth config must be an object when provided.");
  }

  const record = value as Record<string, unknown>;
  const oauth: HostMcpOAuthConfig = {
    clientId: normalizeOptionalString(record.clientId, "Host MCP OAuth clientId"),
    clientSecretRef: normalizeOptionalString(
      record.clientSecretRef,
      "Host MCP OAuth clientSecretRef",
    ),
    clientMetadataUrl: normalizeOptionalString(
      record.clientMetadataUrl,
      "Host MCP OAuth clientMetadataUrl",
    ),
    clientName: normalizeOptionalString(
      record.clientName,
      "Host MCP OAuth clientName",
    ),
    clientSecret: null,
    clientUri: normalizeOptionalString(record.clientUri, "Host MCP OAuth clientUri"),
    scope: normalizeOptionalString(record.scope, "Host MCP OAuth scope"),
    tokenEndpointAuthMethod: normalizeOptionalString(
      record.tokenEndpointAuthMethod,
      "Host MCP OAuth tokenEndpointAuthMethod",
    ),
  };

  return Object.values(oauth).some((entry) => entry !== null) ? oauth : null;
}

function getHostMcpServerDirectory(dataDirectory: string): string {
  return resolve(
    dataDirectory,
    HOST_MCP_DIRECTORY_NAME,
    HOST_MCP_SERVERS_DIRECTORY_NAME,
  );
}

function getHostMcpServerConfigPath(dataDirectory: string, serverId: string): string {
  return resolve(getHostMcpServerDirectory(dataDirectory), `${serverId}.json`);
}

export function normalizePersistedHostMcpServerRecord(
  raw: unknown,
  options: {
    workspaceDirectory: string;
  },
): PersistedHostMcpServerRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Persisted host MCP server config must be an object.");
  }

  const record = raw as Record<string, unknown>;
  const transport = normalizeTransport(record.transport);
  const id = normalizeServerId(String(record.id ?? ""));
  const name = normalizeOptionalString(record.name, "Host MCP name");
  const version = normalizeOptionalString(record.version, "Host MCP version");

  if (transport === "stdio") {
    const command = normalizeOptionalString(record.command, "Host MCP command");
    if (!command) {
      throw new Error("Host MCP command must be a non-empty string.");
    }

    return {
      id,
      transport: "stdio",
      command,
      args: normalizeStringArray(record.args, "Host MCP args"),
      cwd: normalizeCwd(
        normalizeOptionalString(record.cwd, "Host MCP cwd"),
        options.workspaceDirectory,
      ),
      env: normalizeStringRecord(record.env, "Host MCP env"),
      envSecretRefs: normalizeSecretRefRecord(
        record.envSecretRefs,
        "Host MCP envSecretRefs",
      ),
      name,
      version,
    };
  }

  if (transport === "http-wrapper") {
    return {
      auth: normalizeHttpWrapperAuthConfig(record.auth),
      baseUrl: normalizeBaseUrl(record.baseUrl),
      id,
      name,
      transport: "http-wrapper",
      version,
    };
  }

  return {
    headers: normalizeStringRecord(record.headers, "Host MCP headers"),
    headerSecretRefs: normalizeSecretRefRecord(
      record.headerSecretRefs,
      "Host MCP headerSecretRefs",
    ),
    id,
    name,
    oauth: normalizeOauthConfig(record.oauth),
    transport,
    url: normalizeUrl(record.url),
    version,
  };
}

export function listPersistedHostMcpServers(options: {
  dataDirectory: string;
  workspaceDirectory: string;
}): PersistedHostMcpServerRecord[] {
  const directory = getHostMcpServerDirectory(options.dataDirectory);
  if (!existsSync(directory) || !isDirectory(directory)) {
    return [];
  }

  const servers: PersistedHostMcpServerRecord[] = [];
  for (const entry of readdirSync(directory)) {
    if (extname(entry) !== ".json") {
      continue;
    }

    const configPath = resolve(directory, entry);
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const normalized = normalizePersistedHostMcpServerRecord(parsed, {
        workspaceDirectory: options.workspaceDirectory,
      });
      if (basename(entry, ".json") !== normalized.id) {
        continue;
      }
      servers.push(normalized);
    } catch {
      continue;
    }
  }

  return servers.sort((left, right) => left.id.localeCompare(right.id));
}

export function installPersistedHostMcpServer(options: {
  dataDirectory: string;
  workspaceDirectory: string;
  server: PersistedHostMcpInstallOptions & {
    transport: PersistedHostMcpServerRecord["transport"];
  };
}): PersistedHostMcpInstallResult {
  const normalized = normalizePersistedHostMcpServerRecord(options.server, {
    workspaceDirectory: options.workspaceDirectory,
  });
  const directory = getHostMcpServerDirectory(options.dataDirectory);
  const configPath = getHostMcpServerConfigPath(options.dataDirectory, normalized.id);
  const replaced = existsSync(configPath);

  mkdirSync(directory, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  );

  return {
    ...normalized,
    configPath,
    replaced,
  };
}

export function installPersistedHostMcpStdioServer(options: {
  dataDirectory: string;
  workspaceDirectory: string;
  server: PersistedHostMcpStdioInstallOptions;
}): PersistedHostMcpInstallResult {
  return installPersistedHostMcpServer({
    ...options,
    server: {
      ...options.server,
      envSecretRefs: options.server.envSecretRefs ?? {},
      transport: "stdio",
    },
  });
}

export function installPersistedHostMcpHttpServer(options: {
  dataDirectory: string;
  workspaceDirectory: string;
  server: PersistedHostMcpHttpInstallOptions;
}): PersistedHostMcpInstallResult {
  const clientSecretRef =
    typeof options.server.oauth?.clientSecretRef === "string"
      ? options.server.oauth.clientSecretRef.trim() || null
      : null;
  const clientSecret =
    typeof options.server.oauth?.clientSecret === "string"
      ? options.server.oauth.clientSecret.trim() || null
      : null;
  const installed = installPersistedHostMcpServer({
    ...options,
    server: {
      ...options.server,
      headerSecretRefs: options.server.headerSecretRefs ?? {},
      oauth: {
        ...(options.server.oauth ?? createDefaultHostMcpOAuthConfig()),
        clientSecretRef,
        clientSecret: null,
      },
      transport: options.server.transport ?? "streamable-http",
    },
  });
  setPersistedHostMcpOAuthClientSecret(
    options.dataDirectory,
    clientSecretRef ?? installed.id,
    clientSecret,
  );
  return installed;
}

export function installPersistedHostMcpHttpWrapperServer(options: {
  dataDirectory: string;
  workspaceDirectory: string;
  server: PersistedHostMcpHttpWrapperInstallOptions;
}): PersistedHostMcpInstallResult {
  return installPersistedHostMcpServer({
    ...options,
    server: {
      ...options.server,
      auth: options.server.auth ?? {
        type: "none",
        secretRef: null,
        headerName: null,
      },
      transport: "http-wrapper",
    },
  });
}

export function uninstallPersistedHostMcpServer(options: {
  dataDirectory: string;
  serverId: string;
}): boolean {
  const serverId = normalizeServerId(options.serverId);
  const configPath = getHostMcpServerConfigPath(options.dataDirectory, serverId);
  if (!existsSync(configPath)) {
    return false;
  }

  try {
    const existing = normalizePersistedHostMcpServerRecord(
      JSON.parse(readFileSync(configPath, "utf8")) as unknown,
      {
        workspaceDirectory: process.cwd(),
      },
    );
    if (existing.transport === "stdio") {
      for (const secretRef of Object.values(existing.envSecretRefs)) {
        deletePersistedHostSecret(options.dataDirectory, secretRef);
      }
    } else if (existing.transport === "streamable-http" || existing.transport === "sse") {
      for (const secretRef of Object.values(existing.headerSecretRefs)) {
        deletePersistedHostSecret(options.dataDirectory, secretRef);
      }
      if (existing.oauth?.clientSecretRef) {
        setPersistedHostMcpOAuthClientSecret(
          options.dataDirectory,
          existing.oauth.clientSecretRef,
          null,
        );
      }
    }
  } catch {
    // Keep uninstall best-effort even if the persisted config can no longer be parsed.
  }

  rmSync(configPath, { force: true });
  clearPersistedHostMcpOAuthState(options.dataDirectory, serverId);
  return true;
}

export function createPersistedHostMcpServerRegistration(
  server: PersistedHostMcpServerRecord,
  options: {
    dataDirectory: string;
    oauthManager?: HostMcpOAuthManager | null;
  },
): HostMcpServerRegistration {
  if (server.transport === "stdio") {
    return {
      id: server.id,
      name: server.name ?? server.id,
      version: server.version ?? null,
      description: null,
      pluginId: null,
      source: "host",
      createServer: () =>
        createStdioProxyHostMcpServer(
          {
            command: server.command,
            args: server.args,
            cwd: server.cwd ?? undefined,
            env: {
              ...process.env,
              ...server.env,
              ...resolvePersistedSecretRefs(
                options.dataDirectory,
                server.envSecretRefs,
                `Host MCP stdio server ${server.id} env`,
              ),
            },
            stderr: "pipe",
          },
          {
            name: server.name ?? server.id,
            version: server.version ?? "1.0.0",
          },
        ),
    };
  }

  if (server.transport === "http-wrapper") {
    return {
      id: server.id,
      name: server.name ?? server.id,
      version: server.version ?? null,
      description: null,
      pluginId: null,
      source: "host",
      createServer: () =>
        createHttpWrapperHostMcpServer({
          auth: server.auth,
          baseUrl: server.baseUrl,
          dataDirectory: options.dataDirectory,
          id: server.id,
          name: server.name,
          version: server.version,
        }),
    };
  }

  const hydratedOauth =
    server.oauth === null
      ? null
      : {
          ...server.oauth,
          clientSecret: getPersistedHostMcpOAuthClientSecret(
            options.dataDirectory,
            server.oauth.clientSecretRef ?? server.id,
          ),
        };

  return {
    id: server.id,
    name: server.name ?? server.id,
    version: server.version ?? null,
    description: null,
    pluginId: null,
    source: "host",
    createServer: () =>
      createRemoteProxyHostMcpServer(
        {
          dataDirectory: options.dataDirectory,
          headers: {
            ...server.headers,
            ...resolvePersistedSecretRefs(
              options.dataDirectory,
              server.headerSecretRefs,
              `Host MCP remote server ${server.id} header`,
            ),
          },
          oauth: hydratedOauth,
          oauthManager: options.oauthManager ?? null,
          serverId: server.id,
          transport: server.transport,
          url: server.url,
        },
        {
          name: server.name ?? server.id,
          version: server.version ?? "1.0.0",
        },
      ),
  };
}
