// @vitest-environment node

import { createServer } from "node:http";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { requireDesktopProvider } from "../desktop-container/backend/providers";
import type {
  DesktopClientEvent,
  DesktopMessage,
  DesktopProvider,
  DesktopServerEvent,
  DesktopSnapshot,
} from "../desktop/shared/protocol";
import type { ContentBlock } from "../src/types";

const ROOT_DIR = resolve(process.cwd());
const INTEGRATION_TIMEOUT_MS = Number(
  process.env.DESKTOP_CONTAINER_INTEGRATION_TIMEOUT_MS || 420_000,
);
const RUN_INTEGRATION = process.env.RUN_DESKTOP_CONTAINER_INTEGRATION === "1";
const CONTAINER_COMMAND =
  process.env.DESKTOP_CONTAINER_BIN_PATH?.trim() || "container";
const CONTAINER_AVAILABLE =
  spawnSync(CONTAINER_COMMAND, ["--version"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  }).status === 0;
const SKIP_REASON = !RUN_INTEGRATION
  ? "RUN_DESKTOP_CONTAINER_INTEGRATION=1 is required."
  : !CONTAINER_AVAILABLE
    ? `Apple container CLI is unavailable at ${CONTAINER_COMMAND}.`
    : null;
const SHARED_CONTAINER_START_DETAIL = "Starting the shared agent container.";
const HOST_MCP_TEST_MODULE_PATH = resolve(
  ROOT_DIR,
  "tests/fixtures/host-mcp-test-module.ts",
);
const HOST_MCP_TEST_SERVER_ID = "integration-host-tools";
const HOST_MCP_STDIO_TEST_MODULE_PATH = resolve(
  ROOT_DIR,
  "tests/fixtures/host-mcp-stdio-test-module.ts",
);
const HOST_MCP_STDIO_TEST_SERVER_ID = "integration-stdio-host-tools";
const HOST_MCP_ERROR_TEST_MODULE_PATH = resolve(
  ROOT_DIR,
  "tests/fixtures/host-mcp-error-test-module.ts",
);
const HOST_MCP_ERROR_TEST_SERVER_ID = "integration-host-tools-error";
const CONTAINER_BRIDGE_CALL_SCRIPT = [
  'const { randomUUID } = require("node:crypto");',
  'const { createConnection } = require("node:net");',
  'const [socketPath, method, rawParams] = process.argv.slice(1);',
  'const requestId = randomUUID();',
  'let params = null;',
  'if (typeof rawParams === "string") {',
  '  params = JSON.parse(rawParams);',
  '}',
  'const socket = createConnection(socketPath);',
  'socket.setEncoding("utf8");',
  'socket.setTimeout(30000);',
  'let buffer = "";',
  'let settled = false;',
  'function fail(message) {',
  '  if (settled) return;',
  '  settled = true;',
  '  process.stderr.write(String(message) + "\\n");',
  '  socket.destroy();',
  '  process.exit(1);',
  '}',
  'socket.on("connect", () => {',
  '  socket.write(JSON.stringify({ id: requestId, method, params }) + "\\n");',
  '});',
  'socket.on("data", (chunk) => {',
  '  buffer += chunk;',
  '  while (true) {',
  '    const newlineIndex = buffer.indexOf("\\n");',
  '    if (newlineIndex === -1) break;',
  '    const line = buffer.slice(0, newlineIndex).trim();',
  '    buffer = buffer.slice(newlineIndex + 1);',
  '    if (!line) continue;',
  '    let message;',
  '    try {',
  '      message = JSON.parse(line);',
  '    } catch (error) {',
  '      fail(error instanceof Error ? error.message : String(error));',
  '      return;',
  '    }',
  '    if (message?.id !== requestId) continue;',
  '    if (message.error) {',
  '      fail(JSON.stringify(message.error));',
  '      return;',
  '    }',
  '    settled = true;',
  '    process.stdout.write(JSON.stringify(message.result ?? null) + "\\n");',
  '    socket.end();',
  '    process.exit(0);',
  '  }',
  '});',
  'socket.on("timeout", () => fail("Timed out waiting for " + method + "."));',
  'socket.on("close", () => {',
  '  if (!settled) fail("Connection closed before " + method + " completed.");',
  '});',
  'socket.on("error", (error) => fail(error instanceof Error ? error.message : String(error)));',
].join("\n");

