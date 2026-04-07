#!/usr/bin/env node

import { rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:net";

const socketPath = process.env.ACON_HOST_RPC_SOCKET?.trim() || "/data/host-rpc/bridge.sock";

/** @typedef {{ type: "ready"; protocolVersion: number; socketPath: string } | { type: "request"; id: string; method: string; params?: unknown } | { type: "response"; id: string; result?: unknown; error?: { code?: string; message: string; details?: unknown } }} BridgeMessage */

/** @type {Map<string, import("node:net").Socket>} */
const pendingSockets = new Map();
/** @type {Set<import("node:net").Socket>} */
const openSockets = new Set();

function writeBridgeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function cleanupSocketFile() {
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // Best effort only.
  }
}

function writeClientResponse(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
  socket.end();
}

function closeAllSockets() {
  for (const socket of openSockets) {
    try {
      socket.destroy();
    } catch {
      // Ignore cleanup failures.
    }
  }
  openSockets.clear();
  pendingSockets.clear();
}

cleanupSocketFile();
mkdirSync(dirname(socketPath), { recursive: true });

const server = createServer((socket) => {
  openSockets.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";

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
      } catch {
        writeClientResponse(socket, {
          error: {
            code: "INVALID_JSON",
            message: "Container RPC request must be valid JSON.",
          },
        });
        continue;
      }

      const id = typeof message?.id === "string" ? message.id : null;
      const method = typeof message?.method === "string" ? message.method : null;
      if (!id || !method) {
        writeClientResponse(socket, {
          id,
          error: {
            code: "INVALID_REQUEST",
            message: "Container RPC request must include string id and method fields.",
          },
        });
        continue;
      }

      pendingSockets.set(id, socket);
      writeBridgeMessage({
        type: "request",
        id,
        method,
        params: message.params,
      });
    }
  });

  socket.on("close", () => {
    openSockets.delete(socket);
    for (const [id, pendingSocket] of pendingSockets.entries()) {
      if (pendingSocket === socket) {
        pendingSockets.delete(id);
      }
    }
  });

  socket.on("error", () => {
    socket.destroy();
  });
});

server.listen(socketPath, () => {
  writeBridgeMessage({
    type: "ready",
    protocolVersion: 1,
    socketPath,
  });
});

process.stdin.setEncoding("utf8");
let hostBuffer = "";

process.stdin.on("data", (chunk) => {
  hostBuffer += chunk;

  while (true) {
    const newlineIndex = hostBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = hostBuffer.slice(0, newlineIndex).trim();
    hostBuffer = hostBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message?.type !== "response" || typeof message.id !== "string") {
      continue;
    }

    const socket = pendingSockets.get(message.id);
    if (!socket) {
      continue;
    }

    pendingSockets.delete(message.id);
    writeClientResponse(socket, {
      id: message.id,
      ...(Object.prototype.hasOwnProperty.call(message, "result")
        ? { result: message.result }
        : {}),
      ...(message.error ? { error: message.error } : {}),
    });
  }
});

function shutdown() {
  closeAllSockets();
  server.close(() => {
    cleanupSocketFile();
    process.exit(0);
  });
}

process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
