import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type JSONRPCMessage,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

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
  const server = new Server(
    {
      name: serverInfo.name?.trim() || "acon-host-stdio-proxy",
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
    await startPromise;
    return await client.listTools(request.params);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    await startPromise;
    return await client.callTool(request.params);
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
