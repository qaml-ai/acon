#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "node:net";

const socketPath =
  process.env.ACON_HOST_RPC_SOCKET?.trim() || "/data/host-rpc/bridge.sock";
const workspaceRoot = process.env.ACON_WORKSPACE_DIR?.trim() || "/workspace";

const GLOBAL_INSTRUCTIONS = `# acon

This environment is for \`acon\`, the standalone camelAI desktop app.

- Use the codename \`acon\` when referring to this app.
- This repository is the standalone desktop app for camelAI.
- A bash tool named \`acon-mcp\` is available in the container.
- Run \`acon-mcp servers\` to list available MCP servers.
- Run \`acon-mcp tools <server-id>\` to list the tools exposed by a server.
- Run \`acon-mcp <server-id>\` to expose that server over stdio for MCP clients in the container.
- MCP tools are external integrations.
`;

/** @typedef {"codex" | "claude"} ProviderId */

/**
 * @typedef {{
 *   type: "ready";
 *   protocolVersion: number;
 *   socketPath: string;
 * } | {
 *   type: "request";
 *   id: string;
 *   method: string;
 *   params?: unknown;
 * } | {
 *   type: "response";
 *   id: string;
 *   result?: unknown;
 *   error?: {
 *     code?: string;
 *     message?: string;
 *   };
 * } | {
 *   type: "notification";
 *   method: string;
 *   params?: unknown;
 * }} DaemonEnvelope
 */

/**
 * @typedef {{
 *   provider: "claude";
 *   sessionName: string;
 *   model: string;
 *   sessionId: string;
 *   hasStarted: boolean;
 *   toolUseCache: Record<string, {
 *     id: string;
 *     name: string;
 *     input?: unknown;
 *   }>;
 *   activePrompt: ClaudePromptState | null;
 * }} ClaudeSessionState
 */

/**
 * @typedef {{
 *   provider: "codex";
 *   sessionName: string;
 *   model: string;
 *   threadId: string | null;
 *   serverGeneration: number;
 *   activeTurnId: string | null;
 *   activePrompt: CodexPromptState | null;
 *   pendingPrompts: CodexPromptState[];
 * }} CodexSessionState
 */

/**
 * @typedef {{
 *   child: import("node:child_process").ChildProcessWithoutNullStreams;
 *   finalText: string;
 *   stopReason: string | null;
 *   cancelled: boolean;
 *   resolve: (value: { sessionId: string; finalText: string; stopReason: string | null }) => void;
 *   reject: (error: Error) => void;
 * }} ClaudePromptState
 */

/**
 * @typedef {{
 *   finalText: string;
 *   turnId: string | null;
  *   cancelled: boolean;
 *   waiters: Array<{
 *     resolve: (value: { sessionId: string; finalText: string; stopReason: string | null }) => void;
 *     reject: (error: Error) => void;
 *   }>;
 * }} CodexPromptState
 */

/** @type {Map<string, ClaudeSessionState | CodexSessionState>} */
const sessions = new Map();
/** @type {Map<string, import("node:net").Socket>} */
const pendingSockets = new Map();
/** @type {Set<import("node:net").Socket>} */
const openSockets = new Set();
/** @type {Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null }>} */
const pendingHostRequests = new Map();

let shuttingDown = false;

function writeEnvelope(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function logStderr(message) {
  process.stderr.write(`[acon-agentd] ${message}\n`);
}

function makeError(code, message) {
  return { code, message };
}

function asRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function maybeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toTextContent(text) {
  return {
    type: "text",
    text,
  };
}

function emitSessionRuntimeEvent(sessionName, event) {
  writeEnvelope({
    type: "notification",
    method: "session.runtime_event",
    params: {
      sessionName,
      event,
    },
  });
}

function emitAcpSessionUpdate(sessionName, sessionId, update) {
  emitSessionRuntimeEvent(sessionName, {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update,
    },
  });
}

function ensureString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  return value.trim();
}

function ensureProviderId(value) {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(`Unsupported provider: ${String(value)}.`);
}

function getSessionKey(provider, sessionName) {
  return `${provider}:${sessionName}`;
}

function getProviderRoot(provider) {
  return `/data/providers/${provider}`;
}

function getProviderHome(provider) {
  return `${getProviderRoot(provider)}/home`;
}

function getCodexHome() {
  return `${getProviderHome("codex")}/.codex`;
}

function getClaudeConfigDir() {
  return `${getProviderHome("claude")}/.claude`;
}