type RuntimeStateRecord = {
  at: number;
  state: string;
  detail?: string | null;
  containerID?: string | null;
};

type RuntimeEventRecord = {
  at: number;
  threadId?: string;
  event: unknown;
};

type ErrorRecord = {
  at: number;
  threadId?: string;
  message: string;
};

function now(): number {
  return Date.now();
}

function extractContentText(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return extractContentText(block.content);
      }
      return "";
    })
    .join("")
    .trim();
}

function findLatestAssistant(messages: DesktopMessage[] = []): DesktopMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return messages[index];
    }
  }
  return null;
}

function seedDesktopState(
  userDataDir: string,
  providerId: DesktopProvider,
  model: string,
): void {
  const dataDir = resolve(userDataDir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    resolve(dataDir, "state.json"),
    JSON.stringify(
      {
        tabs: [],
        activeTabId: null,
        activeThreadId: null,
        activeViewId: null,
        provider: providerId,
        modelsByProvider: {
          [providerId]: model,
        },
        threadPanelStateById: {},
        providerStateByThread: {},
        threads: [],
        messagesByThread: {},
      },
      null,
      2,
    ),
    "utf8",
  );
}

function readPersistedDesktopState(userDataDir: string): {
  providerStateByThread?: Partial<Record<string, Partial<Record<DesktopProvider, { sessionId?: string | null }>>>>;
  modelsByProvider?: Partial<Record<DesktopProvider, string>>;
} {
  return JSON.parse(
    readFileSync(resolve(userDataDir, "data", "state.json"), "utf8"),
  ) as {
    providerStateByThread?: Partial<Record<string, Partial<Record<DesktopProvider, { sessionId?: string | null }>>>>;
    modelsByProvider?: Partial<Record<DesktopProvider, string>>;
  };
}

function getPersistedProviderSessionId(
  userDataDir: string,
  providerId: DesktopProvider,
  threadId: string,
): string | null {
  return (
    readPersistedDesktopState(userDataDir).providerStateByThread?.[threadId]?.[providerId]
      ?.sessionId ?? null
  );
}

function getSharedContainerName(userDataDir: string): string {
  const logPath = resolve(userDataDir, "data", "logs", "desktop-backend.log");
  if (!existsSync(logPath)) {
    throw new Error(`Desktop backend log not found at ${logPath}.`);
  }

  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        component?: unknown;
        event?: unknown;
        containerName?: unknown;
      };
      if (
        entry.component === "desktop-runtime" &&
        typeof entry.containerName === "string" &&
        typeof entry.event === "string" &&
        entry.event.startsWith("shared_container:")
      ) {
        return entry.containerName;
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  throw new Error(`Could not determine shared container name from ${logPath}.`);
}

function getSessionName(providerId: DesktopProvider, threadId: string): string {
  return `${providerId}-${threadId}`;
}

function inspectContainerStatus(containerName: string): string | null {
  const result = spawnSync(
    CONTAINER_COMMAND,
    ["inspect", containerName],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<{ status?: unknown }>;
    return typeof parsed[0]?.status === "string" ? parsed[0].status : null;
  } catch {
    return null;
  }
}

