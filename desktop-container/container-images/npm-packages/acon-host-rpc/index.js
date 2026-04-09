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
const PROMPTS_LIST_REQUEST_ID = 4;
const PROMPTS_GET_REQUEST_ID = 5;
const RESOURCES_LIST_REQUEST_ID = 6;
const RESOURCES_READ_REQUEST_ID = 7;
const RESOURCE_TEMPLATES_LIST_REQUEST_ID = 8;

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

  async withMcpSession(serverId, callback, options = {}) {
    return await this.#withManagedMcpSession(serverId, options, async (sessionId) => {
      const session = Object.freeze({
        serverId,
        listTools: async () => await this.#listMcpToolsInSession(serverId, sessionId),
        callTool: async (toolName, toolArguments = {}) =>
          await this.#callMcpToolInSession(
            serverId,
            sessionId,
            toolName,
            toolArguments,
          ),
        listPrompts: async () =>
          await this.#listMcpPromptsInSession(serverId, sessionId),
        getPrompt: async (promptName, promptArguments = undefined) =>
          await this.#getMcpPromptInSession(
            serverId,
            sessionId,
            promptName,
            promptArguments,
          ),
        listResources: async () =>
          await this.#listMcpResourcesInSession(serverId, sessionId),
        listResourceTemplates: async () =>
          await this.#listMcpResourceTemplatesInSession(serverId, sessionId),
        readResource: async (uri) =>
          await this.#readMcpResourceInSession(serverId, sessionId, uri),
      });

      return await callback(session);
    });
  }

  async listMcpTools(serverId, options = {}) {
    const result = await this.#sendManagedMcpRequest(
      serverId,
      {
        jsonrpc: "2.0",
        id: TOOLS_LIST_REQUEST_ID,
        method: "tools/list",
        params: {},
      },
      options,
      {
        code: "MCP_TOOLS_LIST_FAILED",
        method: "tools/list",
      },
    );

    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callMcpTool(serverId, toolName, toolArguments = {}, options = {}) {
    const result = await this.#sendManagedMcpRequest(
      serverId,
      {
        jsonrpc: "2.0",
        id: TOOLS_CALL_REQUEST_ID,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArguments,
        },
      },
      options,
      {
        code: "MCP_TOOL_CALL_FAILED",
        method: "tools/call",
      },
    );

    return result ?? null;
  }

  async #listMcpToolsInSession(serverId, sessionId) {
    const result = await this.#sendSessionMcpRequest(
      serverId,
      sessionId,
      {
        jsonrpc: "2.0",
        id: TOOLS_LIST_REQUEST_ID,
        method: "tools/list",
        params: {},
      },
      {
        code: "MCP_TOOLS_LIST_FAILED",
        method: "tools/list",
      },
    );

    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async #callMcpToolInSession(serverId, sessionId, toolName, toolArguments = {}) {
    return await this.#sendSessionMcpRequest(
      serverId,
      sessionId,
      {
        jsonrpc: "2.0",
        id: TOOLS_CALL_REQUEST_ID,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArguments,
        },
      },
      {
        code: "MCP_TOOL_CALL_FAILED",
        method: "tools/call",
      },
    );
  }

  async listMcpPrompts(serverId, options = {}) {
    const result = await this.#sendManagedMcpRequest(
      serverId,
      {
        jsonrpc: "2.0",
        id: PROMPTS_LIST_REQUEST_ID,
        method: "prompts/list",
        params: {},
      },
      options,
      {
        code: "MCP_PROMPTS_LIST_FAILED",
        method: "prompts/list",
      },
    );

    return Array.isArray(result?.prompts) ? result.prompts : [];
  }

  async #listMcpPromptsInSession(serverId, sessionId) {
    const result = await this.#sendSessionMcpRequest(
      serverId,
      sessionId,
      {
        jsonrpc: "2.0",
        id: PROMPTS_LIST_REQUEST_ID,
        method: "prompts/list",
        params: {},
      },
      {
        code: "MCP_PROMPTS_LIST_FAILED",
        method: "prompts/list",
      },
    );

    return Array.isArray(result?.prompts) ? result.prompts : [];
  }

  async getMcpPrompt(serverId, promptName, promptArguments = undefined, options = {}) {
    const result = await this.#sendManagedMcpRequest(
      serverId,
      {
        jsonrpc: "2.0",
        id: PROMPTS_GET_REQUEST_ID,
        method: "prompts/get",
        params:
          promptArguments && Object.keys(promptArguments).length > 0
            ? {
                name: promptName,
                arguments: promptArguments,
              }
            : {
                name: promptName,
              },
      },
      options,
      {
        code: "MCP_PROMPT_GET_FAILED",
        method: "prompts/get",
      },
    );

    return result ?? null;
  }

  async #getMcpPromptInSession(
    serverId,
    sessionId,
    promptName,
    promptArguments = undefined,
  ) {
    return await this.#sendSessionMcpRequest(
      serverId,
      sessionId,
      {
        jsonrpc: "2.0",
        id: PROMPTS_GET_REQUEST_ID,
        method: "prompts/get",
        params:
          promptArguments && Object.keys(promptArguments).length > 0
            ? {
                name: promptName,
                arguments: promptArguments,
              }
            : {
                name: promptName,
              },
      },
      {
        code: "MCP_PROMPT_GET_FAILED",
        method: "prompts/get",
      },
    );
  }

  async listMcpResources(serverId, options = {}) {
    const result = await this.#sendManagedMcpRequest(
      serverId,
      {
        jsonrpc: "2.0",
        id: RESOURCES_LIST_REQUEST_ID,
        method: "resources/list",
        params: {},
      },
      options,
      {
        code: "MCP_RESOURCES_LIST_FAILED",
        method: "resources/list",
      },
    );

    return Array.isArray(result?.resources) ? result.resources : [];
  }

  async #listMcpResourcesInSession(serverId, sessionId) {
    const result = await this.#sendSessionMcpRequest(
      serverId,
      sessionId,
      {
        jsonrpc: "2.0",
        id: RESOURCES_LIST_REQUEST_ID,
        method: "resources/list",
        params: {},
      },
      {
        code: "MCP_RESOURCES_LIST_FAILED",
        method: "resources/list",
      },
    );

    return Array.isArray(result?.resources) ? result.resources : [];
  }

  async listMcpResourceTemplates(serverId, options = {}) {
    const result = await this.#sendManagedMcpRequest(
      serverId,
      {
        jsonrpc: "2.0",
        id: RESOURCE_TEMPLATES_LIST_REQUEST_ID,
        method: "resources/templates/list",
        params: {},
      },
      options,
      {
        code: "MCP_RESOURCE_TEMPLATES_LIST_FAILED",
        method: "resources/templates/list",
      },
    );

    return Array.isArray(result?.resourceTemplates) ? result.resourceTemplates : [];
  }

  async #listMcpResourceTemplatesInSession(serverId, sessionId) {
    const result = await this.#sendSessionMcpRequest(
      serverId,
      sessionId,
      {
        jsonrpc: "2.0",
        id: RESOURCE_TEMPLATES_LIST_REQUEST_ID,
        method: "resources/templates/list",
        params: {},
      },
      {
        code: "MCP_RESOURCE_TEMPLATES_LIST_FAILED",
        method: "resources/templates/list",
      },
    );

    return Array.isArray(result?.resourceTemplates) ? result.resourceTemplates : [];
  }

  async readMcpResource(serverId, uri, options = {}) {
    const result = await this.#sendManagedMcpRequest(
      serverId,
      {
        jsonrpc: "2.0",
        id: RESOURCES_READ_REQUEST_ID,
        method: "resources/read",
        params: {
          uri,
        },
      },
      options,
      {
        code: "MCP_RESOURCE_READ_FAILED",
        method: "resources/read",
      },
    );

    return result ?? null;
  }

  async #readMcpResourceInSession(serverId, sessionId, uri) {
    return await this.#sendSessionMcpRequest(
      serverId,
      sessionId,
      {
        jsonrpc: "2.0",
        id: RESOURCES_READ_REQUEST_ID,
        method: "resources/read",
        params: {
          uri,
        },
      },
      {
        code: "MCP_RESOURCE_READ_FAILED",
        method: "resources/read",
      },
    );
  }

  async #dispatchMcpRequest(serverId, sessionId, message) {
    const response = await this.request("mcp.request", {
      serverId,
      sessionId,
      message,
    });
    return Array.isArray(response?.messages) ? response.messages : [];
  }

  async #closeMcpSession(serverId, sessionId) {
    if (!serverId || !sessionId) {
      return;
    }

    try {
      await this.request("mcp.close", {
        serverId,
        sessionId,
      });
    } catch {
      // Best effort only.
    }
  }

  async #withManagedMcpSession(serverId, options = {}, callback) {
    const managedSessionId = randomUUID();

    try {
      await this.#dispatchMcpRequest(serverId, managedSessionId, {
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
      await this.#dispatchMcpRequest(serverId, managedSessionId, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      return await callback(managedSessionId);
    } finally {
      await this.#closeMcpSession(serverId, managedSessionId);
    }
  }

  async #sendManagedMcpRequest(serverId, message, options, errorOptions) {
    return await this.#withManagedMcpSession(serverId, options, async (sessionId) => {
      return await this.#sendSessionMcpRequest(
        serverId,
        sessionId,
        message,
        errorOptions,
      );
    });
  }

  async #sendSessionMcpRequest(serverId, sessionId, message, errorOptions) {
    const messages = await this.#dispatchMcpRequest(serverId, sessionId, message);
    const errorMessage = getJsonRpcErrorMessage(messages, message.id);
    if (errorMessage) {
      throw new HostRpcError(errorMessage, errorOptions);
    }

    const resultMessage = getJsonRpcResultMessage(messages, message.id);
    return resultMessage?.result ?? null;
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
