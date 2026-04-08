import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  const registerHostMcpServer = vi.fn();
  const unregisterHostMcpServer = vi.fn();
  const runtime: RuntimeManager = {
    getWorkspaceDirectory: () => "/workspace",
    getRuntimeDirectory: () => "/runtime",
    getThreadStateDirectory: (threadId: string) => `/runtime/thread-state/${threadId}`,
    getCachedStatus: () => ({
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    }),
    registerHostMcpServer,
    unregisterHostMcpServer,
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
    registerHostMcpServer,
    unregisterHostMcpServer,
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
    vi.spyOn(CamelAIExtensionHost.prototype, "refresh").mockResolvedValue(undefined);
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

  it("loads, installs, and removes persisted host MCP servers", () => {
    const serverDirectory = resolve(sandboxDataDir, "host-mcp", "servers");
    mkdirSync(serverDirectory, { recursive: true });
    writeFileSync(
      resolve(serverDirectory, "persisted-server.json"),
      `${JSON.stringify(
        {
          id: "persisted-server",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          cwd: "fixtures",
          env: {
            NODE_ENV: "test",
          },
          name: "Persisted Server",
          version: "1.2.3",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { runtime, registerHostMcpServer, unregisterHostMcpServer } =
      createRuntimeManagerStub();
    const service = new DesktopService(runtime);

    expect(registerHostMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "persisted-server",
      }),
    );
    expect(service.listInstalledHostMcpServers()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "persisted-server",
          cwd: "/workspace/fixtures",
        }),
      ]),
    );

    const installed = service.installStdioHostMcpServer(
      {
        id: "workspace-server",
        command: "node",
        args: ["scripts/mcp-server.js"],
        cwd: "tools",
        env: {
          FROM_TEST: "1",
        },
      },
      "/host/workspace",
    );

    expect(installed).toEqual(
      expect.objectContaining({
        id: "workspace-server",
        cwd: "/host/workspace/tools",
        replaced: false,
      }),
    );
    expect(registerHostMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "workspace-server",
      }),
    );
    expect(
      existsSync(resolve(serverDirectory, "workspace-server.json")),
    ).toBe(true);

    const remoteInstalled = service.installHttpHostMcpServer(
      {
        id: "remote-server",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: {
          "x-test": "1",
        },
      },
      "/host/workspace",
    );

    expect(remoteInstalled).toEqual(
      expect.objectContaining({
        id: "remote-server",
        oauth: expect.objectContaining({
          tokenEndpointAuthMethod: "none",
        }),
        transport: "streamable-http",
        url: "https://example.com/mcp",
        replaced: false,
      }),
    );
    expect(registerHostMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "remote-server",
      }),
    );
    expect(
      existsSync(resolve(serverDirectory, "remote-server.json")),
    ).toBe(true);
    const oauthDirectory = resolve(sandboxDataDir, "host-mcp", "oauth");
    mkdirSync(oauthDirectory, { recursive: true });
    writeFileSync(
      resolve(oauthDirectory, "remote-server.json"),
      `${JSON.stringify(
        {
          tokens: {
            access_token: "access-123",
            refresh_token: "refresh-123",
            token_type: "Bearer",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(
      existsSync(resolve(oauthDirectory, "remote-server.json")),
    ).toBe(true);

    expect(service.uninstallInstalledHostMcpServer("workspace-server")).toBe(true);
    expect(unregisterHostMcpServer).toHaveBeenCalledWith("workspace-server");
    expect(
      existsSync(resolve(serverDirectory, "workspace-server.json")),
    ).toBe(false);

    expect(service.uninstallInstalledHostMcpServer("remote-server")).toBe(true);
    expect(unregisterHostMcpServer).toHaveBeenCalledWith("remote-server");
    expect(
      existsSync(resolve(serverDirectory, "remote-server.json")),
    ).toBe(false);
    expect(
      existsSync(resolve(oauthDirectory, "remote-server.json")),
    ).toBe(false);
  });

  it("persists plugin enabled state changes and refreshes the extension host", async () => {
    vi.spyOn(CamelAIExtensionHost.prototype, "getSnapshot").mockReturnValue({
      views: [],
      panels: [],
      plugins: [
        {
          id: "user-plugin",
          name: "User Plugin",
          version: "0.1.0",
          description: null,
          source: "user",
          enabled: true,
          disableable: true,
          path: "/tmp/user-plugin",
          main: "/tmp/user-plugin/index.mjs",
          webviews: [],
          permissions: [],
          settings: null,
          compatibility: {
            currentApiVersion: 1,
            declaredApiVersion: 1,
            minApiVersion: 1,
            compatible: true,
            reason: null,
          },
          capabilities: {
            views: [],
            panels: [],
            commands: [],
            tools: [],
          },
          runtime: {
            activated: true,
            activationError: null,
            subscribedEvents: [],
            registeredViewIds: [],
            registeredPanelIds: [],
            registeredCommandIds: [],
            registeredToolIds: [],
          },
        },
      ],
    });

    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);

    service.handleClientEvent({
      type: "set_plugin_enabled",
      pluginId: "user-plugin",
      enabled: false,
    });

    await vi.waitFor(() => {
      const persisted = JSON.parse(
        readFileSync(resolve(sandboxDataDir, "state.json"), "utf8"),
      ) as {
        pluginEnabledById?: Record<string, boolean>;
      };
      expect(persisted.pluginEnabledById?.["user-plugin"]).toBe(false);
      expect(CamelAIExtensionHost.prototype.refresh).toHaveBeenCalled();
    });
  });
});