async function callContainerBridgeMethod<TResult>(
  userDataDir: string,
  providerId: DesktopProvider,
  method: string,
  params: unknown,
): Promise<TResult> {
  const containerName = getSharedContainerName(userDataDir);
  const providerDataRoot = `/data/providers/${providerId}`;
  const providerHome = `${providerDataRoot}/home`;
  return await new Promise<TResult>((resolvePromise, rejectPromise) => {
    const child = spawn(
      CONTAINER_COMMAND,
      [
        "exec",
        "--workdir",
        "/workspace",
        "--env",
        `DESKTOP_DATA_ROOT=${providerDataRoot}`,
        "--env",
        `HOME=${providerHome}`,
        "--env",
        "ACON_HOST_RPC_SOCKET=/data/host-rpc/bridge.sock",
        containerName,
        "node",
        "-e",
        CONTAINER_BRIDGE_CALL_SCRIPT,
        "/data/host-rpc/bridge.sock",
        method,
        JSON.stringify(params),
      ],
      {
        cwd: ROOT_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `Failed to call bridge method ${method}.`,
          ),
        );
        return;
      }

      try {
        resolvePromise(JSON.parse(stdout.trim()) as TResult);
      } catch (error) {
        rejectPromise(
          error instanceof Error
            ? error
            : new Error(`Bridge returned invalid JSON for ${method}.`),
        );
      }
    });
  });
}

type ContainerCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

async function runContainerCommandRaw(
  userDataDir: string,
  providerId: DesktopProvider,
  command: string[],
): Promise<ContainerCommandResult> {
  const containerName = getSharedContainerName(userDataDir);
  const providerDataRoot = `/data/providers/${providerId}`;
  const providerHome = `${providerDataRoot}/home`;

  return await new Promise<ContainerCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(
      CONTAINER_COMMAND,
      [
        "exec",
        "--workdir",
        "/workspace",
        "--env",
        `DESKTOP_DATA_ROOT=${providerDataRoot}`,
        "--env",
        `HOME=${providerHome}`,
        "--env",
        "ACON_HOST_RPC_SOCKET=/data/host-rpc/bridge.sock",
        containerName,
        ...command,
      ],
      {
        cwd: ROOT_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      resolvePromise({
        code: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

async function runContainerCommand(
  userDataDir: string,
  providerId: DesktopProvider,
  command: string[],
): Promise<Omit<ContainerCommandResult, "code">> {
  const result = await runContainerCommandRaw(userDataDir, providerId, command);
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Container command failed: ${command.join(" ")}`,
    );
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function withContainerHostMcpClient<T>(
  userDataDir: string,
  providerId: DesktopProvider,
  serverId: string,
  run: (client: Client, transport: StdioClientTransport) => Promise<T>,
): Promise<T> {
  const containerName = getSharedContainerName(userDataDir);
  const providerDataRoot = `/data/providers/${providerId}`;
  const providerHome = `${providerDataRoot}/home`;
  const transport = new StdioClientTransport({
    command: CONTAINER_COMMAND,
    args: [
      "exec",
      "--interactive",
      "--workdir",
      "/workspace",
      "--env",
      `DESKTOP_DATA_ROOT=${providerDataRoot}`,
      "--env",
      `HOME=${providerHome}`,
      "--env",
      "ACON_HOST_RPC_SOCKET=/data/host-rpc/bridge.sock",
      containerName,
      "acon-mcp",
      serverId,
    ],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "acon-integration-client",
    version: "1.0.0",
  });

  const stderrChunks: string[] = [];
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  try {
    await client.connect(transport);
    return await run(client, transport);
  } catch (error) {
    const stderr = stderrChunks.join("").trim();
    if (!stderr) {
      throw error;
    }

    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ${stderr}`,
    );
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
}

async function withHostLocalRpcTestServer<T>(
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          method: request.method,
          url: request.url,
          body,
        }),
      );
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Host RPC test server did not expose a TCP port.");
    }

    return await run(`http://127.0.0.1:${address.port}/bridge-test`);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
  }
}

async function withHostStreamingRpcTestServer<T>(
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/plain");
    response.write("x".repeat(4096));

    const interval = setInterval(() => {
      response.write("y".repeat(4096));
    }, 50);

    response.on("close", () => {
      clearInterval(interval);
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Host RPC streaming test server did not expose a TCP port.");
    }

    return await run(`http://127.0.0.1:${address.port}/bridge-stream`);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
  }
}

type DesktopBackendHarnessOptions = {
  hostMcpModulePath?: string;
};

