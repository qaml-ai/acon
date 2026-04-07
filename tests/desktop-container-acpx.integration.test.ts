// @vitest-environment node

import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function getSessionIds(events: RuntimeEventRecord[]): string[] {
  return [...new Set(events.flatMap((record) => {
    const event = record.event as {
      params?: {
        sessionId?: unknown;
      };
    };
    return typeof event?.params?.sessionId === "string"
      ? [event.params.sessionId]
      : [];
  }))];
}

function getSharedContainerName(userDataDir: string): string {
  const runtimeDirectory = resolve(userDataDir, "runtime");
  const hash = createHash("sha1")
    .update(`${runtimeDirectory}:${ROOT_DIR}:shared`)
    .digest("hex")
    .slice(0, 12);
  return `acon-acpx-${hash}`;
}

function getSessionName(providerId: DesktopProvider, threadId: string): string {
  return `${providerId}-${threadId}`;
}

function readAcpSessionModel(
  userDataDir: string,
  providerId: DesktopProvider,
  threadId: string,
): string | null {
  const containerName = getSharedContainerName(userDataDir);
  const providerDataRoot = `/data/providers/${providerId}`;
  const providerHome = `${providerDataRoot}/home`;
  const providerEnv =
    providerId === "codex"
      ? ["--env", `CODEX_HOME=${providerHome}/.codex`]
      : ["--env", `CLAUDE_CONFIG_DIR=${providerHome}/.claude`];
  const result = spawnSync(
    CONTAINER_COMMAND,
    [
      "exec",
      "--workdir",
      "/workspace",
      "--env",
      `DESKTOP_DATA_ROOT=${providerDataRoot}`,
      "--env",
      `HOME=${providerHome}`,
      ...providerEnv,
      containerName,
      "sh",
      "-lc",
      `exec acpx --json-strict --format json --approve-all --cwd /workspace ${providerId} status --session ${getSessionName(providerId, threadId)}`,
    ],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `Failed to inspect ACPX session model for ${providerId}/${threadId}.`,
    );
  }

  const parsed = JSON.parse(result.stdout.trim()) as { model?: unknown };
  return typeof parsed.model === "string" ? parsed.model : null;
}

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

  constructor(providerId: DesktopProvider) {
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

integrationDescribe("desktop-container ACPX integration", () => {
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
    const provider = requireDesktopProvider(providerCase.id);
    const providerTest = provider.getAuthState().available ? it : it.skip;

    providerTest(
      `keeps one ${providerCase.label} ACPX session alive across two turns`,
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
          expect(
            firstTurn.runtimeEvents.some(
              (record) =>
                (record.event as { method?: unknown })?.method === "session/update",
            ),
          ).toBe(true);

          const firstSessionIds = getSessionIds(firstTurn.runtimeEvents);
          expect(firstSessionIds.length).toBeGreaterThan(0);
          if (providerCase.id === "claude") {
            expect(readAcpSessionModel(harness.userDataDir, "claude", threadId)).toBe("opus");
          }

          const secondTurn = await harness.sendMessageAndWait(
            threadId,
            "What exact token did I ask you to remember earlier in this same conversation? Reply with the token only.",
          );

          expect(secondTurn.message.status).toBe("done");
          expect(secondTurn.errorEvents).toHaveLength(0);
          expect(secondTurn.text).toContain(providerCase.token);

          const secondSessionIds = getSessionIds(secondTurn.runtimeEvents);
          expect(secondSessionIds).toContain(firstSessionIds[0]);
          expect(
            secondTurn.runtimeEvents.some(
              (record) =>
                (record.event as { method?: unknown })?.method === "session/update",
            ),
          ).toBe(true);

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
