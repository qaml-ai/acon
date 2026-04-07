#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const socketPath = process.env.ACON_HOST_RPC_SOCKET?.trim() || "/data/host-rpc/bridge.sock";
const timeoutMs = Number.parseInt(process.env.ACON_HOST_RPC_TIMEOUT_MS ?? "", 10) || 30_000;
const [method, rawParams] = process.argv.slice(2);

if (!method || method === "--help" || method === "-h") {
  process.stderr.write(
    "Usage: acon-host-rpc <method> [json-params]\n\nExamples:\n  acon-host-rpc ping\n  acon-host-rpc fetch '{\"url\":\"http://127.0.0.1:3000/health\"}'\n",
  );
  process.exit(method ? 0 : 1);
}

let params = null;
if (typeof rawParams === "string") {
  try {
    params = JSON.parse(rawParams);
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : String(error)
      }\nInvalid JSON payload for acon-host-rpc params.\n`,
    );
    process.exit(1);
  }
}

const requestId = randomUUID();
const socket = createConnection(socketPath);
socket.setEncoding("utf8");
socket.setTimeout(timeoutMs);

let buffer = "";
let resolved = false;

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
    } catch (error) {
      process.stderr.write(
        `${
          error instanceof Error ? error.message : String(error)
        }\nacon-host-rpc received invalid JSON from the container bridge.\n`,
      );
      process.exit(1);
    }

    if (message?.id !== requestId) {
      continue;
    }

    resolved = true;
    if (message.error) {
      process.stderr.write(`${JSON.stringify(message.error, null, 2)}\n`);
      process.exit(1);
    }

    process.stdout.write(`${JSON.stringify(message.result ?? null, null, 2)}\n`);
    process.exit(0);
  }
});

socket.on("timeout", () => {
  process.stderr.write(
    `acon-host-rpc timed out after ${timeoutMs}ms waiting for a response.\n`,
  );
  socket.destroy();
  process.exit(1);
});

socket.on("close", () => {
  if (resolved) {
    return;
  }
  process.stderr.write(
    `acon-host-rpc connection closed before a response was received from ${socketPath}.\n`,
  );
  process.exit(1);
});

socket.on("error", (error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\nFailed to connect to acon-host-rpc bridge at ${socketPath}.\n`,
  );
  process.exit(1);
});
