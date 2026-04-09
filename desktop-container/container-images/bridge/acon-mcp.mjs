#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const bundledNodeModulesRoot =
  process.env.ACON_BUNDLED_NODE_MODULES_ROOT?.trim() ||
  "/opt/acon/npm-global/node_modules";

async function loadHostRpcModule() {
  const bundledEntryPath = resolve(
    bundledNodeModulesRoot,
    "@acon/host-rpc/index.js",
  );

  try {
    return await import(pathToFileURL(bundledEntryPath).href);
  } catch (bundledError) {
    try {
      const resolvedPackageEntry = require.resolve("@acon/host-rpc");
      return await import(pathToFileURL(resolvedPackageEntry).href);
    } catch {
      const detail =
        bundledError instanceof Error ? bundledError.message : String(bundledError);
      throw new Error(
        `Unable to load @acon/host-rpc from ${bundledEntryPath} or the default module resolution path. ${detail}`,
      );
    }
  }
}

const parsedArgs = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    help: {
      short: "h",
      type: "boolean",
    },
    json: {
      type: "boolean",
    },
  },
});
const positionalArgs = parsedArgs.positionals;
const {
  createHostRpcClient,
  DEFAULT_MCP_CLIENT_VERSION,
} = await loadHostRpcModule();
const client = createHostRpcClient();

function printHelp(mode = "root", exitCode = 0) {
  const outputByMode = {
    root: [
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
    ],
    servers: [
      "List host MCP servers registered in the host app.",
      "",
      "Usage:",
      "  acon-mcp servers [--json]",
      "",
      "Options:",
      "  --json  Print the full server records as JSON.",
      "",
    ],
    tools: [
      "List tools exposed by one host MCP server.",
      "",
      "Usage:",
      "  acon-mcp tools <server-id> [--json]",
      "",
      "Arguments:",
      "  <server-id>  The registered host MCP server id.",
      "",
      "Options:",
      "  --json  Print the full tool records as JSON.",
      "",
    ],
  };
  const output = (outputByMode[mode] || outputByMode.root).join("\n");
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(output);
  process.exit(exitCode);
}

const jsonOutput = parsedArgs.values.json ?? false;
const firstArg = positionalArgs[0];
const secondArg = positionalArgs[1];
const helpRequested = firstArg === "help" || parsedArgs.values.help === true;
const helpMode =
  firstArg === "help"
    ? secondArg || "root"
    : firstArg === "servers" || firstArg === "tools"
      ? firstArg
      : "root";

if (helpRequested || !firstArg) {
  printHelp(helpMode, helpRequested ? 0 : 1);
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

async function dispatchMcpMessage(serverId, sessionId, message) {
  return await client.mcpRequest(serverId, sessionId, message);
}

async function closeMcpSession(serverId, sessionId) {
  if (!serverId || !sessionId) {
    return;
  }

  try {
    await client.closeMcpSession(serverId, sessionId);
  } catch {
    // Best effort only.
  }
}

async function listServers() {
  const records = await client.listMcpServers();
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
  const tools = await client.listMcpTools(serverId, {
    clientInfo: {
      name: "acon-mcp",
      version: DEFAULT_MCP_CLIENT_VERSION,
    },
  });

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
}

function queueIncomingMessage(serverId, line) {
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
    return;
  }

  requestQueue = requestQueue.then(() => forwardJsonRpcMessage(serverId, message));
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

async function closeSessionAndExit(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await closeMcpSession(firstArg, stdioSessionId);
  process.exit(exitCode);
}

function scheduleShutdown(exitCode = 0) {
  if (!stdinClosed || shuttingDown) {
    return;
  }

  requestQueue = requestQueue.finally(async () => {
    await closeSessionAndExit(exitCode);
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
      queueIncomingMessage(serverId, line);
    }
  });

  process.stdin.on("end", () => {
    const trailingLine = buffer.trim();
    if (trailingLine) {
      queueIncomingMessage(serverId, trailingLine);
      buffer = "";
    }
    stdinClosed = true;
    scheduleShutdown(0);
  });
  process.stdin.on("error", () => {
    stdinClosed = true;
    scheduleShutdown(0);
  });
}

run().catch(async (error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  await closeMcpSession(firstArg, stdioSessionId);
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
