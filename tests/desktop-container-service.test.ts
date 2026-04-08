import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopService } from "../desktop-container/backend/service";
import { CamelAIExtensionHost } from "../desktop-container/backend/extensions/host";
import type {
  RuntimeManager,
  StreamContainerPromptOptions,
  StreamContainerPromptResult,
} from "../desktop-container/backend/container-runtime";
import type { DesktopServerEvent } from "../desktop/shared/protocol";

function createRuntimeManagerStub() {
  const pendingPrompts: Array<{
    options: StreamContainerPromptOptions;
    resolve: (value: StreamContainerPromptResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  const runtime: RuntimeManager = {
    getWorkspaceDirectory: () => "/workspace",
    getRuntimeDirectory: () => "/runtime",
    getThreadStateDirectory: (threadId: string) => `/runtime/thread-state/${threadId}`,
    getCachedStatus: () => ({
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    }),
    registerHostMcpServer: () => {},
    unregisterHostMcpServer: () => {},
    dispose: () => {},
    ensureRuntime: vi.fn(async () => ({
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    })),
    cancelPrompt: vi.fn(async () => {}),
    streamPrompt: vi.fn((options: StreamContainerPromptOptions) =>
      new Promise<StreamContainerPromptResult>((resolve, reject) => {
        pendingPrompts.push({ options, resolve, reject });
      })),
  };

  return {
    runtime,
    pendingPrompts,
    streamPrompt: runtime.streamPrompt as ReturnType<typeof vi.fn>,
    cancelPrompt: runtime.cancelPrompt as ReturnType<typeof vi.fn>,
  };
}

describe("DesktopService", () => {
  let sandboxDataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.DESKTOP_DATA_DIR;
    sandboxDataDir = mkdtempSync(join(tmpdir(), "acon-service-test-"));
    process.env.DESKTOP_DATA_DIR = sandboxDataDir;

    vi.spyOn(CamelAIExtensionHost.prototype, "initialize").mockResolvedValue(undefined);
    vi.spyOn(CamelAIExtensionHost.prototype, "getSnapshot").mockReturnValue({
      views: [],
      panels: [],
      plugins: [],
    });
    vi.spyOn(CamelAIExtensionHost.prototype, "applyBeforePrompt").mockImplementation(
      async (_threadId: string, content: string) => ({
        cancelled: false,
        content,
      }),
    );
    vi.spyOn(CamelAIExtensionHost.prototype, "emit").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDataDir === undefined) {
      delete process.env.DESKTOP_DATA_DIR;
    } else {
      process.env.DESKTOP_DATA_DIR = previousDataDir;
    }
    rmSync(sandboxDataDir, { recursive: true, force: true });
  });

  it("forwards a follow-up message while a turn is already active", async () => {
    const { runtime, pendingPrompts, streamPrompt } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const threadId = service.getSnapshot().threads[0]?.id ?? "";
    const events: DesktopServerEvent[] = [];

    const unsubscribe = service.subscribe((event) => {
      events.push(event);
    });

    service.handleClientEvent({
      type: "send_message",
      threadId,
      content: "first task",
    });
    await vi.waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));

    service.handleClientEvent({
      type: "send_message",
      threadId,
      content: "second task",
    });

    await vi.waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(2));
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.threadId === threadId &&
          event.message.includes("active turn"),
      ),
    ).toBe(false);

    const firstPrompt = pendingPrompts.shift();
    expect(firstPrompt).toBeTruthy();
    firstPrompt?.options.onRuntimeEvent?.({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "first answer in progress",
          },
        },
      },
    });
    firstPrompt?.resolve({
      finalText: "first answer",
      model: "sonnet",
      sessionId: "session-1",
      stopReason: null,
    });

    await vi.waitFor(() => {
      const messages = service.getSnapshot().messagesByThread[threadId] ?? [];
      expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
      expect(
        messages.some(
          (message) => message.role === "user" && message.content === "second task",
        ),
      ).toBe(true);
      expect(
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.status === "done" &&
            JSON.stringify(message.content).includes("first answer"),
        ),
      ).toBe(true);
      expect(messages.every((message) => message.status !== "streaming")).toBe(true);
    });

    unsubscribe();
  });

  it("stops the active turn with runtime cancellation", async () => {
    const { runtime, pendingPrompts, streamPrompt, cancelPrompt } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const threadId = service.getSnapshot().threads[0]?.id ?? "";

    service.handleClientEvent({
      type: "send_message",
      threadId,
      content: "keep investigating",
    });
    await vi.waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));

    service.handleClientEvent({
      type: "stop_thread",
      threadId,
    });

    await vi.waitFor(() => expect(cancelPrompt).toHaveBeenCalledTimes(1));
    expect(cancelPrompt).toHaveBeenCalledWith({
      provider: expect.objectContaining({ id: "claude" }),
      threadId,
      model: "sonnet",
    });

    pendingPrompts.shift()?.resolve({
      finalText: "",
      model: "sonnet",
      sessionId: "session-1",
      stopReason: "cancelled",
    });

    await vi.waitFor(() => {
      const messages = service.getSnapshot().messagesByThread[threadId] ?? [];
      expect(
        messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content === "[Request interrupted by user]",
        ),
      ).toBe(true);
    });
  });

  it("persists provider session ids from ACP runtime events", async () => {
    const { runtime, pendingPrompts, streamPrompt } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const threadId = service.getSnapshot().threads[0]?.id ?? "";

    service.handleClientEvent({
      type: "send_message",
      threadId,
      content: "remember this session",
    });
    await vi.waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));

    const pending = pendingPrompts.shift();
    expect(pending).toBeTruthy();
    pending?.options.onRuntimeEvent?.({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acp-session-123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "ok",
          },
        },
      },
    });
    pending?.resolve({
      finalText: "ok",
      model: "sonnet",
      sessionId: "",
      stopReason: null,
    });

    await vi.waitFor(() => {
      const persisted = JSON.parse(
        readFileSync(resolve(sandboxDataDir, "state.json"), "utf8"),
      ) as {
        providerStateByThread?: Record<string, Record<string, { sessionId?: string | null }>>;
      };
      expect(
        persisted.providerStateByThread?.[threadId]?.claude?.sessionId,
      ).toBe("acp-session-123");
    });
  });
});