function getProviderEnv(provider, model) {
  const home = getProviderHome(provider);
  if (provider === "codex") {
    return {
      ...process.env,
      HOME: home,
      CODEX_HOME: getCodexHome(),
      DESKTOP_PROVIDER: provider,
      DESKTOP_MODEL: model,
      DESKTOP_CODEX_MODEL: model,
      ACON_HOST_RPC_SOCKET: socketPath,
      ACON_WORKSPACE_DIR: workspaceRoot,
    };
  }

  return {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: getClaudeConfigDir(),
    DESKTOP_PROVIDER: provider,
    DESKTOP_MODEL: model,
    DESKTOP_ANTHROPIC_MODEL: model,
    ACON_HOST_RPC_SOCKET: socketPath,
    ACON_WORKSPACE_DIR: workspaceRoot,
  };
}

function ensureProviderHomes(provider) {
  const home = getProviderHome(provider);
  mkdirSync(home, { recursive: true });

  if (provider === "codex") {
    const codexHome = getCodexHome();
    mkdirSync(codexHome, { recursive: true });
    const authSeed = "/seed-codex/auth.json";
    const authTarget = resolve(codexHome, "auth.json");
    if (existsSync(authSeed) && !existsSync(authTarget)) {
      copyFileSync(authSeed, authTarget);
    }
    rmSync(resolve(codexHome, "AGENTS.override.md"), { force: true });
    writeFileSync(resolve(codexHome, "AGENTS.md"), GLOBAL_INSTRUCTIONS, "utf8");
    return;
  }

  const claudeConfigDir = getClaudeConfigDir();
  mkdirSync(claudeConfigDir, { recursive: true });
  const claudeCredentialsSeed = "/seed-claude/.credentials.json";
  const claudeCredentialsTarget = resolve(claudeConfigDir, ".credentials.json");
  if (existsSync(claudeCredentialsSeed) && !existsSync(claudeCredentialsTarget)) {
    copyFileSync(claudeCredentialsSeed, claudeCredentialsTarget);
  }
  const claudeJsonSeed = "/seed-claude-json/.claude.json";
  const claudeJsonTarget = resolve(home, ".claude.json");
  if (existsSync(claudeJsonSeed) && !existsSync(claudeJsonTarget)) {
    copyFileSync(claudeJsonSeed, claudeJsonTarget);
  }
  const claudeCredentialsJsonSeed = "/seed-claude-json/.credentials.json";
  if (existsSync(claudeCredentialsJsonSeed) && !existsSync(claudeCredentialsTarget)) {
    copyFileSync(claudeCredentialsJsonSeed, claudeCredentialsTarget);
  }
  writeFileSync(resolve(claudeConfigDir, "CLAUDE.md"), GLOBAL_INSTRUCTIONS, "utf8");
}

function cleanupSocketFile() {
  try {
    rmSync(socketPath, { force: true });
  } catch {
    // Best effort only.
  }
}

function writeSocketResponse(socket, message) {
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

function createHostRequest(method, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingHostRequests.delete(id);
      reject(new Error(`Timed out waiting for host method ${method}.`));
    }, timeoutMs);
    pendingHostRequests.set(id, {
      resolve,
      reject,
      timer,
    });
    writeEnvelope({
      type: "request",
      id,
      method,
      params,
    });
  });
}

class CodexAppServerClient {
  constructor() {
    this.child = null;
    this.buffer = "";
    this.stderrBuffer = "";
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.startPromise = null;
    this.generation = 0;
  }

