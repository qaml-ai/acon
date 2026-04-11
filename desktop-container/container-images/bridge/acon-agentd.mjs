#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

const socketPath =
  process.env.ACON_HOST_RPC_SOCKET?.trim() || "/data/host-rpc/bridge.sock";
const workspaceRoot = process.env.ACON_WORKSPACE_DIR?.trim() || "/workspace";
const bundledNodeModulesRoot = "/opt/acon/npm-global/node_modules";
const bundledHostRpcPackagePath = resolve(bundledNodeModulesRoot, "@acon/host-rpc");
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_REQUEST_MAX_BODY_BYTES = 1024 * 1024;

const GLOBAL_INSTRUCTIONS = `# acon

This environment is for \`acon\`, the standalone camelAI desktop app.

- Use the codename \`acon\` when referring to this app.
- This repository is the standalone desktop app for camelAI.
- A bash tool named \`acon-mcp\` is available in the container.
- Run \`acon-mcp servers\` to list available MCP servers.
- Run \`acon-mcp tools <server-id>\` to list the tools exposed by a server.
- Run \`acon-mcp call <server-id> <tool-name> --input '{"key":"value"}'\` for one-shot tool calls.
- Run \`acon-mcp prompts <server-id>\`, \`acon-mcp prompt <server-id> <prompt-name>\`, \`acon-mcp resources <server-id>\`, and \`acon-mcp read-resource <server-id> <uri>\` for standard prompt and resource flows.
- A typed JavaScript package named \`@acon/host-rpc\` is preinstalled for guest code.
- Prefer the managed helpers on \`@acon/host-rpc\`: \`listMcpServers()\`, \`listMcpTools(serverId)\`, \`callMcpTool(serverId, toolName, args)\`, \`listMcpPrompts(serverId)\`, \`getMcpPrompt(serverId, promptName, args)\`, \`listMcpResources(serverId)\`, \`listMcpResourceTemplates(serverId)\`, \`readMcpResource(serverId, uri)\`, and \`withMcpSession(serverId, callback)\` for grouped interactions.
- An authenticated host HTTP bridge is exposed inside the container at \`$ACON_HOST_HTTP_BASE_URL\`.
- Plugin-owned routes live under \`$ACON_HOST_HTTP_BASE_URL/plugins/<plugin-id>/routes/<route-id>/...\`.
- Plugin-owned authenticated proxies live under \`$ACON_HOST_HTTP_BASE_URL/plugins/<plugin-id>/proxies/<proxy-id>/...\`.
- When running a web server in the guest container, bind it to \`0.0.0.0\` instead of \`localhost\`.
- When opening a preview URL for a guest web server, use the current container IP instead of \`localhost\`.
- Example:
  \`\`\`js
  import { createHostRpcClient } from "@acon/host-rpc";

  const client = createHostRpcClient();
  const servers = await client.listMcpServers();
  const tools = await client.listMcpTools("server-id");
  \`\`\`
- MCP tools are external integrations.
- User-provided files are mounted at \`/mnt/user-uploads\`; read inputs from there when the prompt references them.
- User-deliverable artifacts should be written to \`/mnt/user-outputs\` so the desktop app can offer them back as downloads.
- When you create a user-deliverable file in \`/mnt/user-outputs\`, mention the full output path in your reply.
`;

/** @typedef {"codex" | "claude" | "pi" | "opencode"} ProviderId */

/**
 * @typedef {{
 *   type: "ready";
 *   protocolVersion: number;
 *   socketPath: string;
 *   httpBaseUrl?: string;
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
 *   process: ClaudeProcessState | null;
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
 *   stdoutBuffer: string;
 *   stderr: string;
 *   launchedModel: string;
 *   pendingControlRequests: Map<string, {
 *     resolve: (value: unknown) => void;
 *     reject: (error: Error) => void;
 *     timer: NodeJS.Timeout | null;
 *   }>;
 * }} ClaudeProcessState
 */

/**
 * @typedef {{
 *   finalText: string;
 *   stopReason: string | null;
 *   cancelled: boolean;
 *   waiters: Array<{
 *     resolve: (value: { sessionId: string; finalText: string; stopReason: string | null }) => void;
 *     reject: (error: Error) => void;
 *   }>;
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

/**
 * @typedef {{
 *   provider: "pi" | "opencode";
 *   sessionName: string;
 *   model: string;
 *   sessionId: string | null;
 *   loadedSessionId: string | null;
 *   process: AcpProcessState | null;
 *   modelState: AcpModelState | null;
 *   activePrompt: AcpPromptState | null;
 * }} AcpSessionState
 */

/**
 * @typedef {{
 *   child: import("node:child_process").ChildProcessWithoutNullStreams;
 *   stdoutBuffer: string;
 *   stderr: string;
 *   nextRequestId: number;
 *   pendingRequests: Map<string, {
 *     resolve: (value: unknown) => void;
 *     reject: (error: Error) => void;
 *     timer: NodeJS.Timeout | null;
 *   }>;
 * }} AcpProcessState
 */

/**
 * @typedef {{
 *   availableModelIds: string[];
 *   currentModelId: string | null;
 * }} AcpModelState
 */

/**
 * @typedef {{
 *   finalText: string;
 *   stopReason: string | null;
 *   cancelled: boolean;
 *   waiters: Array<{
 *     resolve: (value: { sessionId: string; finalText: string; stopReason: string | null }) => void;
 *     reject: (error: Error) => void;
 *   }>;
 * }} AcpPromptState
 */

