#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const imageName = process.env.IMAGE_NAME || "acon-codex-stdio-poc:0.1";
const workspaceDir = resolve(
  process.env.WORKSPACE_DIR || resolve(__dirname, "../.."),
);
const dataDir = resolve(
  process.env.DATA_DIR || resolve(__dirname, ".local/data"),
);
const containerName =
  process.env.CONTAINER_NAME || `acon-codex-stdio-poc-${Date.now()}`;
const model = process.env.MODEL || "gpt-5.4-mini";
const prompt =
  process.env.PROMPT || "Reply with exactly POC OK and nothing else.";
const authDir = resolve(process.env.HOME || "", ".codex");

mkdirSync(dataDir, { recursive: true });

const args = [
  "run",
  "--rm",
  "--interactive",
  "--name",
  containerName,
  "--volume",
  `${dataDir}:/data`,
  "--volume",
  `${workspaceDir}:/workspace`,
  "--workdir",
  "/workspace",
];

if (process.env.OPENAI_API_KEY) {
  args.push("--env", `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
}

if (existsSync(authDir)) {
  args.push(
    "--mount",
    `type=bind,source=${authDir},target=/seed-codex,readonly`,
  );
}

args.push(imageName);

const child = spawn("container", args, {
  cwd: workspaceDir,
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let buffer = "";
let threadId = null;
let assistantText = "";
let finished = false;
const pending = new Map();
const timeout = setTimeout(() => {
  fail("Timed out waiting for turn completion.");
}, 90_000);

function send(method, params = undefined) {
  const id = nextId++;
  const message = { id, method };
  if (params !== undefined) {
    message.params = params;
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

function notify(method, params = undefined) {
  const message = { method };
  if (params !== undefined) {
    message.params = params;
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function fail(message, detail = undefined) {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  console.error(message);
  if (detail !== undefined) {
    console.error(
      typeof detail === "string" ? detail : JSON.stringify(detail, null, 2),
    );
  }
  child.kill("SIGTERM");
  process.exitCode = 1;
}

function complete() {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(timeout);
  console.log(JSON.stringify({ ok: true, assistantText, threadId }, null, 2));
  child.kill("SIGTERM");
}

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
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
      fail("Container returned non-JSON output.", line);
      return;
    }

    if (Object.hasOwn(message, "id")) {
      const request = pending.get(message.id);
      if (!request) {
        continue;
      }
      pending.delete(message.id);
      if (message.error) {
        request.reject(message.error);
      } else {
        request.resolve(message.result);
      }
      continue;
    }

    if (message.method === "item/agentMessage/delta") {
      assistantText += message.params?.delta || "";
      continue;
    }

    if (
      message.method === "item/completed" &&
      message.params?.item?.type === "agentMessage" &&
      typeof message.params.item.text === "string"
    ) {
      assistantText = message.params.item.text;
      continue;
    }

    if (message.method === "turn/completed") {
      complete();
      return;
    }
  }
});

child.on("exit", (code, signal) => {
  if (!finished && code !== 0) {
    fail(`container exited before the smoke test completed (code=${code}, signal=${signal})`);
  }
});

try {
  const initResult = await send("initialize", {
    clientInfo: {
      name: "apple-container-codex-stdio-poc",
      version: "0.1.0",
    },
  });
  console.error(`initialized ${initResult.platformOs}/${initResult.platformFamily}`);

  notify("initialized");

  const threadResult = await send("thread/start", {
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model,
  });
  threadId = threadResult.thread.id;
  console.error(`thread started ${threadId}`);

  await send("turn/start", {
    threadId,
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: prompt }],
  });
} catch (error) {
  fail("Smoke test request failed.", error);
}