  async ensureStarted() {
    if (this.child && this.child.exitCode === null) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      const child = spawn(
        "codex",
        [
          "app-server",
          "--listen",
          "stdio://",
        ],
        {
          cwd: workspaceRoot,
          env: getProviderEnv("codex", "gpt-5.4"),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      this.child = child;
      this.buffer = "";
      this.stderrBuffer = "";

      child.stdout.on("data", (chunk) => {
        this.buffer += chunk;
        this.consumeStdoutBuffer();
      });
      child.stderr.on("data", (chunk) => {
        this.stderrBuffer += chunk;
        logStderr(`codex-app-server stderr: ${chunk.toString("utf8").trim()}`);
      });
      child.on("exit", (code, signal) => {
        const error = new Error(
          `Codex app-server exited (code=${code}, signal=${signal}). ${this.stderrBuffer.trim()}`.trim(),
        );
        for (const [id, pending] of this.pendingRequests.entries()) {
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          pending.reject(error);
          this.pendingRequests.delete(id);
        }
        for (const session of sessions.values()) {
          if (session.provider !== "codex") {
            continue;
          }
          session.serverGeneration = -1;
          const activePrompt = session.activePrompt;
          session.activePrompt = null;
          if (activePrompt) {
            activePrompt.reject(error);
          }
        }
        this.child = null;
      });
      child.on("error", (error) => {
        logStderr(`codex-app-server process error: ${error.message}`);
      });

      await this.request("initialize", {
        clientInfo: {
          name: "acon-agentd",
          title: "acon agent daemon",
          version: "0.1.0",
        },
        capabilities: null,
      });
      this.notify("initialized");
      this.generation += 1;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  consumeStdoutBuffer() {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        logStderr(
          `codex-app-server emitted invalid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        const key = String(message.id);
        const pending = this.pendingRequests.get(key);
        if (!pending) {
          continue;
        }
        this.pendingRequests.delete(key);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        if (message.error) {
          pending.reject(
            new Error(
              typeof message.error.message === "string"
                ? message.error.message
                : JSON.stringify(message.error),
            ),
          );
          continue;
        }
        pending.resolve(message.result ?? null);
        continue;
      }

      if (typeof message.method === "string") {
        handleCodexNotification(message);
      }
    }
  }

  request(method, params, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) {
        reject(new Error("Codex app-server is not running."));
        return;
      }
      const id = String(this.nextRequestId++);
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pendingRequests.delete(id);
            reject(new Error(`Timed out waiting for codex app-server ${method}.`));
          }, timeoutMs)
        : null;
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
      });
      this.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params,
        })}\n`,
      );
    });
  }

  notify(method, params) {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`,
    );
  }

  stop() {
    if (!this.child || this.child.exitCode !== null) {
      return;
    }
    this.child.kill("SIGTERM");
  }
}

const codexAppServer = new CodexAppServerClient();

function getCodexSessionByThreadId(threadId) {
  for (const session of sessions.values()) {
    if (session.provider === "codex" && session.threadId === threadId) {
      return session;
    }
  }
  return null;
}

function getTurnStopReason(turnStatus) {
  if (turnStatus === "interrupted") {
    return "cancelled";
  }
  if (turnStatus === "completed") {
    return "end_turn";
  }
  return turnStatus ?? null;
}

function normalizePlanStatus(status) {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
    case "in_progress":
      return "in_progress";
    default:
      return "pending";
  }
}

function resolveCodexToolTitle(item) {
  switch (item.type) {
    case "commandExecution":
      return maybeString(item.command) ?? "command";
    case "fileChange":
      return "apply_patch";
    case "mcpToolCall":
      return item.server && item.tool
        ? `${String(item.server)}/${String(item.tool)}`
        : "mcp_tool";
    case "dynamicToolCall":
      return item.tool ? `Tool: ${String(item.tool)}` : "tool";
    case "webSearch":
      return "Searching the Web";
    default:
      return null;
  }
}

function getCodexToolOutputText(item) {
  switch (item.type) {
    case "commandExecution":
      return maybeString(item.aggregatedOutput) ?? null;
    case "mcpToolCall":
      if (item.error) {
        return typeof item.error === "string"
          ? item.error
          : JSON.stringify(item.error, null, 2);
      }
      if (item.result) {
        return JSON.stringify(item.result, null, 2);
      }
      return null;
    case "dynamicToolCall":
      if (Array.isArray(item.contentItems) && item.contentItems.length > 0) {
        return JSON.stringify(item.contentItems, null, 2);
      }
      return item.success === false ? "Tool failed." : null;
    case "fileChange":
      return item.status === "completed" ? "Updated files." : null;
    case "webSearch":
      return maybeString(item.query) ?? null;
    default:
      return null;
  }
}

function resolveCodexToolStatus(item) {
  switch (item.type) {
    case "commandExecution":
      switch (item.status) {
        case "completed":
          return "completed";
        case "failed":
        case "declined":
          return "failed";
        default:
          return "pending";
      }
    case "fileChange":
      switch (item.status) {
        case "completed":
          return "completed";
        case "failed":
        case "declined":
          return "failed";
        default:
          return "pending";
      }
    case "mcpToolCall":
    case "dynamicToolCall":
      switch (item.status) {
        case "completed":
          return "completed";
        case "failed":
        case "declined":
        case "denied":
        case "aborted":
          return "failed";
        default:
          return "pending";
      }
    case "webSearch":
      return "completed";
    default:
      return "pending";
  }
}

function emitCodexToolCallStarted(session, item) {
  const toolCallId = maybeString(item.id);
  const title = resolveCodexToolTitle(item);
  if (!toolCallId || !title || !session.threadId) {
    return;
  }
  emitAcpSessionUpdate(session.sessionName, session.threadId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    rawInput: item,
    status: "pending",
  });
}

function emitCodexToolCallUpdated(session, item, extra = {}) {
  const toolCallId = maybeString(item.id);
  const title = resolveCodexToolTitle(item);
  if (!toolCallId || !title || !session.threadId) {
    return;
  }
  const text = getCodexToolOutputText(item);
  emitAcpSessionUpdate(session.sessionName, session.threadId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title,
    rawInput: item,
    rawOutput: item,
    status: resolveCodexToolStatus(item),
    ...(text ? { content: toTextContent(text) } : {}),
    ...extra,
  });
}

function isCodexToolItem(item) {
  return Boolean(
    item &&
      typeof item === "object" &&
      typeof item.type === "string" &&
      [
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "dynamicToolCall",
        "webSearch",
      ].includes(item.type),
  );
}

function emitCodexSessionUpdate(session, update) {
  if (!session.threadId) {
    return;
  }
  emitAcpSessionUpdate(session.sessionName, session.threadId, update);
}

function resolveClaudeToolTitle(toolUse) {
  return maybeString(toolUse.name) ?? "tool";
}

function emitClaudeToolUseUpdate(session, toolUse, sessionUpdate) {
  const toolCallId = maybeString(toolUse.id);
  if (!toolCallId) {
    return;
  }
  emitAcpSessionUpdate(session.sessionName, session.sessionId, {
    sessionUpdate,
    toolCallId,
    title: resolveClaudeToolTitle(toolUse),
    rawInput: toolUse.input ?? {},
    status: sessionUpdate === "tool_call" ? "pending" : undefined,
  });
}

function emitClaudeContentUpdate(session, chunk) {
  if (!chunk || typeof chunk !== "object") {
    return;
  }

  switch (chunk.type) {
    case "text":
    case "text_delta":
      if (typeof chunk.text === "string" && chunk.text) {
        emitAcpSessionUpdate(session.sessionName, session.sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: toTextContent(chunk.text),
        });
      }
      return;
    case "thinking":
    case "thinking_delta":
      if (typeof chunk.thinking === "string" && chunk.thinking) {
        emitAcpSessionUpdate(session.sessionName, session.sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: toTextContent(chunk.thinking),
        });
      }
      return;
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use": {
      const toolUseId = maybeString(chunk.id);
      if (!toolUseId) {
        return;
      }
      const alreadySeen = Boolean(session.toolUseCache[toolUseId]);
      session.toolUseCache[toolUseId] = {
        id: toolUseId,
        name: maybeString(chunk.name) ?? "tool",
        input: chunk.input ?? {},
      };
      if (
        chunk.name === "TodoWrite" &&
        chunk.input &&
        typeof chunk.input === "object" &&
        Array.isArray(chunk.input.todos)
      ) {
        emitAcpSessionUpdate(session.sessionName, session.sessionId, {
          sessionUpdate: "plan",
          entries: chunk.input.todos.map((todo) => ({
            content:
              todo && typeof todo === "object" && typeof todo.content === "string"
                ? todo.content
                : "Untitled task",
            status:
              todo && typeof todo === "object"
                ? normalizePlanStatus(todo.status)
                : "pending",
          })),
        });
        return;
      }
      emitClaudeToolUseUpdate(
        session,
        chunk,
        alreadySeen ? "tool_call_update" : "tool_call",
      );
      return;
    }
    case "tool_result":
    case "tool_search_tool_result":
    case "web_fetch_tool_result":
    case "web_search_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "mcp_tool_result": {
      const toolUseId = maybeString(chunk.tool_use_id);
      if (!toolUseId) {
        return;
      }
      const toolUse = session.toolUseCache[toolUseId];
      if (toolUse?.name === "TodoWrite") {
        return;
      }
      emitAcpSessionUpdate(session.sessionName, session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: toolUseId,
        title: toolUse?.name ?? "tool",
        status: chunk.is_error ? "failed" : "completed",
        rawOutput: chunk.content ?? chunk,
        ...(chunk.content ? { content: chunk.content } : {}),
      });
      return;
    }
    default:
      return;
  }
}

function handleCodexNotification(message) {
  const method = typeof message.method === "string" ? message.method : "";
  const params =
    message.params && typeof message.params === "object" ? message.params : {};
  const threadId =
    typeof params.threadId === "string" ? params.threadId : null;
  const session = threadId ? getCodexSessionByThreadId(threadId) : null;
  if (session) {
    if (
      method === "turn/started" &&
      params.turn &&
      typeof params.turn === "object" &&
      typeof params.turn.id === "string"
    ) {
      session.activeTurnId = params.turn.id;
      if (session.activePrompt) {
        session.activePrompt.turnId = params.turn.id;
      } else {
        const pendingIndex = session.pendingPrompts.findIndex(
          (prompt) => prompt.turnId === params.turn.id,
        );
        const pendingPrompt =
          pendingIndex >= 0
            ? session.pendingPrompts.splice(pendingIndex, 1)[0]
            : session.pendingPrompts.shift() ?? null;
        if (pendingPrompt) {
          pendingPrompt.turnId = params.turn.id;
          session.activePrompt = pendingPrompt;
        }
      }
    }

    if (
      method === "item/agentMessage/delta" &&
      session.activePrompt &&
      typeof params.delta === "string"
    ) {
      session.activePrompt.finalText += params.delta;
      emitCodexSessionUpdate(session, {
        sessionUpdate: "agent_message_chunk",
        content: toTextContent(params.delta),
      });
    }

    if (
      method === "item/reasoning/summaryTextDelta" &&
      typeof params.delta === "string"
    ) {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "agent_thought_chunk",
        content: toTextContent(params.delta),
      });
    }

    if (
      method === "item/reasoning/textDelta" &&
      typeof params.delta === "string"
    ) {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "agent_thought_chunk",
        content: toTextContent(params.delta),
      });
    }

    if (method === "item/reasoning/summaryPartAdded") {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "agent_thought_chunk",
        content: toTextContent("\n\n"),
      });
    }

    if (
      method === "turn/plan/updated" &&
      Array.isArray(params.plan)
    ) {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "plan",
        entries: params.plan.map((entry) => ({
          content:
            entry && typeof entry === "object" && typeof entry.step === "string"
              ? entry.step
              : "Untitled task",
          status:
            entry && typeof entry === "object"
              ? normalizePlanStatus(entry.status)
              : "pending",
        })),
      });
    }

    if (
      method === "item/started" &&
      isCodexToolItem(params.item)
    ) {
      emitCodexToolCallStarted(session, params.item);
    }

    if (
      method === "item/commandExecution/outputDelta" &&
      typeof params.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "tool_call_update",
        toolCallId: params.itemId,
        status: "pending",
        content: toTextContent(params.delta),
        rawOutput: params.delta,
      });
    }

    if (
      method === "item/fileChange/outputDelta" &&
      typeof params.itemId === "string" &&
      typeof params.delta === "string"
    ) {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "tool_call_update",
        toolCallId: params.itemId,
        status: "pending",
        content: toTextContent(params.delta),
        rawOutput: params.delta,
      });
    }

    if (
      method === "item/completed" &&
      isCodexToolItem(params.item)
    ) {
      emitCodexToolCallUpdated(session, params.item);
    }

    if (
      method === "turn/completed" &&
      session.activePrompt &&
      params.turn &&
      typeof params.turn === "object"
    ) {
      const prompt = session.activePrompt;
      session.activePrompt = null;
      session.activeTurnId = null;
      const turnStatus =
        typeof params.turn.status === "string" ? params.turn.status : null;
      if (turnStatus === "failed") {
        const errorMessage =
          params.turn.error &&
          typeof params.turn.error === "object" &&
          typeof params.turn.error.message === "string"
            ? params.turn.error.message
            : "Codex turn failed.";
        for (const waiter of prompt.waiters) {
          waiter.reject(new Error(errorMessage));
        }
      } else {
        for (const waiter of prompt.waiters) {
          waiter.resolve({
            sessionId: session.threadId ?? "",
            finalText: prompt.finalText,
            stopReason: getTurnStopReason(turnStatus),
          });
        }
      }
    }
  }
}

function createClaudeSession(sessionName, model, sessionId = null, hasStarted = false) {
  return {
    provider: "claude",
    sessionName,
    model,
    sessionId: sessionId ?? randomUUID(),
    hasStarted,
    toolUseCache: {},
    activePrompt: null,
  };
}

function createCodexSession(sessionName, model, threadId = null) {
  return {
    provider: "codex",
    sessionName,
    model,
    threadId,
    serverGeneration: -1,
    activeTurnId: null,
    activePrompt: null,
    pendingPrompts: [],
  };
}

async function ensureCodexSession(session) {
  ensureProviderHomes("codex");
  await codexAppServer.ensureStarted();
  if (session.threadId && session.serverGeneration === codexAppServer.generation) {
    return session;
  }

  if (session.threadId) {
    await codexAppServer.request("thread/resume", {
      threadId: session.threadId,
      model: session.model,
      cwd: workspaceRoot,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    session.serverGeneration = codexAppServer.generation;
    return session;
  }

  const result = await codexAppServer.request("thread/start", {
    model: session.model,
    cwd: workspaceRoot,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    experimentalRawEvents: false,
    ephemeral: false,
  });
  const threadId =
    result &&
    typeof result === "object" &&
    result.thread &&
    typeof result.thread === "object" &&
    typeof result.thread.id === "string"
      ? result.thread.id
      : null;
  if (!threadId) {
    throw new Error("Codex thread/start did not return a thread id.");
  }

  session.threadId = threadId;
  session.serverGeneration = codexAppServer.generation;
  return session;
}

async function ensureSession(params) {
  if (!params || typeof params !== "object") {
    throw new Error("session.ensure params must be an object.");
  }
  const provider = ensureProviderId(params.provider);
  const sessionName = ensureString(params.sessionName, "session.ensure sessionName");
  const model = ensureString(params.model, "session.ensure model");
  const sessionId =
    typeof params.sessionId === "string" && params.sessionId.trim()
      ? params.sessionId.trim()
      : null;
  const key = getSessionKey(provider, sessionName);
  let session = sessions.get(key) ?? null;
  if (!session) {
    session = provider === "codex"
      ? createCodexSession(sessionName, model, sessionId)
      : createClaudeSession(sessionName, model, sessionId, Boolean(sessionId));
    sessions.set(key, session);
  }
  session.model = model;

  if (provider === "codex") {
    const codexSession = /** @type {CodexSessionState} */ (session);
    if (sessionId && codexSession.threadId !== sessionId) {
      if (codexSession.activePrompt) {
        throw new Error(`Codex session ${sessionName} cannot switch thread ids while prompting.`);
      }
      codexSession.threadId = sessionId;
      codexSession.serverGeneration = -1;
    }
    await ensureCodexSession(codexSession);
    return {
      sessionId: codexSession.threadId,
    };
  }

  ensureProviderHomes("claude");
  const claudeSession = /** @type {ClaudeSessionState} */ (session);
  if (sessionId && claudeSession.sessionId !== sessionId) {
    if (claudeSession.activePrompt) {
      throw new Error(`Claude session ${sessionName} cannot switch session ids while prompting.`);
    }
    claudeSession.sessionId = sessionId;
    claudeSession.hasStarted = true;
  }
  return {
    sessionId: claudeSession.sessionId,
  };
}

function createClaudeArgs(session, content) {
  const baseArgs = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits",
    "--model",
    session.model,
  ];
  if (session.hasStarted) {
    baseArgs.push("--resume", session.sessionId);
  } else {
    baseArgs.push("--session-id", session.sessionId);
  }
  return {
    command: "claude",
    args: baseArgs,
    stdin: `${content}\n`,
  };
}

function extractClaudeDeltaText(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  if (
    event.type === "stream_event" &&
    event.event &&
    typeof event.event === "object" &&
    event.event.type === "content_block_delta" &&
    event.event.delta &&
    typeof event.event.delta === "object" &&
    event.event.delta.type === "text_delta" &&
    typeof event.event.delta.text === "string"
  ) {
    return event.event.delta.text;
  }
  return "";
}

function emitClaudeRuntimeEvent(session, message) {
  if (!message || typeof message !== "object") {
    return;
  }

  switch (message.type) {
    case "stream_event": {
      const event = asRecord(message.event);
      if (!event) {
        return;
      }
      if (event.type === "content_block_start") {
        emitClaudeContentUpdate(session, event.content_block);
      } else if (event.type === "content_block_delta") {
        emitClaudeContentUpdate(session, event.delta);
      }
      return;
    }
    case "assistant":
    case "user": {
      const assistantMessage = asRecord(message.message);
      if (!assistantMessage || !Array.isArray(assistantMessage.content)) {
        return;
      }
      for (const chunk of assistantMessage.content) {
        if (
          chunk &&
          typeof chunk === "object" &&
          typeof chunk.type === "string" &&
          ["text", "thinking"].includes(chunk.type)
        ) {
          continue;
        }
        emitClaudeContentUpdate(session, chunk);
      }
      return;
    }
    default:
      return;
  }
}

async function promptClaudeSession(session, content) {
  if (session.activePrompt) {
    throw new Error(`Claude session ${session.sessionName} is already running a prompt.`);
  }
  ensureProviderHomes("claude");
  const { command, args, stdin } = createClaudeArgs(session, content);
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: getProviderEnv("claude", session.model),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  return await new Promise((resolve, reject) => {
    /** @type {ClaudePromptState} */
    const promptState = {
      child,
      finalText: "",
      stopReason: null,
      cancelled: false,
      resolve,
      reject,
    };
    session.activePrompt = promptState;
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;

    function finishWithError(error) {
      if (settled) {
        return;
      }
      settled = true;
      session.activePrompt = null;
      reject(error);
    }

    function finishWithResult(stopReason) {
      if (settled) {
        return;
      }
      settled = true;
      session.activePrompt = null;
      resolve({
        sessionId: session.sessionId,
        finalText: promptState.finalText,
        stopReason,
      });
    }

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          finishWithError(
            error instanceof Error
              ? error
              : new Error(`Claude emitted invalid JSON: ${line}`),
          );
          return;
        }
        if (typeof message.session_id === "string" && message.session_id.trim()) {
          session.sessionId = message.session_id.trim();
        }
        const delta = extractClaudeDeltaText(message);
        if (delta) {
          promptState.finalText += delta;
        }
        emitClaudeRuntimeEvent(session, message);
        if (message.type === "result") {
          session.hasStarted = true;
          promptState.stopReason =
            typeof message.stop_reason === "string" ? message.stop_reason : null;
          if (typeof message.result === "string") {
            promptState.finalText = message.result;
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      logStderr(`claude stderr: ${chunk.toString("utf8").trim()}`);
    });

    child.on("error", (error) => {
      finishWithError(error);
    });

    child.on("exit", (code, signal) => {
      if (promptState.cancelled) {
        finishWithResult("cancelled");
        return;
      }
      if (code === 0) {
        finishWithResult(promptState.stopReason);
        return;
      }
      finishWithError(
        new Error(
          stderr.trim() ||
            `Claude exited before prompt completion (code=${code}, signal=${signal}).`,
        ),
      );
    });

    child.stdin.end(stdin);
  });
}

async function promptCodexSession(session, content) {
  await ensureCodexSession(session);

  if (session.activePrompt) {
    try {
      if (!session.threadId) {
        throw new Error(`Codex session ${session.sessionName} has no active thread id.`);
      }
      if (!session.activePrompt.turnId) {
        throw new Error(`Codex session ${session.sessionName} has no steerable active turn id.`);
      }

      await codexAppServer.request("turn/steer", {
        threadId: session.threadId,
        expectedTurnId: session.activePrompt.turnId,
        input: [
          {
            type: "text",
            text: content,
            text_elements: [],
          },
        ],
      });

      return await new Promise((resolve, reject) => {
        session.activePrompt.waiters.push({ resolve, reject });
      });
    } catch (error) {
      logStderr(
        `codex turn/steer failed for ${session.sessionName}; falling back to turn/start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return await new Promise(async (resolve, reject) => {
        /** @type {CodexPromptState} */
        const queuedPrompt = {
          finalText: "",
          turnId: null,
          cancelled: false,
          waiters: [{ resolve, reject }],
        };
        try {
          const response = await codexAppServer.request("turn/start", {
            threadId: session.threadId,
            input: [
              {
                type: "text",
                text: content,
                text_elements: [],
              },
            ],
            model: session.model,
            approvalPolicy: "never",
            sandboxPolicy: {
              type: "dangerFullAccess",
            },
          });
          const turnId =
            response &&
            typeof response === "object" &&
            response.turn &&
            typeof response.turn === "object" &&
            typeof response.turn.id === "string"
              ? response.turn.id
              : null;
          if (!turnId) {
            reject(new Error("Codex turn/start did not return a turn id."));
            return;
          }
          queuedPrompt.turnId = turnId;
          session.pendingPrompts.push(queuedPrompt);
        } catch (startError) {
          reject(startError instanceof Error ? startError : new Error(String(startError)));
        }
      });
    }
  }