class DesktopBackendHarness {
  readonly userDataDir: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly runtimeStates: RuntimeStateRecord[] = [];
  readonly runtimeEvents: RuntimeEventRecord[] = [];
  readonly errors: ErrorRecord[] = [];
  readonly diagnostics: unknown[] = [];
  snapshot: DesktopSnapshot | null = null;
  stderr = "";

  private stdoutBuffer = "";
  private exited = false;
  private exitError: Error | null = null;

  constructor(
    providerId: DesktopProvider,
    options: DesktopBackendHarnessOptions = {},
  ) {
    const provider = requireDesktopProvider(providerId);
    this.userDataDir = mkdtempSync(
      join(tmpdir(), `acon-${provider.id}-integration-`),
    );
    seedDesktopState(
      this.userDataDir,
      provider.id,
      provider.getDefaultModel(),
    );
    this.child = spawn(
      "node",
      ["--import", "tsx/esm", "desktop-container/backend/server.ts"],
      {
        cwd: ROOT_DIR,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          DESKTOP_BACKEND_TRANSPORT: "stdio",
          ...(options.hostMcpModulePath
            ? {
                DESKTOP_HOST_MCP_MODULE: options.hostMcpModulePath,
              }
            : {}),
          DESKTOP_CONTAINER_WORKSPACE_DIR:
            process.env.DESKTOP_CONTAINER_WORKSPACE_DIR || ROOT_DIR,
          DESKTOP_CONTAINER_USER_DATA_DIR: this.userDataDir,
          DESKTOP_USER_DATA_DIR: this.userDataDir,
          DESKTOP_DATA_DIR: resolve(this.userDataDir, "data"),
          DESKTOP_RUNTIME_DIR: resolve(this.userDataDir, "runtime"),
        },
      },
    );

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk;
      while (true) {
        const newlineIndex = this.stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        let event: DesktopServerEvent;
        try {
          event = JSON.parse(line) as DesktopServerEvent;
        } catch (error) {
          this.exitError = new Error(
            `Failed to parse backend output: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }

        if (event.type === "snapshot") {
          this.snapshot = event.snapshot;
          this.runtimeStates.push({
            at: now(),
            state: event.snapshot.runtimeStatus.state,
            detail: event.snapshot.runtimeStatus.detail,
            containerID: event.snapshot.runtimeStatus.containerID ?? null,
          });
          continue;
        }

        if (event.type === "runtime_event") {
          this.runtimeEvents.push({
            at: now(),
            threadId: event.threadId,
            event: event.event,
          });
          continue;
        }

        if (event.type === "diagnostic") {
          this.diagnostics.push(event.diagnostic);
          continue;
        }

        if (event.type === "error") {
          this.errors.push({
            at: now(),
            threadId: event.threadId,
            message: event.message,
          });
        }
      }
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (code === 0 || signal === "SIGTERM") {
        return;
      }
      this.exitError = new Error(
        `Backend exited unexpectedly (code=${code}, signal=${signal}). ${this.stderr.trim()}`,
      );
    });
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        this.child.once("exit", () => resolvePromise());
      });
    }
    rmSync(this.userDataDir, { force: true, recursive: true });
  }

  async terminate(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.child.exitCode !== null) {
      return;
    }

    this.child.kill(signal);
    await new Promise<void>((resolvePromise) => {
      this.child.once("exit", () => resolvePromise());
    });
  }

  send(event: DesktopClientEvent): void {
    this.child.stdin.write(`${JSON.stringify(event)}\n`);
  }

  async waitFor<T>(
    label: string,
    selector: () => T | null | undefined,
    timeoutMs = INTEGRATION_TIMEOUT_MS,
  ): Promise<T> {
    const startedAt = now();

    while (now() - startedAt < timeoutMs) {
      if (this.exitError) {
        throw this.exitError;
      }
      const result = selector();
      if (result !== null && result !== undefined) {
        return result;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }

    const errorMessage = this.errors.at(-1)?.message;
    throw new Error(
      `Timed out waiting for ${label}.${errorMessage ? ` Last backend error: ${errorMessage}` : ""}${
        this.exited ? " Backend exited." : ""
      }`,
    );
  }

  async waitForActiveThread(): Promise<string> {
    return this.waitFor("active thread", () => this.snapshot?.activeThreadId);
  }

  async createThreadAndWait(title = "New thread"): Promise<string> {
    const existingThreadIds = new Set(
      (this.snapshot?.threads ?? []).map((thread) => thread.id),
    );
    this.send({
      type: "create_thread",
      title,
    });
    return this.waitFor("new thread", () => {
      const activeThreadId = this.snapshot?.activeThreadId;
      if (!activeThreadId || existingThreadIds.has(activeThreadId)) {
        return null;
      }
      return activeThreadId;
    });
  }

  async waitForProvider(providerId: DesktopProvider): Promise<void> {
    await this.waitFor(`provider ${providerId}`, () => {
      const snapshot = this.snapshot;
      if (!snapshot || !snapshot.activeThreadId) {
        return null;
      }
      const activeThread = snapshot.threads.find(
        (thread) => thread.id === snapshot.activeThreadId,
      );
      if (
        snapshot.provider === providerId &&
        activeThread?.provider === providerId
      ) {
        return true;
      }
      return null;
    });
  }

  async waitForModel(model: string): Promise<void> {
    await this.waitFor(`model ${model}`, () => {
      if (this.snapshot?.model === model) {
        return true;
      }
      return null;
    });
  }

  async waitForRuntimeReady(providerId: DesktopProvider): Promise<void> {
    const provider = requireDesktopProvider(providerId);
    await this.waitFor(`${provider.label} runtime ready`, () => {
      const snapshot = this.snapshot;
      if (
        snapshot?.provider === providerId &&
        snapshot.runtimeStatus.state === "running"
      ) {
        return true;
      }
      if (snapshot?.runtimeStatus.state === "error") {
        throw new Error(snapshot.runtimeStatus.detail || "Runtime error.");
      }
      return null;
    });
  }

  async sendMessageAndWait(threadId: string, content: string): Promise<{
    message: DesktopMessage;
    text: string;
    runtimeEvents: RuntimeEventRecord[];
    runtimeStates: RuntimeStateRecord[];
    errorEvents: ErrorRecord[];
  }> {
    const baselineAssistantId =
      findLatestAssistant(this.snapshot?.messagesByThread?.[threadId] ?? [])?.id ?? null;
    const runtimeEventStart = this.runtimeEvents.length;
    const runtimeStateStart = this.runtimeStates.length;
    const errorStart = this.errors.length;

    this.send({
      type: "send_message",
      threadId,
      content,
    });

    const message = await this.waitFor(`assistant completion for ${threadId}`, () => {
      const latestAssistant = findLatestAssistant(
        this.snapshot?.messagesByThread?.[threadId] ?? [],
      );
      if (!latestAssistant || latestAssistant.id === baselineAssistantId) {
        return null;
      }
      if (latestAssistant.status === "done" || latestAssistant.status === "error") {
        return latestAssistant;
      }
      return null;
    });

    return {
      message,
      text: extractContentText(message.content),
      runtimeEvents: this.runtimeEvents.slice(runtimeEventStart),
      runtimeStates: this.runtimeStates.slice(runtimeStateStart),
      errorEvents: this.errors.slice(errorStart),
    };
  }
}

const integrationDescribe = SKIP_REASON ? describe.skip : describe;

integrationDescribe("desktop-container agent runtime integration", () => {
  afterEach(() => {
    // No shared global cleanup. Each test owns its harness lifecycle.
  });

  const providerCases = [
    {
      id: "claude" as const,
      label: "Claude",
      token: "CLAUDE_SESSION_TOKEN_4729",
    },
    {
      id: "codex" as const,
      label: "Codex",
      token: "CODEX_SESSION_TOKEN_5813",
    },
  ];

  for (const providerCase of providerCases) {
    it(
      `shows ${providerCase.label} container MCP help and discovery output`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id, {
          hostMcpModulePath: HOST_MCP_TEST_MODULE_PATH,
        });

        try {
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          await harness.waitForRuntimeReady(providerCase.id);

          const helpResult = await runContainerCommand(
            harness.userDataDir,
            providerCase.id,
            ["acon-mcp", "--help"],
          );
          expect(helpResult.stderr.trim()).toBe("");
          expect(helpResult.stdout).toContain("Expose host MCP servers inside the container.");
          expect(helpResult.stdout).toContain("acon-mcp servers [--json]");
          expect(helpResult.stdout).toContain("acon-mcp tools <server-id> [--json]");

          const serversResult = await runContainerCommand(
            harness.userDataDir,
            providerCase.id,
            ["acon-mcp", "servers"],
          );
          expect(serversResult.stdout.trim().split("\n")).toContain(HOST_MCP_TEST_SERVER_ID);

          const toolsTextResult = await runContainerCommand(
            harness.userDataDir,
            providerCase.id,
            ["acon-mcp", "tools", HOST_MCP_TEST_SERVER_ID],
          );
          expect(toolsTextResult.stdout).toContain(
            "host_echo - Echo a string via the host MCP registry.",
          );

          const toolsResult = await runContainerCommand(
            harness.userDataDir,
            providerCase.id,
            ["acon-mcp", "tools", HOST_MCP_TEST_SERVER_ID, "--json"],
          );
          const tools = JSON.parse(toolsResult.stdout) as Array<{
            name?: string;
            description?: string;
          }>;
          expect(tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "host_echo",
                description: "Echo a string via the host MCP registry.",
              }),
            ]),
          );
        } finally {
          await harness.dispose();
        }
      },
    );
  }

  for (const providerCase of providerCases) {
    it(
      `reports ${providerCase.label} host MCP tools/list failures instead of treating them as empty`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id, {
          hostMcpModulePath: HOST_MCP_ERROR_TEST_MODULE_PATH,
        });

        try {
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          await harness.waitForRuntimeReady(providerCase.id);

          const toolsResult = await runContainerCommandRaw(
            harness.userDataDir,
            providerCase.id,
            ["acon-mcp", "tools", HOST_MCP_ERROR_TEST_SERVER_ID],
          );
          expect(toolsResult.code).not.toBe(0);
          expect(toolsResult.stdout).not.toContain("No tools are registered");
          expect(toolsResult.stderr).toContain(
            "Host MCP tools/list failed intentionally for integration testing.",
          );
        } finally {
          await harness.dispose();
        }
      },
    );
  }

  for (const providerCase of providerCases) {
    it(
      `routes ${providerCase.label} container RPC calls over the host RPC socket to a host-only loopback HTTP service`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id);

        try {
          const threadId = await harness.waitForActiveThread();
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          await harness.waitForRuntimeReady(providerCase.id);

          const pingResult = await callContainerBridgeMethod<{
            ok: boolean;
            params?: {
              threadId?: string;
            };
          }>(harness.userDataDir, providerCase.id, "ping", { threadId });
          expect(pingResult.ok).toBe(true);
          expect(pingResult.params?.threadId).toBe(threadId);

          await withHostLocalRpcTestServer(async (url) => {
            const result = await callContainerBridgeMethod<{
              ok: boolean;
              status: number;
              body: string;
              url: string;
              truncated: boolean;
            }>(harness.userDataDir, providerCase.id, "fetch", {
              url,
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify({
                provider: providerCase.id,
                token: providerCase.token,
              }),
              timeoutMs: 5000,
            });

            expect(result.ok).toBe(true);
            expect(result.status).toBe(200);
            expect(result.truncated).toBe(false);

            const responseBody = JSON.parse(result.body) as {
              method?: string;
              url?: string;
              body?: string;
            };
            expect(responseBody.method).toBe("POST");
            expect(responseBody.url).toBe("/bridge-test");
            expect(responseBody.body).toContain(providerCase.token);
          });
        } finally {
          await harness.dispose();
        }
      },
    );
  }

  for (const providerCase of providerCases) {
    it(
      `returns truncated ${providerCase.label} host fetch results without waiting for a streaming response to end`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id);

        try {
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          await harness.waitForRuntimeReady(providerCase.id);

          await withHostStreamingRpcTestServer(async (url) => {
            const startedAt = Date.now();
            const result = await callContainerBridgeMethod<{
              ok: boolean;
              status: number;
              body: string;
              url: string;
              truncated: boolean;
            }>(harness.userDataDir, providerCase.id, "fetch", {
              url,
              timeoutMs: 5000,
              maxBodyBytes: 1024,
            });
            const elapsedMs = Date.now() - startedAt;

            expect(result.ok).toBe(true);
            expect(result.status).toBe(200);
            expect(result.truncated).toBe(true);
            expect(Buffer.byteLength(result.body, "utf8")).toBe(1024);
            expect(elapsedMs).toBeLessThan(4500);
          });
        } finally {
          await harness.dispose();
        }
      },
    );
  }

  for (const providerCase of providerCases) {
    it(
      `exposes ${providerCase.label} host MCP servers inside the container over the host RPC socket`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id, {
          hostMcpModulePath: HOST_MCP_TEST_MODULE_PATH,
        });

        try {
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          await harness.waitForRuntimeReady(providerCase.id);

          await withContainerHostMcpClient(
            harness.userDataDir,
            providerCase.id,
            HOST_MCP_TEST_SERVER_ID,
            async (client) => {
              const toolList = await client.listTools();
              expect(toolList.tools.map((tool) => tool.name)).toContain("host_echo");

              const result = await client.callTool({
                name: "host_echo",
                arguments: {
                  provider: providerCase.id,
                  text: providerCase.token,
                },
              });

              expect(result.isError).not.toBe(true);
              expect(result.structuredContent).toEqual({
                echoedText: providerCase.token,
                provider: providerCase.id,
              });

              const firstContent = result.content[0];
              expect(firstContent?.type).toBe("text");
              expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
                providerCase.token,
              );
            },
          );
        } finally {
          await harness.dispose();
        }
      },
    );
  }

  for (const providerCase of providerCases) {
    it(
      `exposes ${providerCase.label} host stdio MCP servers inside the container over the host RPC socket`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id, {
          hostMcpModulePath: HOST_MCP_STDIO_TEST_MODULE_PATH,
        });

        try {
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          await harness.waitForRuntimeReady(providerCase.id);

          await withContainerHostMcpClient(
            harness.userDataDir,
            providerCase.id,
            HOST_MCP_STDIO_TEST_SERVER_ID,
            async (client) => {
              const toolList = await client.listTools();
              expect(toolList.tools.map((tool) => tool.name)).toContain("stdio_echo");

              const result = await client.callTool({
                name: "stdio_echo",
                arguments: {
                  provider: providerCase.id,
                  text: providerCase.token,
                },
              });

              expect(result.isError).not.toBe(true);
              expect(result.structuredContent).toEqual({
                echoedText: providerCase.token,
                provider: providerCase.id,
                transport: "stdio",
              });

              const firstContent = result.content[0];
              expect(firstContent?.type).toBe("text");
              expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
                providerCase.token,
              );
              expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
                "stdio",
              );
            },
          );
        } finally {
          await harness.dispose();
        }
      },
    );
  }

  for (const providerCase of providerCases) {
    it(
      `stops the shared ${providerCase.label} container when the backend exits`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id);

        try {
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          await harness.waitForRuntimeReady(providerCase.id);

          const containerName = getSharedContainerName(harness.userDataDir);
          expect(inspectContainerStatus(containerName)).toBe("running");

          await harness.terminate("SIGTERM");

          const startedAt = now();
          while (now() - startedAt < 15_000) {
            const status = inspectContainerStatus(containerName);
            if (status !== "running") {
              expect(status === null || status === "stopped").toBe(true);
              return;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
          }

          throw new Error(
            `Container ${containerName} was still running after backend exit.`,
          );
        } finally {
          await harness.dispose();
        }
      },
    );
  }

  for (const providerCase of providerCases) {
    const provider = requireDesktopProvider(providerCase.id);
    const providerTest = provider.getAuthState().available ? it : it.skip;

    providerTest(
      `keeps one ${providerCase.label} provider session alive across two turns`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id);

        try {
          const threadId = await harness.waitForActiveThread();
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          if (providerCase.id === "claude") {
            harness.send({
              type: "set_model",
              model: "opus",
            });
            await harness.waitForModel("opus");
          }
          await harness.waitForRuntimeReady(providerCase.id);

          const firstTurn = await harness.sendMessageAndWait(
            threadId,
            `Remember this exact token for later in this conversation: ${providerCase.token}. Reply with STORED and nothing else.`,
          );

          expect(firstTurn.message.status).toBe("done");
          expect(firstTurn.errorEvents).toHaveLength(0);
          expect(/stored/i.test(firstTurn.text)).toBe(true);
          expect(firstTurn.runtimeEvents.length).toBeGreaterThan(0);
          const firstSessionId = getPersistedProviderSessionId(
            harness.userDataDir,
            providerCase.id,
            threadId,
          );
          expect(firstSessionId).toBeTruthy();

          const secondTurn = await harness.sendMessageAndWait(
            threadId,
            "What exact token did I ask you to remember earlier in this same conversation? Reply with the token only.",
          );

          expect(secondTurn.message.status).toBe("done");
          expect(secondTurn.errorEvents).toHaveLength(0);
          expect(secondTurn.text).toContain(providerCase.token);

          expect(secondTurn.runtimeEvents.length).toBeGreaterThan(0);
          expect(
            getPersistedProviderSessionId(
              harness.userDataDir,
              providerCase.id,
              threadId,
            ),
          ).toBe(firstSessionId);

          const containerStartCount = harness.runtimeStates.filter(
            (entry) => entry.detail === SHARED_CONTAINER_START_DETAIL,
          ).length;
          expect(containerStartCount).toBe(1);
        } finally {
          await harness.dispose();
        }
      },
    );

    providerTest(
      `reuses the shared container across two ${providerCase.label} chats`,
      { timeout: INTEGRATION_TIMEOUT_MS },
      async () => {
        const harness = new DesktopBackendHarness(providerCase.id);

        try {
          const firstThreadId = await harness.waitForActiveThread();
          harness.send({
            type: "set_provider",
            provider: providerCase.id,
          });
          await harness.waitForProvider(providerCase.id);
          if (providerCase.id === "claude") {
            harness.send({
              type: "set_model",
              model: "opus",
            });
            await harness.waitForModel("opus");
          }
          await harness.waitForRuntimeReady(providerCase.id);

          const firstTurn = await harness.sendMessageAndWait(
            firstThreadId,
            "Reply with THREAD_ONE and nothing else.",
          );
          expect(firstTurn.message.status).toBe("done");
          expect(firstTurn.errorEvents).toHaveLength(0);
          expect(firstTurn.text).toContain("THREAD_ONE");

          const secondThreadId = await harness.createThreadAndWait("Second chat");
          await harness.waitForProvider(providerCase.id);

          const secondTurn = await harness.sendMessageAndWait(
            secondThreadId,
            "Reply with THREAD_TWO and nothing else.",
          );
          expect(secondTurn.message.status).toBe("done");
          expect(secondTurn.errorEvents).toHaveLength(0);
          expect(secondTurn.text).toContain("THREAD_TWO");

          const containerStartCount = harness.runtimeStates.filter(
            (entry) => entry.detail === SHARED_CONTAINER_START_DETAIL,
          ).length;
          expect(containerStartCount).toBe(1);

          const startedContainerIds = [...new Set(
            harness.runtimeStates
              .filter((entry) => entry.detail === SHARED_CONTAINER_START_DETAIL)
              .map((entry) => entry.containerID)
              .filter((value): value is string => Boolean(value)),
          )];
          expect(startedContainerIds).toHaveLength(1);
        } finally {
          await harness.dispose();
        }
      },
    );
  }
});
