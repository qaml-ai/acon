import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type JSONRPCMessage,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  HostMcpOAuthManager,
  PersistedHostMcpOAuthProvider,
  type HostMcpOAuthConfig,
} from "./host-mcp-oauth";

export interface HostMcpSessionServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface HostMcpServerRegistration {
  id: string;
  createServer: () => HostMcpSessionServer;
}

export interface HostMcpServerSummary {
  id: string;
}

export interface HostMcpBridgeRequest {
  serverId: string;
  sessionId: string;
  message: JSONRPCMessage;
}

interface HostMcpSessionState {
  server: HostMcpSessionServer;
  transport: HostMcpSessionTransport;
  dispatchQueue: Promise<unknown>;
}

export interface HostMcpProxyServerInfo {
  name?: string;
  version?: string;
}

export type HostMcpRemoteTransport = "streamable-http" | "sse";

export interface HostMcpRemoteProxyServerParameters {
  authTimeoutMs?: number;
  dataDirectory?: string;
  headers?: Record<string, string>;
  oauth?: HostMcpOAuthConfig | null;
  oauthManager?: HostMcpOAuthManager | null;
  transport?: HostMcpRemoteTransport;
  url: string | URL;
}

interface HostMcpClientTransport extends Transport {
  close(): Promise<void>;
  finishAuth?(authorizationCode: string): Promise<void>;
}

function createToolProxyServer(
  serverInfo: HostMcpProxyServerInfo,
  start: () => Promise<Client>,
): Server {
  const server = new Server(
    {
      name: serverInfo.name?.trim() || "acon-host-proxy",
      version: serverInfo.version?.trim() || "1.0.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const client = await start();
    return await client.listTools(request.params);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const client = await start();
    return await client.callTool(request.params);
  });

  return server;
}

export function createStdioProxyHostMcpServer(
  serverParameters: StdioServerParameters,
  serverInfo: HostMcpProxyServerInfo = {},
): HostMcpSessionServer {
  const client = new Client({
    name: serverInfo.name?.trim() || "acon-host-stdio-proxy-client",
    version: serverInfo.version?.trim() || "1.0.0",
  });
  const clientTransport = new StdioClientTransport(serverParameters);
  const startPromise = client.connect(clientTransport);
  const server = createToolProxyServer(serverInfo, async () => {
    await startPromise;
    return client;
  });

  return {
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
    },
    async close(): Promise<void> {
      await Promise.allSettled([server.close(), client.close(), clientTransport.close()]);
    },
  };
}

function createRemoteTransport(
  transport: HostMcpRemoteTransport,
  url: URL,
  options: {
    authProvider?: OAuthClientProvider;
    requestInit?: RequestInit;
  },
): HostMcpClientTransport {
  if (transport === "sse") {
    return new SSEClientTransport(url, options);
  }

  return new StreamableHTTPClientTransport(url, options);
}

async function connectRemoteClientWithOAuthRetry(options: {
  authTimeoutMs?: number;
  authProvider?: PersistedHostMcpOAuthProvider;
  transport: HostMcpClientTransport;
  transportFactory: () => HostMcpClientTransport;
  client: Client;
}): Promise<HostMcpClientTransport> {
  try {
    await options.client.connect(options.transport);
    return options.transport;
  } catch (error) {
    if (
      !(error instanceof UnauthorizedError) ||
      !options.authProvider ||
      typeof options.transport.finishAuth !== "function"
    ) {
      await Promise.allSettled([options.transport.close()]);
      throw error;
    }

    const authorizationCode =
      await options.authProvider.waitForAuthorizationCode(options.authTimeoutMs);
    await options.transport.finishAuth(authorizationCode);
    await Promise.allSettled([options.transport.close()]);

    const retryTransport = options.transportFactory();
    try {
      await options.client.connect(retryTransport);
      return retryTransport;
    } catch (retryError) {
      await Promise.allSettled([retryTransport.close()]);
      throw retryError;
    }
  }
}