  return await new Promise(async (resolve, reject) => {
    /** @type {CodexPromptState} */
    const promptState = {
      finalText: "",
      turnId: null,
      cancelled: false,
      waiters: [{ resolve, reject }],
    };
    session.activePrompt = promptState;
    try {
      const response = await codexAppServer.request("turn/start", {
        threadId: session.threadId,
        input: [
          {
            type: "text",
            text: content,
            text_elements: [],
          },
        ],
        model: session.model,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      });
      const turnId =
        response &&
        typeof response === "object" &&
        response.turn &&
        typeof response.turn === "object" &&
        typeof response.turn.id === "string"
          ? response.turn.id
          : null;
      if (!turnId) {
        session.activePrompt = null;
        reject(new Error("Codex turn/start did not return a turn id."));
        return;
      }
      promptState.turnId = turnId;
    } catch (error) {
      session.activePrompt = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function promptSession(params) {
  if (!params || typeof params !== "object") {
    throw new Error("session.prompt params must be an object.");
  }
  const provider = ensureProviderId(params.provider);
  const sessionName = ensureString(params.sessionName, "session.prompt sessionName");
  const content = ensureString(params.content, "session.prompt content");
  const model = ensureString(params.model, "session.prompt model");
  const key = getSessionKey(provider, sessionName);
  const session = sessions.get(key);
  if (!session) {
    throw new Error(`Session ${sessionName} has not been ensured yet.`);
  }
  session.model = model;
  if (provider === "claude") {
    return await promptClaudeSession(/** @type {ClaudeSessionState} */ (session), content);
  }
  return await promptCodexSession(/** @type {CodexSessionState} */ (session), content);
}

async function cancelSession(params) {
  if (!params || typeof params !== "object") {
    throw new Error("session.cancel params must be an object.");
  }
  const provider = ensureProviderId(params.provider);
  const sessionName = ensureString(params.sessionName, "session.cancel sessionName");
  const key = getSessionKey(provider, sessionName);
  const session = sessions.get(key);
  if (!session) {
    return { ok: true };
  }

  if (provider === "claude") {
    const claudeSession = /** @type {ClaudeSessionState} */ (session);
    if (claudeSession.activePrompt?.child && claudeSession.activePrompt.child.exitCode === null) {
      claudeSession.activePrompt.cancelled = true;
      claudeSession.activePrompt.child.kill("SIGTERM");
      setTimeout(() => {
        if (claudeSession.activePrompt?.child?.exitCode === null) {
          claudeSession.activePrompt.child.kill("SIGKILL");
        }
      }, 1_000).unref();
    }
    return { ok: true };
  }

  const codexSession = /** @type {CodexSessionState} */ (session);
  const turnId = codexSession.activePrompt?.turnId;
  if (!turnId || !codexSession.threadId) {
    return { ok: true };
  }
  codexSession.activePrompt.cancelled = true;
  await codexAppServer.request("turn/interrupt", {
    threadId: codexSession.threadId,
    turnId,
  });
  return { ok: true };
}

async function executeSocketMethod(method, params) {
  switch (method) {
    case "ping":
      return {
        ok: true,
        now: new Date().toISOString(),
        pid: process.pid,
        params: params ?? null,
      };
    case "fetch":
    case "mcp.request":
    case "mcp.close":
    case "mcp.list_servers":
      return await createHostRequest(method, params);
    default:
      throw new Error(`Unknown socket RPC method: ${method}.`);
  }
}

async function executeHostRequest(method, params) {
  switch (method) {
    case "ping":
      return {
        ok: true,
        now: new Date().toISOString(),
        pid: process.pid,
      };
    case "session.ensure":
      return await ensureSession(params);
    case "session.prompt":
      return await promptSession(params);
    case "session.cancel":
      return await cancelSession(params);
    default:
      throw new Error(`Unknown daemon request method: ${method}.`);
  }
}

function handleSocketConnection(socket) {
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
        writeSocketResponse(socket, {
          error: makeError("INVALID_JSON", "Container RPC request must be valid JSON."),
        });
        continue;
      }

      const id = typeof message?.id === "string" ? message.id : null;
      const method = typeof message?.method === "string" ? message.method : null;
      if (!id || !method) {
        writeSocketResponse(socket, {
          id,
          error: makeError(
            "INVALID_REQUEST",
            "Container RPC request must include string id and method fields.",
          ),
        });
        continue;
      }

      pendingSockets.set(id, socket);
      void executeSocketMethod(method, message.params)
        .then((result) => {
          const pendingSocket = pendingSockets.get(id);
          if (!pendingSocket) {
            return;
          }
          pendingSockets.delete(id);
          writeSocketResponse(pendingSocket, {
            id,
            result,
          });
        })
        .catch((error) => {
          const pendingSocket = pendingSockets.get(id);
          if (!pendingSocket) {
            return;
          }
          pendingSockets.delete(id);
          writeSocketResponse(pendingSocket, {
            id,
            error: makeError(
              "RPC_ERROR",
              error instanceof Error ? error.message : String(error),
            ),
          });
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
}

cleanupSocketFile();
mkdirSync(dirname(socketPath), { recursive: true });

const server = createServer(handleSocketConnection);
server.listen(socketPath, () => {
  writeEnvelope({
    type: "ready",
    protocolVersion: 2,
    socketPath,
  });
});

process.stdin.setEncoding("utf8");
let stdinBuffer = "";

process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;

  while (true) {
    const newlineIndex = stdinBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }

    const line = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }

    /** @type {DaemonEnvelope} */
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.type === "response" && typeof message.id === "string") {
      const pending = pendingHostRequests.get(message.id);
      if (!pending) {
        continue;
      }
      pendingHostRequests.delete(message.id);
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      if (message.error) {
        pending.reject(new Error(message.error.message || "Host request failed."));
      } else {
        pending.resolve(message.result ?? null);
      }
      continue;
    }

    if (message.type === "request" && typeof message.id === "string") {
      void executeHostRequest(message.method, message.params)
        .then((result) => {
          writeEnvelope({
            type: "response",
            id: message.id,
            result,
          });
        })
        .catch((error) => {
          writeEnvelope({
            type: "response",
            id: message.id,
            error: makeError(
              "RPC_ERROR",
              error instanceof Error ? error.message : String(error),
            ),
          });
        });
    }
  }
});

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  closeAllSockets();
  cleanupSocketFile();
  for (const session of sessions.values()) {
    if (session.provider === "claude" && session.activePrompt?.child) {
      session.activePrompt.child.kill("SIGTERM");
    }
  }
  codexAppServer.stop();
  server.close(() => {
    process.exit(0);
  });
}

process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
