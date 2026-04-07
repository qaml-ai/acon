#!/usr/bin/env node

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const imageName = process.env.IMAGE_NAME || "acon-acpx-claude-poc:0.1";
const workspaceDir = resolve(
  process.env.WORKSPACE_DIR || resolve(__dirname, "../.."),
);
const dataDir = resolve(
  process.env.DATA_DIR || resolve(__dirname, ".local/data"),
);
const seedClaudeJsonDir = resolve(__dirname, ".local/seed-claude-json");
const containerName =
  process.env.CONTAINER_NAME || `acon-acpx-claude-poc-${Date.now()}`;
const prompt =
  process.env.PROMPT || "Reply with exactly CLAUDE CONTAINER POC OK and nothing else.";
const claudeDir = resolve(process.env.HOME || "", ".claude");
const claudeJsonPath = resolve(process.env.HOME || "", ".claude.json");

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
];

if (process.env.ANTHROPIC_API_KEY) {
  args.push("--env", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
}

if (existsSync(claudeDir)) {
  args.push(
    "--mount",
    `type=bind,source=${claudeDir},target=/seed-claude,readonly`,
  );
}

if (existsSync(claudeJsonPath)) {
  mkdirSync(seedClaudeJsonDir, { recursive: true });
  cpSync(claudeJsonPath, resolve(seedClaudeJsonDir, ".claude.json"), {
    force: true,
  });
  args.push(
    "--mount",
    `type=bind,source=${seedClaudeJsonDir},target=/seed-claude-json,readonly`,
  );
}

args.push(imageName);

const child = spawn("container", args, {
  cwd: workspaceDir,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let assistantText = "";
let sessionId = null;
let stopReason = null;
let finished = false;

const timeout = setTimeout(() => {
  fail("Timed out waiting for ACPX Claude completion.");
}, 90_000);

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
  console.log(
    JSON.stringify({ ok: true, assistantText, sessionId, stopReason }, null, 2),
  );
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
    } catch {
      fail("Container returned non-JSON output.", line);
      return;
    }

    if (message.error) {
      fail("ACPX Claude returned an error.", message);
      return;
    }

    if (
      message.id === 1 &&
      message.result &&
      typeof message.result.sessionId === "string"
    ) {
      sessionId = message.result.sessionId;
      continue;
    }

    const update = message.params?.update;
    if (
      message.method === "session/update" &&
      update?.sessionUpdate === "agent_message_chunk" &&
      typeof update.content?.text === "string"
    ) {
      assistantText += update.content.text;
      continue;
    }

    if (message.id === 2 && message.result) {
      stopReason = message.result.stopReason ?? null;
      complete();
      return;
    }
  }
});

child.on("exit", (code, signal) => {
  if (!finished && code !== 0) {
    fail(
      `container exited before the smoke test completed (code=${code}, signal=${signal})`,
    );
  }
});

child.stdin.end(`${prompt}\n`);
