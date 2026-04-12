import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPersistedHostSecret,
  setPersistedHostSecret,
} from "../desktop-container/backend/host-secrets";
import { DesktopService } from "../desktop-container/backend/service";
import { CamelAIExtensionHost } from "../desktop-container/backend/extensions/host";
import type {
  RuntimeManager,
  StreamContainerPromptOptions,
  StreamContainerPromptResult,
} from "../desktop-container/backend/container-runtime";
import type { DesktopServerEvent } from "../desktop/shared/protocol";

function createRuntimeManagerStub(
  options: {
    managedWorkspaceDirectory?: string;
    runtimeDirectory?: string;
  } = {},
) {
  const pendingPrompts: Array<{
    options: StreamContainerPromptOptions;
    resolve: (value: StreamContainerPromptResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  const registerHostMcpServer = vi.fn();
  const unregisterHostMcpServer = vi.fn();
  const setHostRpcMethodHandler = vi.fn();
  const managedWorkspaceDirectory =
    options.managedWorkspaceDirectory ?? "/managed-workspace";
  const runtimeDirectory = options.runtimeDirectory ?? "/runtime";
  const runtime: RuntimeManager = {
    getWorkspaceDirectory: () => "/workspace",
    getManagedWorkspaceDirectory: () => managedWorkspaceDirectory,
    getUserUploadsDirectory: () =>
      resolve(process.env.DESKTOP_DATA_DIR ?? tmpdir(), "transfers", "uploads"),
    getUserOutputsDirectory: () =>
      resolve(process.env.DESKTOP_DATA_DIR ?? tmpdir(), "transfers", "outputs"),
    getRuntimeDirectory: () => runtimeDirectory,
    getThreadStateDirectory: (threadId: string) => `${runtimeDirectory}/thread-state/${threadId}`,
    getCachedStatus: () => ({
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    }),
    registerHostMcpServer,
    unregisterHostMcpServer,
    setHostRpcMethodHandler,
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
    setHostRpcMethodHandler,
  };
}

async function waitFor<T>(assertion: () => T, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for test condition.");
}

function createPluginSnapshotRecord(options: {
  id: string;
  name: string;
  version: string;
  path: string;
  source?: "builtin" | "user";
  enabled?: boolean;
  disableable?: boolean;
}) {
  return {
    id: options.id,
    name: options.name,
    version: options.version,
    description: null,
    source: options.source ?? "user",
    enabled: options.enabled ?? true,
    disableable: options.disableable ?? true,
    path: options.path,
    main: resolve(options.path, "index.mjs"),
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
  };
}

describe("DesktopService", () => {
  let sandboxDataDir: string;
  let previousDataDir: string | undefined;
  let previousSecretStoreBackend: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.DESKTOP_DATA_DIR;
    previousSecretStoreBackend = process.env.ACON_SECRET_STORE_BACKEND;
    process.env.ACON_SECRET_STORE_BACKEND = "file";
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
    if (previousSecretStoreBackend === undefined) {
      delete process.env.ACON_SECRET_STORE_BACKEND;
    } else {
      process.env.ACON_SECRET_STORE_BACKEND = previousSecretStoreBackend;
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
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));

    service.handleClientEvent({
      type: "send_message",
      threadId,
      content: "second task",
    });

    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(2));
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

    await waitFor(() => {
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

  it("creates new threads inside the active group", () => {
    const threadId = "thread-1";
    writeFileSync(
      resolve(sandboxDataDir, "state.json"),
      JSON.stringify(
        {
          activeThreadId: threadId,
          activeViewId: null,
          provider: "claude",
          modelsByProvider: {
            claude: "sonnet",
          },
          threads: [
            {
              id: threadId,
              groupId: "group-1",
              provider: "claude",
              title: "Thread one",
              createdAt: 1,
              updatedAt: 1,
              lastMessagePreview: null,
              status: null,
              lane: null,
              archivedAt: null,
            },
          ],
          threadGroups: [
            {
              id: "group-1",
              title: "Group one",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          activeGroupId: "group-1",
          messagesByThread: {
            [threadId]: [],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);

    const snapshot = service.getSnapshot();
    expect(snapshot.threadGroups).toHaveLength(1);
    expect(snapshot.activeGroupId).toBe(snapshot.threadGroups[0]?.id ?? null);
    expect(snapshot.threads[0]?.groupId).toBe(snapshot.threadGroups[0]?.id);

    service.handleClientEvent({ type: "create_thread" });

    const nextSnapshot = service.getSnapshot();
    expect(nextSnapshot.threads).toHaveLength(2);
    expect(
      nextSnapshot.threads.every(
        (thread) => thread.groupId === nextSnapshot.threadGroups[0]?.id,
      ),
    ).toBe(true);
  });

  it("creates and selects groups independently from thread selection", () => {
    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);

    const initialSnapshot = service.getSnapshot();
    expect(initialSnapshot.threadGroups).toHaveLength(1);

    service.handleClientEvent({ type: "create_group", title: "Bugs" });
    const createdSnapshot = service.getSnapshot();
    const createdGroup = createdSnapshot.threadGroups.find(
      (group) => group.title === "Bugs",
    );

    expect(createdGroup).toBeTruthy();
    expect(createdSnapshot.activeGroupId).toBe(createdGroup?.id ?? null);

    service.handleClientEvent({
      type: "select_group",
      groupId: initialSnapshot.threadGroups[0]!.id,
    });

    const selectedSnapshot = service.getSnapshot();
    expect(selectedSnapshot.activeGroupId).toBe(initialSnapshot.threadGroups[0]!.id);
    expect(selectedSnapshot.activeThreadId).toBe(initialSnapshot.activeThreadId);
  });

  it("renames an existing group", () => {
    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const groupId = service.getSnapshot().threadGroups[0]!.id;

    service.handleClientEvent({
      type: "update_group",
      groupId,
      title: "Planning",
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.threadGroups.find((group) => group.id === groupId)?.title).toBe("Planning");
  });

  it("deletes a non-default group and moves its threads to the default group", () => {
    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const defaultGroupId = service.getSnapshot().threadGroups[0]!.id;

    service.handleClientEvent({ type: "create_group", title: "Bugs" });
    const createdGroupId = service
      .getSnapshot()
      .threadGroups.find((group) => group.title === "Bugs")!.id;

    service.handleClientEvent({
      type: "create_thread",
      groupId: createdGroupId,
    });
    const movedThreadId = service.getSnapshot().activeThreadId!;

    service.handleClientEvent({
      type: "delete_group",
      groupId: createdGroupId,
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.threadGroups.some((group) => group.id === createdGroupId)).toBe(false);
    expect(snapshot.threads.find((thread) => thread.id === movedThreadId)?.groupId).toBe(
      defaultGroupId,
    );
    expect(snapshot.activeGroupId).toBe(defaultGroupId);
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
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));

    service.handleClientEvent({
      type: "stop_thread",
      threadId,
    });

    await waitFor(() => expect(cancelPrompt).toHaveBeenCalledTimes(1));
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

    await waitFor(() => {
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
    await waitFor(() => expect(streamPrompt).toHaveBeenCalledTimes(1));

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

    await waitFor(() => {
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

  it("emits permission requests for host MCP mutations and resolves approvals", async () => {
    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const events: DesktopServerEvent[] = [];
    const unsubscribe = service.subscribe((event) => {
      events.push(event);
    });

    const pendingInstall = service.installStdioHostMcpServer(
      {
        id: "workspace-server",
        command: "node",
        args: ["scripts/mcp-server.js"],
      },
      {
        pluginId: "host-mcp-manager",
        harness: "codex",
        threadId: "thread-1",
        workspaceDirectory: "/workspace",
      },
    );

    const permissionEvent = await waitFor(() => {
      const match = events.find(
        (event): event is Extract<DesktopServerEvent, { type: "permission_request" }> =>
          event.type === "permission_request",
      );
      expect(match).toBeTruthy();
      return match!;
    });

    expect(permissionEvent.request).toEqual(
      expect.objectContaining({
        kind: "host_mcp_mutation",
        pluginId: "host-mcp-manager",
        harness: "codex",
        action: "create",
        serverId: "workspace-server",
        command: "node",
      }),
    );

    service.handleClientEvent({
      type: "respond_permission_request",
      requestId: permissionEvent.request.id,
      decision: "approve",
    });

    await expect(pendingInstall).resolves.toEqual(
      expect.objectContaining({
        id: "workspace-server",
        replaced: false,
      }),
    );
    unsubscribe();
  });

  it("prompts for a secret and stores it without exposing the value in the request", async () => {
    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const events: DesktopServerEvent[] = [];
    service.subscribe((event) => {
      events.push(event);
    });

    const pendingSecret = service.promptToStoreSecret(
      {
        secretRef: "linear-api-key",
        title: "Store Linear API key",
        message: "Enter the API key for the Linear MCP server.",
        fieldLabel: "API key",
      },
      {
        pluginId: "host-mcp-manager",
        harness: "codex",
        threadId: "thread-1",
      },
    );

    const permissionEvent = await waitFor(() => {
      const match = events.find(
        (event): event is Extract<DesktopServerEvent, { type: "permission_request" }> =>
          event.type === "permission_request" && event.request.kind === "secret_prompt",
      );
      expect(match).toBeTruthy();
      return match!;
    });

    expect(permissionEvent.request).toEqual(
      expect.objectContaining({
        kind: "secret_prompt",
        pluginId: "host-mcp-manager",
        secretRef: "linear-api-key",
        title: "Store Linear API key",
      }),
    );
    expect(JSON.stringify(permissionEvent.request)).not.toContain("test-secret-123");

    service.handleClientEvent({
      type: "respond_permission_request",
      requestId: permissionEvent.request.id,
      decision: "approve",
      secretValue: "test-secret-123",
    });

    await expect(pendingSecret).resolves.toEqual({
      secretRef: "linear-api-key",
    });
    expect(getPersistedHostSecret(sandboxDataDir, "linear-api-key")).toBe(
      "test-secret-123",
    );
  });

  it("requires approval before installing a workspace plugin bundle", async () => {
    const managedWorkspaceDirectory = resolve(
      sandboxDataDir,
      "workspaces",
      "default",
      "root",
    );
    const pluginDirectory = resolve(managedWorkspaceDirectory, "plugins", "todo-plugin");
    mkdirSync(pluginDirectory, { recursive: true });
    writeFileSync(
      resolve(pluginDirectory, "package.json"),
      JSON.stringify(
        {
          name: "@test/todo-plugin",
          version: "0.2.0",
          type: "module",
          camelai: {
            id: "todo-plugin",
            name: "Todo Plugin",
            main: "./index.mjs",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      resolve(pluginDirectory, "index.mjs"),
      "export default { activate() {} };",
      "utf8",
    );

    const { runtime } = createRuntimeManagerStub({
      managedWorkspaceDirectory,
    });
    const service = new DesktopService(runtime);

    const installPromise = service.installPluginFromWorkspace(
      {
        path: "plugins/todo-plugin",
      },
      {
        pluginId: "host-mcp-manager",
        harness: "codex",
        threadId: "thread-1",
        workspaceDirectory: "/workspace",
      },
    );

    const installRequest = await waitFor(() => {
      const request = service.getSnapshot().pendingPermissionRequest;
      expect(request).toEqual(
        expect.objectContaining({
          kind: "plugin_mutation",
          action: "install",
          targetPluginId: "todo-plugin",
          sourcePath: "plugins/todo-plugin",
        }),
      );
      return request!;
    });

    const installedPluginPath = resolve(sandboxDataDir, "plugins", "todo-plugin");
    expect(existsSync(installedPluginPath)).toBe(false);

    service.handleClientEvent({
      type: "respond_permission_request",
      requestId: installRequest.id,
      decision: "approve",
    });

    await expect(installPromise).resolves.toEqual({
      pluginId: "todo-plugin",
      pluginName: "Todo Plugin",
      version: "0.2.0",
      installPath: installedPluginPath,
      replaced: false,
    });
    expect(existsSync(resolve(installedPluginPath, "package.json"))).toBe(true);
    expect(CamelAIExtensionHost.prototype.refresh).toHaveBeenCalled();
  });

  it("reconciles declarative plugin agent skill assets for every provider on startup", async () => {
    const pluginDirectory = resolve(sandboxDataDir, "plugins", "declarative-assets-plugin");
    mkdirSync(resolve(pluginDirectory, "agent-assets", "skills", "authoring"), {
      recursive: true,
    });
    writeFileSync(
      resolve(pluginDirectory, "package.json"),
      JSON.stringify(
        {
          name: "@test/declarative-assets-plugin",
          version: "0.5.0",
          type: "module",
          camelai: {
            id: "declarative-assets-plugin",
            name: "Declarative Assets Plugin",
            main: "./index.mjs",
            agentAssets: {
              skills: "./agent-assets/skills",
              mcpServers: "./agent-assets/mcp.json",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(resolve(pluginDirectory, "index.mjs"), "export default { activate() {} };");
    writeFileSync(
      resolve(pluginDirectory, "agent-assets", "skills", "authoring", "SKILL.md"),
      "# Authoring\n",
      "utf8",
    );
    writeFileSync(
      resolve(pluginDirectory, "agent-assets", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            docs: {
              command: "npx",
              args: ["-y", "@test/docs-mcp"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    vi.spyOn(CamelAIExtensionHost.prototype, "getSnapshot").mockImplementation(() => ({
      views: [],
      panels: [],
      plugins: [
        createPluginSnapshotRecord({
          id: "declarative-assets-plugin",
          name: "Declarative Assets Plugin",
          version: "0.5.0",
          path: pluginDirectory,
        }),
      ],
    }));

    const runtimeDirectory = resolve(sandboxDataDir, "runtime");
    const { runtime } = createRuntimeManagerStub({
      runtimeDirectory,
    });
    new DesktopService(runtime);

    await waitFor(() => {
      const codexConfigPath = resolve(
        runtimeDirectory,
        "providers",
        "codex",
        "home",
        ".codex",
        "config.toml",
      );
      const claudeStatePath = resolve(
        runtimeDirectory,
        "providers",
        "claude",
        "home",
        ".claude.json",
      );
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "codex",
            "home",
            ".codex",
            "skills",
            "declarative-assets-plugin--authoring",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "claude",
            "home",
            ".claude",
            "skills",
            "declarative-assets-plugin--authoring",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "pi",
            "home",
            ".pi",
            "agent",
            "skills",
            "declarative-assets-plugin--authoring",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "opencode",
            "home",
            ".config",
            "opencode",
            "skills",
            "declarative-assets-plugin--authoring",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        readFileSync(
          resolve(runtimeDirectory, "providers", "codex", "home", ".codex", "config.toml"),
          "utf8",
        ),
      ).toContain('[mcp_servers."plugin.declarative-assets-plugin.docs"]');
      expect(
        JSON.parse(
          readFileSync(
            resolve(runtimeDirectory, "providers", "claude", "home", ".claude.json"),
            "utf8",
          ),
        ).projects["/workspace"].mcpServers,
      ).toEqual(
        expect.objectContaining({
          "plugin.declarative-assets-plugin.docs": expect.objectContaining({
            command: "npx",
            args: ["-y", "@test/docs-mcp"],
          }),
        }),
      );
    });
  });

  it("removes declarative plugin agent assets when the plugin is disabled", async () => {
    const pluginDirectory = resolve(sandboxDataDir, "plugins", "toggle-assets-plugin");
    mkdirSync(resolve(pluginDirectory, "agent-assets", "skills", "research"), {
      recursive: true,
    });
    writeFileSync(
      resolve(pluginDirectory, "package.json"),
      JSON.stringify(
        {
          name: "@test/toggle-assets-plugin",
          version: "0.6.0",
          type: "module",
          camelai: {
            id: "toggle-assets-plugin",
            name: "Toggle Assets Plugin",
            main: "./index.mjs",
            disableable: true,
            agentAssets: {
              skills: "./agent-assets/skills",
              mcpServers: "./agent-assets/mcp.json",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(resolve(pluginDirectory, "index.mjs"), "export default { activate() {} };");
    writeFileSync(
      resolve(pluginDirectory, "agent-assets", "skills", "research", "SKILL.md"),
      "# Research\n",
      "utf8",
    );
    writeFileSync(
      resolve(pluginDirectory, "agent-assets", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            remote: {
              transport: "streamable-http",
              url: "https://example.com/mcp",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    let pluginEnabled = true;
    vi.spyOn(CamelAIExtensionHost.prototype, "getSnapshot").mockImplementation(() => ({
      views: [],
      panels: [],
      plugins: [
        createPluginSnapshotRecord({
          id: "toggle-assets-plugin",
          name: "Toggle Assets Plugin",
          version: "0.6.0",
          path: pluginDirectory,
          enabled: pluginEnabled,
        }),
      ],
    }));

    const runtimeDirectory = resolve(sandboxDataDir, "runtime");
    const { runtime } = createRuntimeManagerStub({
      runtimeDirectory,
    });
    const service = new DesktopService(runtime);

    await waitFor(() => {
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "codex",
            "home",
            ".codex",
            "skills",
            "toggle-assets-plugin--research",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "claude",
            "home",
            ".claude",
            "skills",
            "toggle-assets-plugin--research",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "pi",
            "home",
            ".pi",
            "agent",
            "skills",
            "toggle-assets-plugin--research",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          resolve(
            runtimeDirectory,
            "providers",
            "opencode",
            "home",
            ".config",
            "opencode",
            "skills",
            "toggle-assets-plugin--research",
            "SKILL.md",
          ),
        ),
      ).toBe(true);
    });

    pluginEnabled = false;
    service.handleClientEvent({
      type: "set_plugin_enabled",
      pluginId: "toggle-assets-plugin",
      enabled: false,
    });

    await waitFor(() => {
      expect(CamelAIExtensionHost.prototype.refresh).toHaveBeenCalled();
      const persisted = JSON.parse(
        readFileSync(resolve(sandboxDataDir, "state.json"), "utf8"),
      ) as {
        pluginEnabledById?: Record<string, boolean>;
      };
      expect(persisted.pluginEnabledById?.["toggle-assets-plugin"]).toBe(false);
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    const codexConfigPath = resolve(
      runtimeDirectory,
      "providers",
      "codex",
      "home",
      ".codex",
      "config.toml",
    );
    const claudeStatePath = resolve(
      runtimeDirectory,
      "providers",
      "claude",
      "home",
      ".claude.json",
    );
    expect(
      existsSync(
        resolve(
          runtimeDirectory,
          "providers",
          "codex",
          "home",
          ".codex",
          "skills",
          "toggle-assets-plugin--research",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(
          runtimeDirectory,
          "providers",
          "claude",
          "home",
          ".claude",
          "skills",
          "toggle-assets-plugin--research",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(
          runtimeDirectory,
          "providers",
          "pi",
          "home",
          ".pi",
          "agent",
          "skills",
          "toggle-assets-plugin--research",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(
          runtimeDirectory,
          "providers",
          "opencode",
          "home",
          ".config",
          "opencode",
          "skills",
          "toggle-assets-plugin--research",
        ),
      ),
    ).toBe(false);
    if (existsSync(codexConfigPath)) {
      expect(readFileSync(codexConfigPath, "utf8")).not.toContain(
        '[mcp_servers."plugin.toggle-assets-plugin.remote"]',
      );
    }
    expect(
      JSON.parse(readFileSync(claudeStatePath, "utf8")).projects["/workspace"].mcpServers,
    ).toEqual({});
  });
  it("loads, installs, and removes persisted host MCP servers", async () => {
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

    const installed = await service.installStdioHostMcpServer(
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

    setPersistedHostSecret(
      sandboxDataDir,
      "remote-client-secret",
      "secret-123",
    );
    const remoteInstalled = await service.installHttpHostMcpServer(
      {
        id: "remote-server",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: {
          "x-test": "1",
        },
        oauth: {
          clientId: "client-123",
          clientSecretRef: "remote-client-secret",
          clientMetadataUrl: null,
          clientName: "Acon",
          clientUri: null,
          scope: "tools.read",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      },
      "/host/workspace",
    );

    expect(remoteInstalled).toEqual(
      expect.objectContaining({
        id: "remote-server",
        oauth: expect.objectContaining({
          tokenEndpointAuthMethod: "client_secret_post",
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
    expect(
      JSON.parse(
        readFileSync(resolve(serverDirectory, "remote-server.json"), "utf8"),
      ) as {
        oauth?: {
          clientSecretRef?: string | null;
        };
      },
    ).toEqual(
      expect.objectContaining({
        oauth: expect.objectContaining({
          clientSecretRef: "remote-client-secret",
        }),
      }),
    );
    expect(getPersistedHostSecret(sandboxDataDir, "remote-client-secret")).toBe(
      "secret-123",
    );

    expect(await service.uninstallInstalledHostMcpServer("workspace-server")).toBe(
      true,
    );
    expect(unregisterHostMcpServer).toHaveBeenCalledWith("workspace-server");
    expect(
      existsSync(resolve(serverDirectory, "workspace-server.json")),
    ).toBe(false);

    expect(await service.uninstallInstalledHostMcpServer("remote-server")).toBe(
      true,
    );
    expect(unregisterHostMcpServer).toHaveBeenCalledWith("remote-server");
    expect(
      existsSync(resolve(serverDirectory, "remote-server.json")),
    ).toBe(false);
    expect(getPersistedHostSecret(sandboxDataDir, "remote-client-secret")).toBe(
      null,
    );
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

    await waitFor(() => {
      const persisted = JSON.parse(
        readFileSync(resolve(sandboxDataDir, "state.json"), "utf8"),
      ) as {
        pluginEnabledById?: Record<string, boolean>;
      };
      expect(persisted.pluginEnabledById?.["user-plugin"]).toBe(false);
      expect(CamelAIExtensionHost.prototype.refresh).toHaveBeenCalled();
    });
  });

  it("requires approval before guest tools mutate the host MCP registry", async () => {
    const serverDirectory = resolve(sandboxDataDir, "host-mcp", "servers");
    const { runtime, registerHostMcpServer, unregisterHostMcpServer } =
      createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const permissionContext = {
      pluginId: "host-mcp-manager",
      harness: "codex" as const,
      threadId: "thread-1",
      workspaceDirectory: "/host/workspace",
    };

    const installPromise = service.installStdioHostMcpServer(
      {
        id: "workspace-server",
        command: "node",
        args: ["scripts/mcp-server.js"],
      },
      permissionContext,
    );

    const installRequest = await waitFor(() => {
      const request = service.getSnapshot().pendingPermissionRequest;
      expect(request).toEqual(
        expect.objectContaining({
          action: "create",
          serverId: "workspace-server",
          harness: "codex",
        }),
      );
      return request;
    });

    expect(registerHostMcpServer).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace-server" }),
    );
    expect(
      existsSync(resolve(serverDirectory, "workspace-server.json")),
    ).toBe(false);

    service.handleClientEvent({
      type: "respond_permission_request",
      requestId: installRequest.id,
      decision: "approve",
    });

    await expect(installPromise).resolves.toEqual(
      expect.objectContaining({
        id: "workspace-server",
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

    const uninstallPromise = service.uninstallInstalledHostMcpServer(
      "workspace-server",
      {
        pluginId: "host-mcp-manager",
        harness: "codex",
        threadId: "thread-1",
      },
    );

    const uninstallRequest = await waitFor(() => {
      const request = service.getSnapshot().pendingPermissionRequest;
      expect(request).toEqual(
        expect.objectContaining({
          action: "delete",
          serverId: "workspace-server",
          harness: "codex",
        }),
      );
      return request;
    });

    service.handleClientEvent({
      type: "respond_permission_request",
      requestId: uninstallRequest.id,
      decision: "deny",
    });

    await expect(uninstallPromise).rejects.toThrow(
      "User denied permission to delete host MCP server workspace-server.",
    );
    expect(unregisterHostMcpServer).not.toHaveBeenCalledWith("workspace-server");
    expect(
      existsSync(resolve(serverDirectory, "workspace-server.json")),
    ).toBe(true);
    expect(service.getSnapshot().pendingPermissionRequest).toBe(null);
  });

  it("resolves upload and output preview items against mounted transfer directories", () => {
    const { runtime } = createRuntimeManagerStub();
    const service = new DesktopService(runtime);
    const threadId = service.getSnapshot().threads[0]?.id ?? "";
    const uploadsDirectory = runtime.getUserUploadsDirectory();
    const outputsDirectory = runtime.getUserOutputsDirectory();

    mkdirSync(uploadsDirectory, { recursive: true });
    mkdirSync(outputsDirectory, { recursive: true });
    writeFileSync(resolve(uploadsDirectory, "input.csv"), "name\nacon\n", "utf8");
    writeFileSync(resolve(outputsDirectory, "report.xlsx"), "fake workbook", "utf8");

    service.handleClientEvent({
      type: "preview_set_items",
      threadId,
      items: [
        {
          kind: "file",
          source: "upload",
          path: "input.csv",
          filename: "input.csv",
        },
        {
          kind: "file",
          source: "output",
          path: "report.xlsx",
          filename: "report.xlsx",
        },
      ],
    });

    const previewItems =
      service.getSnapshot().threadPreviewStateById[threadId]?.items ?? [];
    expect(previewItems).toHaveLength(2);
    expect(previewItems[0]?.src).toContain("transfers/uploads/input.csv");
    expect(previewItems[1]?.src).toContain("transfers/outputs/report.xlsx");
  });
});