/** @type {Map<string, ClaudeSessionState | CodexSessionState | AcpSessionState>} */
const sessions = new Map();
/** @type {Map<string, import("node:net").Socket>} */
const pendingSockets = new Map();
/** @type {Set<import("node:net").Socket>} */
const openSockets = new Set();
/** @type {Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null }>} */
const pendingHostRequests = new Map();

let shuttingDown = false;
let hostHttpBaseUrl = "http://127.0.0.1";
/** @type {import("node:http").Server | null} */
let hostHttpServer = null;
/** @type {{ codex: Record<string, string>; claude: Record<string, string>; pi: Record<string, string>; opencode: Record<string, string> }} */
const configuredProviderEnv = {
  codex: {},
  claude: {},
  pi: {},
  opencode: {},
};
/** @type {{ codex: string; claude: string; pi: string; opencode: string }} */
const configuredProviderEnvSignature = {
  codex: "",
  claude: "",
  pi: "",
  opencode: "",
};

function writeEnvelope(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function logStderr(message) {
  process.stderr.write(`[acon-agentd] ${message}\n`);
}

function makeError(code, message) {
  return { code, message };
}

function normalizeHttpHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(", ");
      continue;
    }
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

function getProcessEnvMountPath(pluginId, target, id, path = "/") {
  const kind = target === "proxy" ? "proxies" : "routes";
  const normalizedPath = path && path !== "/" ? (path.startsWith("/") ? path : `/${path}`) : "";
  return `/plugins/${encodeURIComponent(pluginId)}/${kind}/${encodeURIComponent(id)}${normalizedPath}`;
}

function resolveConfiguredProviderEnvValue(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.kind === "literal" && typeof value.value === "string") {
    return value.value;
  }
  if (
    value.kind === "httpUrl" &&
    typeof value.pluginId === "string" &&
    (value.target === "route" || value.target === "proxy") &&
    typeof value.id === "string"
  ) {
    return `${hostHttpBaseUrl}${getProcessEnvMountPath(
      value.pluginId,
      value.target,
      value.id,
      typeof value.path === "string" ? value.path : "/",
    )}`;
  }
  return null;
}

function applyConfiguredProcessEnv(provider, processEnv) {
  const nextEnv = {};
  if (processEnv && typeof processEnv === "object") {
    for (const [name, rawValue] of Object.entries(processEnv)) {
      if (typeof name !== "string" || !name.trim()) {
        continue;
      }
      const resolvedValue =
        typeof rawValue === "string"
          ? rawValue
          : resolveConfiguredProviderEnvValue(rawValue);
      if (typeof resolvedValue === "string") {
        nextEnv[name] = resolvedValue;
      }
    }
  }

  const nextSignature = JSON.stringify(
    Object.entries(nextEnv).sort(([left], [right]) => left.localeCompare(right)),
  );
  const changed = configuredProviderEnvSignature[provider] !== nextSignature;
  configuredProviderEnv[provider] = nextEnv;
  configuredProviderEnvSignature[provider] = nextSignature;
  return changed;
}