async function connectRemoteProxyClient(options: {
  authTimeoutMs?: number;
  dataDirectory?: string;
  oauthManager?: HostMcpOAuthManager | null;
  oauth?: HostMcpOAuthConfig | null;
  requestInit?: RequestInit;
  serverId: string;
  serverInfo: HostMcpProxyServerInfo;
  transport: HostMcpRemoteTransport;
  url: URL;
}): Promise<{
  client: Client;
  transport: HostMcpClientTransport;
}> {
  if (options.oauth && (!options.oauthManager || !options.dataDirectory)) {
    throw new Error(
      `Remote host MCP server ${options.serverId} requires a host OAuth manager and data directory.`,
    );
  }

  const oauthProvider =
    options.oauth && options.oauthManager && options.dataDirectory
      ? new PersistedHostMcpOAuthProvider({
          dataDirectory: options.dataDirectory,
          manager: options.oauthManager,
          oauth: options.oauth,
          redirectUrl: await options.oauthManager.getRedirectUrl(options.serverId),
          serverId: options.serverId,
        })
      : null;

  const tryConnect = async (
    transportType: HostMcpRemoteTransport,
  ): Promise<{
    client: Client;
    transport: HostMcpClientTransport;
  }> => {
    const client = new Client({
      name:
        options.serverInfo.name?.trim() || `acon-host-${transportType}-proxy-client`,
      version: options.serverInfo.version?.trim() || "1.0.0",
    });
    try {
      const transportFactory = () =>
        createRemoteTransport(transportType, options.url, {
          authProvider: oauthProvider ?? undefined,
          requestInit: options.requestInit,
        });
      const transport = await connectRemoteClientWithOAuthRetry({
        authProvider: oauthProvider ?? undefined,
        authTimeoutMs: options.authTimeoutMs,
        client,
        transport: transportFactory(),
        transportFactory,
      });
      return {
        client,
        transport,
      };
    } catch (error) {
      await Promise.allSettled([client.close()]);
      throw error;
    }
  };

  if (options.transport === "sse") {
    return await tryConnect("sse");
  }

  try {
    return await tryConnect("streamable-http");
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    return await tryConnect("sse");
  }
}

export function createRemoteProxyHostMcpServer(
  parameters: HostMcpRemoteProxyServerParameters & {
    serverId: string;
  },
  serverInfo: HostMcpProxyServerInfo = {},
): HostMcpSessionServer {
  const url =
    parameters.url instanceof URL
      ? parameters.url
      : new URL(parameters.url);
  const requestInit =
    parameters.headers && Object.keys(parameters.headers).length > 0
      ? { headers: parameters.headers }
      : undefined;

  let client: Client | null = null;
  let clientTransport: HostMcpClientTransport | null = null;
  const startPromise = (async () => {
    const connection = await connectRemoteProxyClient({
      authTimeoutMs: parameters.authTimeoutMs,
      dataDirectory: parameters.dataDirectory,
      oauth: parameters.oauth,
      oauthManager: parameters.oauthManager,
      requestInit,
      serverId: parameters.serverId,
      serverInfo,
      transport: parameters.transport ?? "streamable-http",
      url,
    });
    client = connection.client;
    clientTransport = connection.transport;
    return connection.client;
  })();
  const server = createToolProxyServer(serverInfo, async () => {
    return await startPromise;
  });

  return {
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
    },
    async close(): Promise<void> {
      await Promise.allSettled([
        server.close(),
        client?.close() ?? Promise.resolve(),
        clientTransport?.close() ?? Promise.resolve(),
      ]);
    },
  };
}

function normalizeServerId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Host MCP server id must be a non-empty string.");
  }
  return normalized;
}

function getSessionKey(serverId: string, sessionId: string): string {
  return `${serverId}:${sessionId}`;
}

class HostMcpSessionTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sessionId: string;

  private activeExchange:
    | {
        requestId: string | number | null;
        messages: JSONRPCMessage[];
        resolve: (messages: JSONRPCMessage[]) => void;
        reject: (error: Error) => void;
      }
    | null = null;
  private closed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const activeExchange = this.activeExchange;
    this.activeExchange = null;
    if (activeExchange) {
      activeExchange.reject(
        new McpError(-32000, "Host MCP session transport closed."),
      );
    }
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const exchange = this.activeExchange;
    if (!exchange) {
      throw new Error("Host MCP transport has no active exchange.");
    }

    exchange.messages.push(message);
    if (
      exchange.requestId !== null &&
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id === exchange.requestId
    ) {
      queueMicrotask(() => {
        if (this.activeExchange !== exchange) {
          return;
        }
        this.activeExchange = null;
        exchange.resolve(exchange.messages.slice());
      });
    }
  }

  async dispatch(message: JSONRPCMessage): Promise<JSONRPCMessage[]> {
    if (this.closed) {
      throw new Error("Host MCP session transport is closed.");
    }
    if (this.activeExchange) {
      throw new Error("Host MCP session transport does not support concurrent dispatch.");
    }

    return await new Promise<JSONRPCMessage[]>((resolve, reject) => {
      const requestId = isJSONRPCRequest(message) ? message.id : null;
      const exchange = {
        requestId,
        messages: [] as JSONRPCMessage[],
        resolve,
        reject,
      };
      this.activeExchange = exchange;

      try {
        this.onmessage?.(message);
      } catch (error) {
        this.activeExchange = null;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (requestId === null) {
        queueMicrotask(() => {
          if (this.activeExchange !== exchange) {
            return;
          }
          this.activeExchange = null;
          resolve(exchange.messages.slice());
        });
      }
    });
  }
}

export class HostMcpRegistry {
  private readonly registrations = new Map<string, HostMcpServerRegistration>();
  private readonly sessions = new Map<string, HostMcpSessionState>();

  registerServer(registration: HostMcpServerRegistration): void {
    const serverId = normalizeServerId(registration.id);
    this.unregisterServer(serverId);
    this.registrations.set(serverId, {
      ...registration,
      id: serverId,
    });
  }

  unregisterServer(serverId: string): void {
    const normalizedServerId = normalizeServerId(serverId);
    this.registrations.delete(normalizedServerId);
    for (const [sessionKey] of this.sessions) {
      if (sessionKey.startsWith(`${normalizedServerId}:`)) {
        void this.closeSessionByKey(sessionKey);
      }
    }
  }

  listServers(): HostMcpServerSummary[] {
    return [...this.registrations.keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id }));
  }

  async dispatchRequest(
    request: HostMcpBridgeRequest,
  ): Promise<{ messages: JSONRPCMessage[] }> {
    if (!request || typeof request !== "object") {
      throw new Error("Host MCP bridge request must be an object.");
    }

    const serverId = normalizeServerId(request.serverId);
    const sessionId =
      typeof request.sessionId === "string" && request.sessionId.trim()
        ? request.sessionId.trim()
        : null;
    if (!sessionId) {
      throw new Error("Host MCP bridge request requires a non-empty sessionId.");
    }

    const session = await this.getOrCreateSession(serverId, sessionId);
    const runDispatch = async (): Promise<JSONRPCMessage[]> =>
      await session.transport.dispatch(request.message);
    const messages = await (session.dispatchQueue = session.dispatchQueue.then(
      runDispatch,
      runDispatch,
    ));
    return { messages };
  }

  async closeSession(serverId: string, sessionId: string): Promise<void> {
    const normalizedServerId = normalizeServerId(serverId);
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("Host MCP close requires a non-empty sessionId.");
    }

    await this.closeSessionByKey(
      getSessionKey(normalizedServerId, normalizedSessionId),
    );
  }

  dispose(): void {
    for (const [sessionKey] of this.sessions) {
      void this.closeSessionByKey(sessionKey);
    }
    this.registrations.clear();
  }

  private async getOrCreateSession(
    serverId: string,
    sessionId: string,
  ): Promise<HostMcpSessionState> {
    const existingSession = this.sessions.get(getSessionKey(serverId, sessionId));
    if (existingSession) {
      return existingSession;
    }

    const registration = this.registrations.get(serverId);
    if (!registration) {
      throw new Error(`Unknown host MCP server: ${serverId}.`);
    }

    const transport = new HostMcpSessionTransport(sessionId);
    const server = registration.createServer();
    await server.connect(transport);

    const session: HostMcpSessionState = {
      server,
      transport,
      dispatchQueue: Promise.resolve(),
    };
    this.sessions.set(getSessionKey(serverId, sessionId), session);
    return session;
  }

  private async closeSessionByKey(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionKey);
    await Promise.allSettled([session.server.close(), session.transport.close()]);
  }
}
