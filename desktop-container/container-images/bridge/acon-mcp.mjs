#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const socketPath =
  process.env.ACON_HOST_RPC_SOCKET?.trim() || "/data/host-rpc/bridge.sock";
const timeoutMs =
  Number.parseInt(process.env.ACON_HOST_RPC_TIMEOUT_MS ?? "", 10) || 30_000;
const args = process.argv.slice(2);

function printHelp(exitCode = 0) {
  const output = [
    "Expose host MCP servers inside the container.",
    "",
    "Usage:",
    "  acon-mcp <server-id>",
    "  acon-mcp servers [--json]",
    "  acon-mcp tools <server-id> [--json]",
    "  acon-mcp --help",
    "",
    "Modes:",
    "  <server-id>        Expose the named host MCP server over stdio.",
    "  servers            List host MCP servers registered in the host app.",
    "  tools <server-id>  List tools exposed by that server.",
    "",
    "Discovery:",
    "  1. Run `acon-mcp servers` to discover available host MCP servers.",
    "  2. Run `acon-mcp tools <server-id>` to inspect the tools for one server.",
    "  3. Run `acon-mcp <server-id>` to expose that server over stdio.",
    "",
    "Examples:",
    "  acon-mcp integration-host-tools",
    "  acon-mcp servers",
    "  acon-mcp servers --json",
    "  acon-mcp tools integration-host-tools",
    "  acon-mcp tools integration-host-tools --json",
    "",
    "Environment:",
    "  ACON_HOST_RPC_SOCKET      Override the guest bridge socket path.",
    "  ACON_HOST_RPC_TIMEOUT_MS  Override the bridge request timeout.",
    "",
  ].join("\n");
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(
    output,
  );
  process.exit(exitCode);
}

function getPositionalArgs(argv) {
  return argv.filter((value) => !value.startsWith("--"));
}

const positionalArgs = getPositionalArgs(args);
const jsonOutput = args.includes("--json");
const firstArg = positionalArgs[0];
const helpRequested =
  firstArg === "help" || args.includes("--help") || args.includes("-h");

if (helpRequested || !firstArg) {
  printHelp(helpRequested ? 0 : 1);
}

let stdinClosed = false;
let shuttingDown = false;
let buffer = "";
let requestQueue = Promise.resolve();
let stdioSessionId = null;

function writeJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toInternalError(message, id = null) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message,
    },
  };
}

function sendBridgeRequest(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);

    let responseBuffer = "";
    let settled = false;

    function finish(error, result) {
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
    }

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
            error instanceof Error
              ? error
              : new Error("acon-mcp received invalid JSON from the bridge."),
          );
          return;
        }

        if (message?.id !== requestId) {
          continue;
        }

        if (message.error) {
          finish(
            new Error(
              typeof message.error.message === "string"
                ? message.error.message
                : "Host bridge returned an unknown error.",
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
        new Error(`acon-mcp timed out after ${timeoutMs}ms waiting for ${method}.`),
      );
    });

    socket.on("close", () => {
      if (!settled) {
        finish(
          new Error(
            `acon-mcp bridge connection closed before ${method} completed.`,
          ),
        );
      }
    });

    socket.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function dispatchMcpMessage(serverId, sessionId, message) {
  const response = await sendBridgeRequest("mcp.request", {
    serverId,
    sessionId,
    message,
  });
  return Array.isArray(response?.messages) ? response.messages : [];
}

async function closeMcpSession(serverId, sessionId) {
  if (!serverId || !sessionId) {
    return;
  }

  try {
    await sendBridgeRequest("mcp.close", {
      serverId,
      sessionId,
    });
  } catch {
    // Best effort only.
  }
}

async function listServers() {
  const servers = await sendBridgeRequest("mcp.list_servers", {});
  const records = Array.isArray(servers) ? servers : [];
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }

  if (records.length === 0) {
    process.stdout.write("No host MCP servers are registered.\n");
    return;
  }

  for (const record of records) {
    if (record && typeof record.id === "string") {
      process.stdout.write(`${record.id}\n`);
    }
  }
}

async function listTools(serverId) {
  const sessionId = randomUUID();
  try {
    await dispatchMcpMessage(serverId, sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "acon-mcp",
          version: "1.0.0",
        },
      },
    });
    await dispatchMcpMessage(serverId, sessionId, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const messages = await dispatchMcpMessage(serverId, sessionId, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const resultMessage = messages.find(
      (message) =>
        message &&
        typeof message === "object" &&
        "id" in message &&
        message.id === 2 &&
        "result" in message,
    );
    const tools = Array.isArray(resultMessage?.result?.tools)
      ? resultMessage.result.tools
      : [];

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      return;
    }

    if (tools.length === 0) {
      process.stdout.write(`No tools are registered for ${serverId}.\n`);
      return;
    }

    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string") {
        continue;
      }
      const description =
        typeof tool.description === "string" && tool.description.trim()
          ? ` - ${tool.description.trim()}`
          : "";
      process.stdout.write(`${tool.name}${description}\n`);
    }
  } finally {
    await closeMcpSession(serverId, sessionId);
  }
}

async function forwardJsonRpcMessage(serverId, message) {
  const id =
    message && typeof message === "object" && "id" in message ? message.id : null;

  try {
    if (!stdioSessionId) {
      stdioSessionId = randomUUID();
    }
    const messages = await dispatchMcpMessage(serverId, stdioSessionId, message);
    for (const outgoingMessage of messages) {
      writeJsonRpc(outgoingMessage);
    }
  } catch (error) {
    if (id !== null && id !== undefined) {
      writeJsonRpc(
        toInternalError(
          error instanceof Error ? error.message : String(error),
          id,
        ),
      );
      return;
    }

    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function scheduleShutdown(exitCode = 0) {
  if (!stdinClosed) {
    return;
  }

  requestQueue = requestQueue.finally(async () => {
    shuttingDown = true;
    await closeMcpSession(firstArg, stdioSessionId);
    process.exit(exitCode);
  });
}

async function run() {
  if (firstArg === "servers") {
    await listServers();
    return;
  }

  if (firstArg === "tools") {
    const serverId = positionalArgs[1];
    if (!serverId) {
      throw new Error("acon-mcp tools requires a server id.");
    }
    await listTools(serverId);
    return;
  }

  const serverId = firstArg;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        writeJsonRpc({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        });
        continue;
      }

      requestQueue = requestQueue.then(() => forwardJsonRpcMessage(serverId, message));
    }
  });

  process.stdin.on("end", () => {
    stdinClosed = true;
    scheduleShutdown(0);
  });
  process.stdin.on("error", () => {
    stdinClosed = true;
    scheduleShutdown(0);
  });
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

process.on("SIGTERM", () => {
  stdinClosed = true;
  if (!shuttingDown) {
    scheduleShutdown(0);
  }
});
process.on("SIGINT", () => {
  stdinClosed = true;
  if (!shuttingDown) {
    scheduleShutdown(0);
  }
});