function readHttpRequestBody(request, maxBodyBytes = DEFAULT_HTTP_REQUEST_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (error, body = "") => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(body);
    };

    request.on("data", (chunk) => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += chunkBuffer.length;
      if (totalBytes > maxBodyBytes) {
        request.destroy(new Error(`HTTP request body exceeded ${maxBodyBytes} bytes.`));
        finish(new Error(`HTTP request body exceeded ${maxBodyBytes} bytes.`));
        return;
      }
      chunks.push(chunkBuffer);
    });
    request.on("end", () => {
      finish(null, Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function handleHttpBridgeRequest(request, response) {
  const requestUrl = new URL(request.url || "/", hostHttpBaseUrl);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "*",
    });
    response.end();
    return;
  }

  if (requestUrl.pathname === "/health") {
    response.writeHead(200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({
      ok: true,
      httpBaseUrl: hostHttpBaseUrl,
    }));
    return;
  }

  try {
    const body = await readHttpRequestBody(request);
    const result = await createHostRequest("http.request", {
      method: request.method || "GET",
      pathname: requestUrl.pathname,
      search: requestUrl.search,
      headers: normalizeHttpHeaders(request.headers),
      body: body || null,
    }, DEFAULT_HTTP_REQUEST_TIMEOUT_MS);

    const status =
      result && typeof result === "object" && typeof result.status === "number"
        ? result.status
        : 502;
    const headers =
      result && typeof result === "object" && result.headers && typeof result.headers === "object"
        ? normalizeHttpHeaders(result.headers)
        : { "content-type": "text/plain; charset=utf-8" };
    const responseBody =
      result && typeof result === "object" && typeof result.body === "string"
        ? result.body
        : "Host HTTP bridge returned an invalid response.";
    response.writeHead(status, headers);
    response.end(responseBody);
  } catch (error) {
    response.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(error instanceof Error ? error.message : String(error));
  }
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
  if (
    value === "codex" ||
    value === "claude" ||
    value === "pi" ||
    value === "opencode"
  ) {
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

function getPiHome() {
  return `${getProviderHome("pi")}/.pi`;
}

function getPiAgentDir() {
  return `${getPiHome()}/agent`;
}

function getOpenCodeDataDir(provider) {
  return `${getProviderHome(provider)}/.local/share/opencode`;
}

function getOpenCodeConfigDir(provider) {
  return `${getProviderHome(provider)}/.config/opencode`;
}

function getProviderEnv(provider, model) {
  const home = getProviderHome(provider);
  const providerEnv = configuredProviderEnv[provider] ?? {};
  if (provider === "codex") {
    return {
      ...process.env,
      ...providerEnv,
      HOME: home,
      CODEX_HOME: getCodexHome(),
      DESKTOP_PROVIDER: provider,
      DESKTOP_MODEL: model,
      DESKTOP_CODEX_MODEL: model,
      ACON_HOST_RPC_SOCKET: socketPath,
      ACON_HOST_HTTP_BASE_URL: hostHttpBaseUrl,
      ACON_WORKSPACE_DIR: workspaceRoot,
    };
  }

  if (provider === "claude") {
    return {
      ...process.env,
      ...providerEnv,
      HOME: home,
      CLAUDE_CONFIG_DIR: getClaudeConfigDir(),
      DESKTOP_PROVIDER: provider,
      DESKTOP_MODEL: model,
      DESKTOP_ANTHROPIC_MODEL: model,
      ACON_HOST_RPC_SOCKET: socketPath,
      ACON_HOST_HTTP_BASE_URL: hostHttpBaseUrl,
      ACON_WORKSPACE_DIR: workspaceRoot,
    };
  }

  if (provider === "pi") {
    return {
      ...process.env,
      ...providerEnv,
      HOME: home,
      DESKTOP_PROVIDER: provider,
      DESKTOP_MODEL: model,
      ACON_HOST_RPC_SOCKET: socketPath,
      ACON_HOST_HTTP_BASE_URL: hostHttpBaseUrl,
      ACON_WORKSPACE_DIR: workspaceRoot,
    };
  }

  return {
    ...process.env,
    ...providerEnv,
    HOME: home,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CONFIG_HOME: `${home}/.config`,
    DESKTOP_PROVIDER: provider,
    DESKTOP_MODEL: model,
    ACON_HOST_RPC_SOCKET: socketPath,
    ACON_HOST_HTTP_BASE_URL: hostHttpBaseUrl,
    ACON_WORKSPACE_DIR: workspaceRoot,
  };
}

function ensureProviderHomes(provider) {
  ensureBundledGuestNodePackages();
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

  if (provider === "claude") {
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
    return;
  }

  ensureAcpProviderHome(provider);
}

function maybeSeedFile(seedPath, targetPath) {
  if (existsSync(seedPath) && !existsSync(targetPath)) {
    copyFileSync(seedPath, targetPath);
  }
}

function ensureAcpProviderHome(provider) {
  const home = getProviderHome(provider);
  mkdirSync(home, { recursive: true });

  if (provider === "pi") {
    const piAgentDir = getPiAgentDir();
    mkdirSync(piAgentDir, { recursive: true });
    maybeSeedFile("/seed-pi/agent/auth.json", resolve(piAgentDir, "auth.json"));
    maybeSeedFile("/seed-pi/agent/models.json", resolve(piAgentDir, "models.json"));
    return;
  }

  const dataDir = getOpenCodeDataDir(provider);
  const configDir = getOpenCodeConfigDir(provider);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  maybeSeedFile("/seed-opencode-data/auth.json", resolve(dataDir, "auth.json"));
  maybeSeedFile("/seed-opencode-config/opencode.json", resolve(configDir, "opencode.json"));
}

function ensureBundledGuestNodePackages() {
  if (!existsSync(bundledHostRpcPackagePath)) {
    return;
  }

  const workspaceNodeModulesPath = resolve(workspaceRoot, "node_modules");
  const workspaceScopedPackagesPath = resolve(workspaceNodeModulesPath, "@acon");
  const workspaceHostRpcLinkPath = resolve(workspaceScopedPackagesPath, "host-rpc");

  mkdirSync(workspaceScopedPackagesPath, { recursive: true });

  try {
    const currentEntry = lstatSync(workspaceHostRpcLinkPath);
    if (!currentEntry.isSymbolicLink()) {
      return;
    }

    const currentTargetPath = resolve(
      workspaceScopedPackagesPath,
      readlinkSync(workspaceHostRpcLinkPath),
    );
    if (currentTargetPath === bundledHostRpcPackagePath) {
      return;
    }

    rmSync(workspaceHostRpcLinkPath, { force: true, recursive: true });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  symlinkSync(bundledHostRpcPackagePath, workspaceHostRpcLinkPath, "dir");
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
          "--dangerously-bypass-approvals-and-sandbox",
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
    case "imageView":
      return "View Image";
    case "enteredReviewMode":
      return "Review Mode";
    case "exitedReviewMode":
      return "Review Mode";
    case "contextCompaction":
      return "Context Compaction";
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
    case "imageView":
      return maybeString(item.path) ?? "Viewed image.";
    case "enteredReviewMode":
      return maybeString(item.review) ?? "Entered review mode.";
    case "exitedReviewMode":
      return maybeString(item.review) ?? "Exited review mode.";
    case "contextCompaction":
      return "Context compacted.";
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
    case "imageView":
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
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
        "imageView",
        "enteredReviewMode",
        "exitedReviewMode",
        "contextCompaction",
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
      method === "item/commandExecution/terminalInteraction" &&
      typeof params.itemId === "string" &&
      typeof params.input === "string"
    ) {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "tool_call_update",
        toolCallId: params.itemId,
        status: "pending",
        content: toTextContent(`\n> ${params.input}\n`),
        rawOutput: params.input,
      });
    }

    if (
      method === "item/mcpToolCall/progress" &&
      typeof params.itemId === "string" &&
      typeof params.message === "string"
    ) {
      emitCodexSessionUpdate(session, {
        sessionUpdate: "tool_call_update",
        toolCallId: params.itemId,
        status: "pending",
        content: toTextContent(params.message),
        rawOutput: params.message,
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
    process: null,
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

function createAcpSession(provider, sessionName, model, sessionId = null) {
  return {
    provider,
    sessionName,
    model,
    sessionId,
    loadedSessionId: null,
    process: null,
    modelState: null,
    activePrompt: null,
  };
}

function getAcpCommand(provider) {
  if (provider === "pi") {
    return {
      command: "pi-acp",
      args: [],
    };
  }

  return {
    command: "opencode",
    args: ["acp"],
  };
}

function extractAcpTextContent(content) {
  if (!content) {
    return "";
  }
  if (Array.isArray(content)) {
    return content.map((item) => extractAcpTextContent(item)).join("");
  }
  if (typeof content === "string") {
    return content;
  }
  if (typeof content !== "object") {
    return "";
  }
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (Array.isArray(content.content)) {
    return content.content.map((item) => extractAcpTextContent(item)).join("");
  }
  return "";
}

function extractAcpStopReason(result) {
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  return maybeString(record.stopReason) ?? maybeString(record.stop_reason);
}

function extractAcpSessionId(result) {
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  return maybeString(record.sessionId);
}

function extractAcpModelState(provider, result) {
  const record = asRecord(result);
  if (!record) {
    return null;
  }

  if (provider === "pi") {
    const models = asRecord(record.models);
    const availableModels = Array.isArray(models?.availableModels)
      ? models.availableModels
      : [];
    return {
      availableModelIds: availableModels
        .map((item) => maybeString(item?.modelId))
        .filter(Boolean),
      currentModelId: maybeString(models?.currentModelId),
    };
  }

  const configOptions = Array.isArray(record.configOptions) ? record.configOptions : [];
  const modelOption = configOptions.find(
    (item) =>
      item &&
      typeof item === "object" &&
      item.id === "model",
  );
  if (!modelOption || typeof modelOption !== "object") {
    return null;
  }

  return {
    currentModelId: maybeString(modelOption.currentValue),
    availableModelIds: Array.isArray(modelOption.options)
      ? modelOption.options
          .map((item) => maybeString(item?.value))
          .filter(Boolean)
      : [],
  };
}

function matchesAcpModelPreference(actualModelId, preferredModelId) {
  const normalizedActual = maybeString(actualModelId);
  const normalizedPreferred = maybeString(preferredModelId);
  if (!normalizedActual || !normalizedPreferred || normalizedPreferred === "default") {
    return false;
  }
  if (normalizedPreferred.endsWith("/default")) {
    const prefix = normalizedPreferred.slice(0, -"/default".length);
    return normalizedActual === prefix || normalizedActual.startsWith(`${prefix}/`);
  }
  return normalizedActual === normalizedPreferred;
}

function describeAcpModelPreference(model) {
  if (!model || model === "default") {
    return "the current default";
  }
  if (model === "openrouter/default") {
    return "OpenRouter";
  }
  if (model === "opencode/default") {
    return "OpenCode Zen";
  }
  if (model === "opencode-go/default") {
    return "OpenCode Go";
  }
  if (model === "openai-compatible/default") {
    return "Custom OpenAI-Compatible";
  }
  return model;
}

function resolvePreferredAcpModel(modelState, preferredModelId) {
  if (!modelState || !preferredModelId || preferredModelId === "default") {
    return null;
  }
  if (matchesAcpModelPreference(modelState.currentModelId, preferredModelId)) {
    return modelState.currentModelId;
  }
  if (modelState.availableModelIds.includes(preferredModelId)) {
    return preferredModelId;
  }
  if (preferredModelId.endsWith("/default")) {
    const prefix = preferredModelId.slice(0, -"/default".length);
    return (
      modelState.availableModelIds.find(
        (item) => item === prefix || item.startsWith(`${prefix}/`),
      ) ?? null
    );
  }
  return null;
}

function rejectAcpPrompt(promptState, error) {
  for (const waiter of promptState.waiters) {
    waiter.reject(error);
  }
}

function resolveAcpPrompt(session, promptState, stopReason) {
  for (const waiter of promptState.waiters) {
    waiter.resolve({
      sessionId: session.sessionId ?? "",
      finalText: promptState.finalText,
      stopReason,
    });
  }
}

function resetAcpProcess(session) {
  const processState = session.process;
  session.process = null;
  session.loadedSessionId = null;
  if (!processState) {
    return;
  }
  for (const [requestId, pending] of processState.pendingRequests.entries()) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.reject(new Error(`${session.provider} ACP process stopped before request completion.`));
    processState.pendingRequests.delete(requestId);
  }
  if (processState.child.exitCode === null) {
    processState.child.kill("SIGTERM");
  }
}

function handleAcpNotification(session, message) {
  emitSessionRuntimeEvent(session.sessionName, message);
  if (message.method !== "session/update") {
    return;
  }

  const params = asRecord(message.params);
  const update = asRecord(params?.update);
  const sessionId = maybeString(params?.sessionId);
  if (!update || (session.sessionId && sessionId && session.sessionId !== sessionId)) {
    return;
  }

  const sessionUpdate = maybeString(update.sessionUpdate);
  if (sessionUpdate === "agent_message_chunk" && session.activePrompt) {
    const text = extractAcpTextContent(update.content);
    if (text) {
      session.activePrompt.finalText += text;
    }
    return;
  }

  if (sessionUpdate === "agent_message" && session.activePrompt && !session.activePrompt.finalText) {
    const text = extractAcpTextContent(update.content);
    if (text) {
      session.activePrompt.finalText = text;
    }
  }
}

async function sendAcpRequest(session, method, params, timeoutMs = 30_000) {
  const processState = session.process;
  if (!processState || processState.child.stdin.destroyed) {
    throw new Error(`${session.provider} ACP process is not ready.`);
  }

  return await new Promise((resolve, reject) => {
    const id = String(processState.nextRequestId++);
    const timer = timeoutMs
      ? setTimeout(() => {
          processState.pendingRequests.delete(id);
          reject(new Error(`Timed out waiting for ${session.provider} ACP ${method}.`));
        }, timeoutMs)
      : null;
    processState.pendingRequests.set(id, {
      resolve,
      reject,
      timer,
    });
    processState.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      })}\n`,
      (error) => {
        if (!error) {
          return;
        }
        const pending = processState.pendingRequests.get(id);
        if (!pending) {
          return;
        }
        processState.pendingRequests.delete(id);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function ensureAcpProcess(session) {
  ensureProviderHomes(session.provider);
  const processState = session.process;
  if (processState && processState.child.exitCode === null) {
    return processState;
  }
  if (session.activePrompt) {
    throw new Error(`${session.provider} session ${session.sessionName} cannot restart while prompting.`);
  }

  const { command, args } = getAcpCommand(session.provider);
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: getProviderEnv(session.provider, session.model),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const nextProcessState = {
    child,
    stdoutBuffer: "",
    stderr: "",
    nextRequestId: 1,
    pendingRequests: new Map(),
  };
  session.process = nextProcessState;
  session.loadedSessionId = null;

  child.stdout.on("data", (chunk) => {
    if (session.process !== nextProcessState) {
      return;
    }
    nextProcessState.stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = nextProcessState.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = nextProcessState.stdoutBuffer.slice(0, newlineIndex).trim();
      nextProcessState.stdoutBuffer = nextProcessState.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const parseError = error instanceof Error
          ? error
          : new Error(`${session.provider} ACP emitted invalid JSON.`);
        const activePrompt = session.activePrompt;
        session.activePrompt = null;
        resetAcpProcess(session);
        if (activePrompt) {
          rejectAcpPrompt(activePrompt, parseError);
        }
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, "id")) {
        const requestId = String(message.id);
        const pending = nextProcessState.pendingRequests.get(requestId);
        if (!pending) {
          continue;
        }
        nextProcessState.pendingRequests.delete(requestId);
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
        } else {
          pending.resolve(message.result ?? null);
        }
        continue;
      }

      if (typeof message.method === "string") {
        handleAcpNotification(session, message);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    if (session.process !== nextProcessState) {
      return;
    }
    nextProcessState.stderr += chunk.toString("utf8");
    logStderr(`${session.provider} acp stderr: ${chunk.toString("utf8").trim()}`);
  });

  child.on("error", (error) => {
    if (session.process !== nextProcessState) {
      return;
    }
    for (const [requestId, pending] of nextProcessState.pendingRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      nextProcessState.pendingRequests.delete(requestId);
    }
    session.process = null;
    session.loadedSessionId = null;
    const activePrompt = session.activePrompt;
    session.activePrompt = null;
    if (activePrompt) {
      rejectAcpPrompt(activePrompt, error instanceof Error ? error : new Error(String(error)));
    }
  });

  child.on("exit", (code, signal) => {
    if (session.process !== nextProcessState) {
      return;
    }
    for (const [requestId, pending] of nextProcessState.pendingRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(
        new Error(
          nextProcessState.stderr.trim() ||
            `${session.provider} ACP exited before request completion (code=${code}, signal=${signal}).`,
        ),
      );
      nextProcessState.pendingRequests.delete(requestId);
    }
    session.process = null;
    session.loadedSessionId = null;
    const activePrompt = session.activePrompt;
    session.activePrompt = null;
    if (!activePrompt) {
      return;
    }
    if (activePrompt.cancelled) {
      resolveAcpPrompt(session, activePrompt, "cancelled");
      return;
    }
    rejectAcpPrompt(
      activePrompt,
      new Error(
        nextProcessState.stderr.trim() ||
          `${session.provider} ACP exited before prompt completion (code=${code}, signal=${signal}).`,
      ),
    );
  });

  await sendAcpRequest(session, "initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  return nextProcessState;
}

async function selectAcpModel(session) {
  const preferredModelId = maybeString(session.model);
  if (!preferredModelId || preferredModelId === "default") {
    return;
  }
  const nextModelId = resolvePreferredAcpModel(session.modelState, preferredModelId);
  if (!nextModelId) {
    throw new Error(
      `${session.provider} does not have a configured model for ${describeAcpModelPreference(preferredModelId)}.`,
    );
  }
  if (nextModelId === session.modelState?.currentModelId) {
    return;
  }

  if (session.provider === "pi") {
    await sendAcpRequest(session, "session/unstable_set_model", {
      sessionId: session.sessionId,
      modelId: nextModelId,
    });
    if (session.modelState) {
      session.modelState.currentModelId = nextModelId;
    }
    return;
  }

  const result = await sendAcpRequest(session, "session/set_config_option", {
    sessionId: session.sessionId,
    configId: "model",
    value: nextModelId,
  });
  session.modelState =
    extractAcpModelState(session.provider, result) ?? {
      availableModelIds: session.modelState?.availableModelIds ?? [nextModelId],
      currentModelId: nextModelId,
    };
}

async function ensureAcpSession(session) {
  await ensureAcpProcess(session);
  if (!session.sessionId) {
    const result = await sendAcpRequest(session, "session/new", {
      cwd: workspaceRoot,
    });
    session.sessionId = extractAcpSessionId(result);
    session.loadedSessionId = session.sessionId;
    session.modelState = extractAcpModelState(session.provider, result);
  } else if (session.loadedSessionId !== session.sessionId) {
    try {
      const result = await sendAcpRequest(session, "session/load", {
        sessionId: session.sessionId,
        cwd: workspaceRoot,
      });
      session.loadedSessionId = session.sessionId;
      session.modelState = extractAcpModelState(session.provider, result);
    } catch (error) {
      logStderr(
        `${session.provider} ACP failed to load ${session.sessionId}; starting a new session instead: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const result = await sendAcpRequest(session, "session/new", {
        cwd: workspaceRoot,
      });
      session.sessionId = extractAcpSessionId(result);
      session.loadedSessionId = session.sessionId;
      session.modelState = extractAcpModelState(session.provider, result);
    }
  }

  if (!session.sessionId) {
    throw new Error(`${session.provider} ACP did not return a session id.`);
  }

  await selectAcpModel(session);
  return session;
}

