import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

export const DEFAULT_HOST_RPC_SOCKET_PATH = "/data/host-rpc/bridge.sock";
export const DEFAULT_HOST_RPC_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
export const DEFAULT_MCP_CLIENT_VERSION = "0.1.0";
export const DEFAULT_MCP_CLIENT_INFO = Object.freeze({
  name: "@acon/host-rpc",
  version: DEFAULT_MCP_CLIENT_VERSION,
});

const INITIALIZE_REQUEST_ID = 1;
const TOOLS_LIST_REQUEST_ID = 2;
const TOOLS_CALL_REQUEST_ID = 3;

export class HostRpcError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HostRpcError";
    this.code = options.code ?? null;
    this.method = options.method ?? null;
  }
}

export function resolveHostRpcSocketPath(env = process.env) {
  const configuredSocketPath = env.ACON_HOST_RPC_SOCKET?.trim();
  return configuredSocketPath || DEFAULT_HOST_RPC_SOCKET_PATH;
}

export function resolveHostRpcTimeoutMs(env = process.env) {
  const configuredTimeoutMs = Number.parseInt(env.ACON_HOST_RPC_TIMEOUT_MS ?? "", 10);
  return configuredTimeoutMs > 0 ? configuredTimeoutMs : DEFAULT_HOST_RPC_TIMEOUT_MS;
}

export function createHostRpcClient(options = {}) {
  return new HostRpcClient(options);
}

export class HostRpcClient {
  constructor(options = {}) {
    this.socketPath = options.socketPath || resolveHostRpcSocketPath(options.env);
    this.timeoutMs = options.timeoutMs ?? resolveHostRpcTimeoutMs(options.env);
  }

  async request(method, params = {}) {
    const requestId = randomUUID();

    return await new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      socket.setEncoding("utf8");
      socket.setTimeout(this.timeoutMs);

      let responseBuffer = "";
      let settled = false;

      const finish = (error, result) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      };

      socket.on("connect", () => {
        socket.write(
          `${JSON.stringify({
            id: requestId,
            method,
            params,
          })}\n`,
        );
      });

      socket.on("data", (chunk) => {
        responseBuffer += chunk;

        while (true) {
          const newlineIndex = responseBuffer.indexOf("\n");
          if (newlineIndex === -1) {
            break;
          }

          const line = responseBuffer.slice(0, newlineIndex).trim();
          responseBuffer = responseBuffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }

          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            finish(
              new HostRpcError(
                error instanceof Error
                  ? error.message
                  : "The host bridge returned invalid JSON.",
                {
                  code: "INVALID_JSON",
                  method,
                },
              ),
            );
            return;
          }

          if (message?.id !== requestId) {
            continue;
          }

          if (message.error) {
            finish(
              new HostRpcError(
                typeof message.error.message === "string"
                  ? message.error.message
                  : "The host bridge returned an unknown error.",
                {
                  code:
                    typeof message.error.code === "string" ? message.error.code : null,
                  method,
                },
              ),
            );
            return;
          }

          finish(null, message.result ?? null);
          return;
        }
      });

      socket.on("timeout", () => {
        finish(
          new HostRpcError(
            `Host RPC request timed out after ${this.timeoutMs}ms waiting for ${method}.`,
            {
              code: "TIMEOUT",
              method,
            },
          ),
        );
      });

      socket.on("close", () => {
        if (!settled) {
          finish(
            new HostRpcError(
              `Host RPC connection closed before ${method} completed.`,
              {
                code: "CONNECTION_CLOSED",
                method,
              },
            ),
          );
        }
      });

      socket.on("error", (error) => {
        finish(
          new HostRpcError(error instanceof Error ? error.message : String(error), {
            code: "SOCKET_ERROR",
            method,
          }),
        );
      });
    });
  }

  async ping(params = {}) {
    return await this.request("ping", params);
  }

  async fetch(params) {
    return await this.request("fetch", params);
  }

  async listMcpServers() {
    const servers = await this.request("mcp.list_servers", {});
    return Array.isArray(servers) ? servers : [];
  }

  async mcpRequest(serverId, sessionId, message) {
    const response = await this.request("mcp.request", {
      serverId,
      sessionId,
      message,
    });
    return Array.isArray(response?.messages) ? response.messages : [];
  }

  async closeMcpSession(serverId, sessionId) {
    if (!serverId || !sessionId) {
      return { ok: true };
    }
    return await this.request("mcp.close", {
      serverId,
      sessionId,
    });
  }

  async #withManagedMcpSession(serverId, options = {}, callback) {
    const sessionId = options.sessionId?.trim();
    if (sessionId) {
      return await callback(sessionId);
    }

    const managedSessionId = randomUUID();

    try {
      await this.mcpRequest(serverId, managedSessionId, {
        jsonrpc: "2.0",
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          protocolVersion:
            options.protocolVersion || DEFAULT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            ...DEFAULT_MCP_CLIENT_INFO,
            ...(options.clientInfo || {}),
          },
        },
      });
      await this.mcpRequest(serverId, managedSessionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      return await callback(managedSessionId);
    } finally {
      try {
        await this.closeMcpSession(serverId, managedSessionId);
      } catch {
        // Best effort only.
      }
    }
  }

  async listMcpTools(serverId, options = {}) {
    return await this.#withManagedMcpSession(serverId, options, async (sessionId) => {
      const messages = await this.mcpRequest(serverId, sessionId, {
        jsonrpc: "2.0",
        id: TOOLS_LIST_REQUEST_ID,
        method: "tools/list",
        params: {},
      });
      const errorMessage = getJsonRpcErrorMessage(messages, TOOLS_LIST_REQUEST_ID);
      if (errorMessage) {
        throw new HostRpcError(errorMessage, {
          code: "MCP_TOOLS_LIST_FAILED",
          method: "tools/list",
        });
      }

      const resultMessage = getJsonRpcResultMessage(messages, TOOLS_LIST_REQUEST_ID);
      return Array.isArray(resultMessage?.result?.tools) ? resultMessage.result.tools : [];
    });
  }

  async callMcpTool(serverId, toolName, toolArguments = {}, options = {}) {
    return await this.#withManagedMcpSession(serverId, options, async (sessionId) => {
      const messages = await this.mcpRequest(serverId, sessionId, {
        jsonrpc: "2.0",
        id: TOOLS_CALL_REQUEST_ID,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArguments,
        },
      });
      const errorMessage = getJsonRpcErrorMessage(messages, TOOLS_CALL_REQUEST_ID);
      if (errorMessage) {
        throw new HostRpcError(errorMessage, {
          code: "MCP_TOOL_CALL_FAILED",
          method: "tools/call",
        });
      }

      const resultMessage = getJsonRpcResultMessage(messages, TOOLS_CALL_REQUEST_ID);
      return resultMessage?.result ?? null;
    });
  }
}

function getJsonRpcResultMessage(messages, requestId) {
  return messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      "id" in message &&
      message.id === requestId &&
      "result" in message,
  );
}

function getJsonRpcErrorMessage(messages, requestId) {
  const errorMessage = messages.find(
    (message) =>
      message &&
      typeof message === "object" &&
      "id" in message &&
      message.id === requestId &&
      "error" in message,
  );

  if (!errorMessage?.error) {
    return null;
  }

  return typeof errorMessage.error.message === "string"
    ? errorMessage.error.message
    : "The MCP server returned an unknown error.";
}