function hasActiveProviderPrompt(provider) {
  for (const session of sessions.values()) {
    if (session.provider === provider && session.activePrompt) {
      return true;
    }
  }
  return false;
}

function resetCodexForEnvChange() {
  codexAppServer.stop();
  for (const session of sessions.values()) {
    if (session.provider !== "codex") {
      continue;
    }
    session.serverGeneration = -1;
  }
}

function resetProviderProcessesForEnvChange(provider) {
  if (provider === "codex") {
    resetCodexForEnvChange();
    return;
  }

  if (provider === "claude") {
    for (const session of sessions.values()) {
      if (session.provider !== "claude") {
        continue;
      }
      if (session.process) {
        resetClaudeProcess(session);
      }
    }
    return;
  }

  for (const session of sessions.values()) {
    if (session.provider !== provider) {
      continue;
    }
    if (session.process) {
      resetAcpProcess(session);
    }
  }
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
  const processEnvChanged = applyConfiguredProcessEnv(
    provider,
    params.processEnv && typeof params.processEnv === "object" ? params.processEnv : {},
  );
  if (processEnvChanged) {
    if (hasActiveProviderPrompt(provider)) {
      throw new Error(
        `${provider} environment changed while a prompt was running. Try again after the active prompt finishes.`,
      );
    }
    resetProviderProcessesForEnvChange(provider);
  }
  const key = getSessionKey(provider, sessionName);
  let session = sessions.get(key) ?? null;
  if (!session) {
    session =
      provider === "codex"
        ? createCodexSession(sessionName, model, sessionId)
        : provider === "claude"
          ? createClaudeSession(sessionName, model, sessionId, Boolean(sessionId))
          : createAcpSession(provider, sessionName, model, sessionId);
    sessions.set(key, session);
  }
  const previousModel = session.model;
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

  if (provider === "claude") {
    ensureProviderHomes("claude");
    const claudeSession = /** @type {ClaudeSessionState} */ (session);
    if (claudeSession.process && previousModel !== model) {
      if (claudeSession.activePrompt) {
        throw new Error(`Claude session ${sessionName} cannot switch models while prompting.`);
      }
      resetClaudeProcess(claudeSession);
    }
    if (sessionId && claudeSession.sessionId !== sessionId) {
      if (claudeSession.activePrompt) {
        throw new Error(`Claude session ${sessionName} cannot switch session ids while prompting.`);
      }
      resetClaudeProcess(claudeSession);
      claudeSession.sessionId = sessionId;
      claudeSession.hasStarted = true;
    }
    return {
      sessionId: claudeSession.sessionId,
    };
  }

  const acpSession = /** @type {AcpSessionState} */ (session);
  if (sessionId && acpSession.sessionId !== sessionId) {
    if (acpSession.activePrompt) {
      throw new Error(`${provider} session ${sessionName} cannot switch session ids while prompting.`);
    }
    acpSession.sessionId = sessionId;
    acpSession.loadedSessionId = null;
  }
  if (previousModel !== model && acpSession.activePrompt) {
    throw new Error(`${provider} session ${sessionName} cannot switch models while prompting.`);
  }
  await ensureAcpSession(acpSession);
  return {
    sessionId: acpSession.sessionId,
  };
}

function createClaudeArgs(session) {
  const baseArgs = [
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--disallowedTools",
    "AskUserQuestion",
    "--permission-mode",
    "bypassPermissions",
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
  };
}

function createClaudeUserMessage(content) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: content,
        },
      ],
    },
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

function resetClaudeProcess(session) {
  const processState = session.process;
  session.process = null;
  if (!processState) {
    return;
  }
  for (const [requestId, pending] of processState.pendingControlRequests.entries()) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.reject(new Error("Claude process stopped before control request completed."));
    processState.pendingControlRequests.delete(requestId);
  }
  if (processState.child.exitCode === null) {
    processState.child.kill("SIGTERM");
  }
}

function rejectClaudePrompt(promptState, error) {
  for (const waiter of promptState.waiters) {
    waiter.reject(error);
  }
}

function resolveClaudePrompt(session, promptState, stopReason) {
  for (const waiter of promptState.waiters) {
    waiter.resolve({
      sessionId: session.sessionId,
      finalText: promptState.finalText,
      stopReason,
    });
  }
}

function handleClaudeProcessMessage(session, message) {
  if (
    message.type === "control_response" &&
    message.response &&
    typeof message.response === "object" &&
    typeof message.response.request_id === "string"
  ) {
    const pending = session.process?.pendingControlRequests.get(message.response.request_id);
    if (!pending) {
      return;
    }
    session.process?.pendingControlRequests.delete(message.response.request_id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (message.response.subtype === "success") {
      pending.resolve(message.response.response ?? null);
    } else {
      pending.reject(
        new Error(
          typeof message.response.error === "string"
            ? message.response.error
            : "Claude control request failed.",
        ),
      );
    }
    return;
  }
  if (typeof message.session_id === "string" && message.session_id.trim()) {
    session.sessionId = message.session_id.trim();
  }
  const activePrompt = session.activePrompt;
  if (activePrompt) {
    const delta = extractClaudeDeltaText(message);
    if (delta) {
      activePrompt.finalText += delta;
    }
  }
  emitClaudeRuntimeEvent(session, message);
  if (message.type !== "result" || !activePrompt) {
    return;
  }

  session.hasStarted = true;
  const interrupted =
    activePrompt.cancelled ||
    message.terminal_reason === "aborted_streaming" ||
    message.subtype === "error_during_execution";
  activePrompt.stopReason =
    interrupted
      ? "cancelled"
      : typeof message.stop_reason === "string"
        ? message.stop_reason
        : null;
  if (typeof message.result === "string") {
    activePrompt.finalText = message.result;
  }
  session.activePrompt = null;
  resolveClaudePrompt(session, activePrompt, activePrompt.stopReason);
}

async function sendClaudeControlRequest(session, subtype) {
  const processState = session.process;
  if (!processState || processState.child.stdin.destroyed) {
    throw new Error("Claude process is not ready.");
  }
  const requestId = randomUUID();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      processState.pendingControlRequests.delete(requestId);
      reject(new Error(`Claude control request ${subtype} timed out.`));
    }, 10_000);
    processState.pendingControlRequests.set(requestId, {
      resolve,
      reject,
      timer,
    });
    processState.child.stdin.write(
      `${JSON.stringify({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype,
        },
      })}\n`,
      (error) => {
        if (!error) {
          return;
        }
        const pending = processState.pendingControlRequests.get(requestId);
        if (!pending) {
          return;
        }
        processState.pendingControlRequests.delete(requestId);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function ensureClaudeProcess(session) {
  ensureProviderHomes("claude");
  const processState = session.process;
  if (processState) {
    if (processState.child.exitCode === null && processState.launchedModel === session.model) {
      return processState;
    }
    if (session.activePrompt) {
      throw new Error(`Claude session ${session.sessionName} cannot restart while prompting.`);
    }
    resetClaudeProcess(session);
  }

  const { command, args } = createClaudeArgs(session);
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: getProviderEnv("claude", session.model),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  /** @type {ClaudeProcessState} */
  const nextProcessState = {
    child,
    stdoutBuffer: "",
    stderr: "",
    launchedModel: session.model,
    pendingControlRequests: new Map(),
  };
  session.process = nextProcessState;

  child.stdout.on("data", (chunk) => {
    if (session.process !== nextProcessState) {
      return;
    }
    nextProcessState.stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = nextProcessState.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = nextProcessState.stdoutBuffer.slice(0, newlineIndex).trim();
      nextProcessState.stdoutBuffer = nextProcessState.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const parseError = error instanceof Error
          ? error
          : new Error(`Claude emitted invalid JSON: ${line}`);
        const activePrompt = session.activePrompt;
        session.activePrompt = null;
        resetClaudeProcess(session);
        if (activePrompt) {
          rejectClaudePrompt(activePrompt, parseError);
        }
        return;
      }
      handleClaudeProcessMessage(session, message);
    }
  });

  child.stderr.on("data", (chunk) => {
    if (session.process !== nextProcessState) {
      return;
    }
    nextProcessState.stderr += chunk.toString("utf8");
    logStderr(`claude stderr: ${chunk.toString("utf8").trim()}`);
  });

  child.on("error", (error) => {
    if (session.process !== nextProcessState) {
      return;
    }
    for (const [requestId, pending] of nextProcessState.pendingControlRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      nextProcessState.pendingControlRequests.delete(requestId);
    }
    session.process = null;
    const activePrompt = session.activePrompt;
    session.activePrompt = null;
    if (activePrompt) {
      rejectClaudePrompt(activePrompt, error instanceof Error ? error : new Error(String(error)));
    }
  });

  child.on("exit", (code, signal) => {
    if (session.process !== nextProcessState) {
      return;
    }
    for (const [requestId, pending] of nextProcessState.pendingControlRequests.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(
        new Error(
          nextProcessState.stderr.trim() ||
            `Claude exited before control request completion (code=${code}, signal=${signal}).`,
        ),
      );
      nextProcessState.pendingControlRequests.delete(requestId);
    }
    session.process = null;
    const activePrompt = session.activePrompt;
    session.activePrompt = null;
    if (!activePrompt) {
      return;
    }
    if (activePrompt.cancelled) {
      resolveClaudePrompt(session, activePrompt, "cancelled");
      return;
    }
    rejectClaudePrompt(
      activePrompt,
      new Error(
        nextProcessState.stderr.trim() ||
          `Claude exited before prompt completion (code=${code}, signal=${signal}).`,
      ),
    );
  });

  return nextProcessState;
}

async function promptClaudeSession(session, content) {
  const processState = await ensureClaudeProcess(session);
  return await new Promise((resolve, reject) => {
    const promptState = session.activePrompt ?? {
      finalText: "",
      stopReason: null,
      cancelled: false,
      waiters: [],
    };
    if (!session.activePrompt) {
      session.activePrompt = promptState;
    }
    promptState.waiters.push({ resolve, reject });
    const payload = `${JSON.stringify(createClaudeUserMessage(content))}\n`;
    processState.child.stdin.write(payload, (error) => {
      if (!error) {
        return;
      }
      const currentPrompt = session.activePrompt;
      session.activePrompt = null;
      if (currentPrompt) {
        rejectClaudePrompt(
          currentPrompt,
          error instanceof Error ? error : new Error(String(error)),
        );
      } else {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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

async function promptAcpSession(session, content) {
  await ensureAcpSession(session);
  if (session.activePrompt) {
    throw new Error(`${session.provider} session ${session.sessionName} is already prompting.`);
  }

  return await new Promise(async (resolve, reject) => {
    const promptState = {
      finalText: "",
      stopReason: null,
      cancelled: false,
      waiters: [{ resolve, reject }],
    };
    session.activePrompt = promptState;
    try {
      const result = await sendAcpRequest(
        session,
        "session/prompt",
        {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: content,
            },
          ],
        },
        0,
      );
      if (session.activePrompt !== promptState) {
        return;
      }
      const resultText = extractAcpTextContent(asRecord(result)?.content);
      if (resultText && !promptState.finalText) {
        promptState.finalText = resultText;
      }
      promptState.stopReason =
        extractAcpStopReason(result) ?? (promptState.cancelled ? "cancelled" : null);
      session.activePrompt = null;
      resolveAcpPrompt(session, promptState, promptState.stopReason);
    } catch (error) {
      if (session.activePrompt === promptState) {
        session.activePrompt = null;
        rejectAcpPrompt(promptState, error instanceof Error ? error : new Error(String(error)));
      }
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
  if (provider === "codex") {
    return await promptCodexSession(/** @type {CodexSessionState} */ (session), content);
  }
  return await promptAcpSession(/** @type {AcpSessionState} */ (session), content);
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
    if (claudeSession.activePrompt && claudeSession.process?.child.exitCode === null) {
      claudeSession.activePrompt.cancelled = true;
      await sendClaudeControlRequest(claudeSession, "interrupt");
    }
    return { ok: true };
  }

  if (provider === "pi" || provider === "opencode") {
    const acpSession = /** @type {AcpSessionState} */ (session);
    if (!acpSession.sessionId) {
      return { ok: true };
    }
    if (acpSession.activePrompt) {
      acpSession.activePrompt.cancelled = true;
    }
    await sendAcpRequest(acpSession, "session/cancel", {
      sessionId: acpSession.sessionId,
    });
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
    case "http.request":
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
ensureBundledGuestNodePackages();

const server = createNetServer(handleSocketConnection);
hostHttpServer = createHttpServer((request, response) => {
  void handleHttpBridgeRequest(request, response);
});

Promise.all([
  new Promise((resolve, reject) => {
    hostHttpServer.once("error", reject);
    hostHttpServer.listen(0, "127.0.0.1", () => {
      const address = hostHttpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Host HTTP bridge did not expose a TCP port."));
        return;
      }
      hostHttpBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  }),
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  }),
]).then(() => {
  writeEnvelope({
    type: "ready",
    protocolVersion: 2,
    socketPath,
    httpBaseUrl: hostHttpBaseUrl,
  });
}).catch((error) => {
  logStderr(
    `Failed to start guest bridges: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  shutdown();
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
    if (session.provider === "claude" && session.process?.child.exitCode === null) {
      session.process.child.kill("SIGTERM");
      continue;
    }
    if (
      (session.provider === "pi" || session.provider === "opencode") &&
      session.process?.child.exitCode === null
    ) {
      session.process.child.kill("SIGTERM");
    }
  }
  codexAppServer.stop();
  if (hostHttpServer) {
    hostHttpServer.close();
  }
  server.close(() => {
    process.exit(0);
  });
}

process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
