import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopStore } from "./store";
import { logDesktop } from "../../desktop/backend/log";
import type {
  DesktopClientEvent,
  DesktopPreviewItem,
  DesktopPreviewTarget,
  DesktopPermissionRequest,
  DesktopRuntimeStatus,
  DesktopServerEvent,
  DesktopSnapshot,
  DesktopThreadPreviewState,
  DesktopView,
} from "../../desktop/shared/protocol";
import {
  getDesktopPreviewItemId,
  getDesktopPreviewItemTitle,
  normalizeWorkspacePreviewPath,
} from "../../desktop/shared/preview";
import {
  applyRuntimeEventToMessages,
  desktopMessageToUiMessage,
  extractTextContent,
  uiMessagesToDesktopMessages,
} from "../../desktop/shared/message-state";
import {
  getProviderOptions,
  requireDesktopProvider,
} from "./providers";
import {
  ContainerRuntimeManager,
  type PreviewRuntimeResponse,
  type RuntimeManager,
} from "./container-runtime";
import { CamelAIExtensionHost } from "./extensions/host";
import { getHarnessAdapterForProvider } from "./extensions/harness-adapters";
import type { CamelAIHostMcpMutationContext } from "./extensions/types";
import type { HostMcpServerRegistration } from "./host-mcp";
import {
  HostMcpOAuthManager,
  type HostMcpBrowserOpener,
} from "./host-mcp-oauth";
import {
  createPersistedHostMcpServerRegistration,
  installPersistedHostMcpHttpServer,
  installPersistedHostMcpStdioServer,
  listPersistedHostMcpServers,
  uninstallPersistedHostMcpServer,
  type PersistedHostMcpHttpInstallOptions,
  type PersistedHostMcpInstallResult,
  type PersistedHostMcpServerRecord,
  type PersistedHostMcpStdioInstallOptions,
} from "./persisted-host-mcp";

type Listener = (event: DesktopServerEvent) => void;

interface ActiveThreadRun {
  stopRequested: boolean;
}

interface PendingPermissionRequestRecord {
  request: DesktopPermissionRequest;
  resolve: () => void;
  reject: (error: Error) => void;
}

const INTERRUPTED_MESSAGE_TEXT = "[Request interrupted by user]";
const CORE_CHAT_VIEW_ID = "core:chat-thread";

export interface DesktopServiceOptions {
  hostMcpBrowserOpener?: HostMcpBrowserOpener;
}

function extractProviderSessionIdFromRuntimeEvent(
  _providerId: "claude" | "codex",
  event: unknown,
): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const sessionId = (event as {
    params?: {
      sessionId?: unknown;
    };
  }).params?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function toDesktopPluginFileUrl(path: string): string {
  const fileUrl = pathToFileURL(path);
  return `desktop-plugin://local${fileUrl.pathname}`;
}

export interface DesktopPreviewFetchResult {
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
  localPath?: string;
}

export class DesktopService {
  private readonly store = new DesktopStore();
  private readonly runtimeManager: RuntimeManager;
  private readonly dataDirectory: string;
  private readonly hostMcpOAuthManager: HostMcpOAuthManager;
  private readonly extensionHost: CamelAIExtensionHost;
  private readonly activeThreadRuns = new Map<string, ActiveThreadRun>();
  private readonly listeners = new Set<Listener>();
  private readonly pendingPermissionRequests: PendingPermissionRequestRecord[] = [];
  private runtimeStatus: DesktopRuntimeStatus;
  private runtimeStartupPromise: Promise<void> | null = null;

  constructor(
    runtimeManager: RuntimeManager = new ContainerRuntimeManager(),
    options: DesktopServiceOptions = {},
  ) {
    this.runtimeManager = runtimeManager;
    this.dataDirectory =
      process.env.DESKTOP_DATA_DIR?.trim() ||
      resolve(this.runtimeManager.getRuntimeDirectory(), "..", "data");
    this.hostMcpOAuthManager = new HostMcpOAuthManager({
      browserOpener: options.hostMcpBrowserOpener,
    });
    this.runtimeStatus = this.runtimeManager.getCachedStatus();
    this.loadPersistedHostMcpServers();
    this.extensionHost = new CamelAIExtensionHost({
      registerMcpServer: (registration) => {
        this.registerHostMcpServer(registration);
      },
      unregisterMcpServer: (serverId) => {
        this.unregisterHostMcpServer(serverId);
      },
      getActivationContext: () => this.getExtensionActivationContext(),
      listInstalledHostMcpServers: () => this.listInstalledHostMcpServers(),
      installStdioHostMcpServer: (server, context) =>
        this.installStdioHostMcpServer(server, context),
      installHttpHostMcpServer: (server, context) =>
        this.installHttpHostMcpServer(server, context),
      uninstallInstalledHostMcpServer: (serverId, context) =>
        this.uninstallInstalledHostMcpServer(serverId, context),
      openThreadPreviewItem: (threadId, target) =>
        this.openThreadPreviewItem(threadId, target),
      setThreadPreviewItems: (threadId, targets, activeIndex) =>
        this.setThreadPreviewItems(threadId, targets, activeIndex),
      clearThreadPreview: (threadId) => this.clearThreadPreview(threadId),
      setThreadPreviewVisibility: (threadId, visible) =>
        this.setThreadPreviewVisibility(threadId, visible),
      isPluginEnabled: (pluginId) => this.store.isPluginEnabled(pluginId),
    });
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel(provider);
    logDesktop("desktop-service", "init", {
      provider: provider.id,
      model,
      authSource: provider.getAuthState(model).source,
    });
    void this.extensionHost
      .initialize(this.getExtensionActivationContext())
      .then(() => {
        this.ensureDefaultTab();
        this.ensureDefaultThreadPanels();
        this.emitSnapshot();
      })
      .catch((error) => {
        logDesktop("desktop-service", "extension-startup-activation-error", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.emitSnapshot();
      });
    void this.ensureRuntimeRunning("startup");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.rejectPendingPermissionRequests(
      new Error("Desktop service disposed before the permission request was resolved."),
    );
    this.hostMcpOAuthManager.dispose();
    this.runtimeManager.dispose();
    this.listeners.clear();
    this.activeThreadRuns.clear();
  }

  registerHostMcpServer(registration: HostMcpServerRegistration): void {
    this.runtimeManager.registerHostMcpServer(registration);
  }

  unregisterHostMcpServer(serverId: string): void {
    this.runtimeManager.unregisterHostMcpServer(serverId);
  }

  listInstalledHostMcpServers(): PersistedHostMcpServerRecord[] {
    return listPersistedHostMcpServers({
      dataDirectory: this.dataDirectory,
      workspaceDirectory: this.runtimeManager.getWorkspaceDirectory(),
    });
  }

  async installStdioHostMcpServer(
    server: PersistedHostMcpStdioInstallOptions,
    context:
      | string
      | CamelAIHostMcpMutationContext = this.runtimeManager.getWorkspaceDirectory(),
  ): Promise<PersistedHostMcpInstallResult> {
    const workspaceDirectory =
      typeof context === "string"
        ? context
        : context.workspaceDirectory;
    if (typeof context !== "string") {
      const action = this.listInstalledHostMcpServers().some(
        (entry) => entry.id === server.id,
      )
        ? "update"
        : "create";
      await this.requestPermission({
        kind: "host_mcp_mutation",
        id: randomUUID(),
        threadId: context.threadId,
        pluginId: context.pluginId,
        harness: context.harness,
        action,
        serverId: server.id,
        transport: "stdio",
        command: server.command,
        args: server.args ?? [],
        cwd: server.cwd ?? null,
        url: null,
        name: server.name ?? null,
        version: server.version ?? null,
      });
    }

    const installed = installPersistedHostMcpStdioServer({
      dataDirectory: this.dataDirectory,
      workspaceDirectory,
      server,
    });
    this.runtimeManager.registerHostMcpServer(
      createPersistedHostMcpServerRegistration(installed, {
        dataDirectory: this.dataDirectory,
        oauthManager: this.hostMcpOAuthManager,
      }),
    );
    return installed;
  }

  async installHttpHostMcpServer(
    server: PersistedHostMcpHttpInstallOptions,
    context:
      | string
      | CamelAIHostMcpMutationContext = this.runtimeManager.getWorkspaceDirectory(),
  ): Promise<PersistedHostMcpInstallResult> {
    const workspaceDirectory =
      typeof context === "string"
        ? context
        : context.workspaceDirectory;
    if (typeof context !== "string") {
      const action = this.listInstalledHostMcpServers().some(
        (entry) => entry.id === server.id,
      )
        ? "update"
        : "create";
      await this.requestPermission({
        kind: "host_mcp_mutation",
        id: randomUUID(),
        threadId: context.threadId,
        pluginId: context.pluginId,
        harness: context.harness,
        action,
        serverId: server.id,
        transport: server.transport,
        command: null,
        args: [],
        cwd: null,
        url: server.url,
        transport: server.transport,
        name: server.name ?? null,
        version: server.version ?? null,
      });
    }

    const installed = installPersistedHostMcpHttpServer({
      dataDirectory: this.dataDirectory,
      workspaceDirectory,
      server,
    });
    this.runtimeManager.registerHostMcpServer(
      createPersistedHostMcpServerRegistration(installed, {
        dataDirectory: this.dataDirectory,
        oauthManager: this.hostMcpOAuthManager,
      }),
    );
    return installed;
  }

  async uninstallInstalledHostMcpServer(
    serverId: string,
    context?: Omit<CamelAIHostMcpMutationContext, "workspaceDirectory">,
  ): Promise<boolean> {
    if (context) {
      const existingServer =
        this.listInstalledHostMcpServers().find((entry) => entry.id === serverId) ?? null;
      await this.requestPermission({
        kind: "host_mcp_mutation",
        id: randomUUID(),
        threadId: context.threadId,
        pluginId: context.pluginId,
        harness: context.harness,
        action: "delete",
        serverId,
        transport: existingServer?.transport ?? "stdio",
        command:
          existingServer?.transport === "stdio" ? existingServer.command : null,
        args: existingServer?.transport === "stdio" ? existingServer.args : [],
        cwd: existingServer?.transport === "stdio" ? existingServer.cwd : null,
        url:
          existingServer?.transport === "stdio" ? null : existingServer?.url ?? null,
        name: existingServer?.name ?? null,
        version: existingServer?.version ?? null,
      });
    }

    const removed = uninstallPersistedHostMcpServer({
      dataDirectory: this.dataDirectory,
      serverId,
    });
    if (removed) {
      this.runtimeManager.unregisterHostMcpServer(serverId);
    }
    return removed;
  }

  emitSnapshot(listener?: Listener): void {
    const event: DesktopServerEvent = {
      type: "snapshot",
      snapshot: this.getSnapshot(),
    };
    if (listener) {
      listener(event);
      return;
    }
    this.broadcast(event);
  }

  getSnapshot(): DesktopSnapshot {
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel(provider);
    const extensionSnapshot = this.extensionHost.getSnapshot(
      this.getExtensionActivationContext(),
    );
    const views = [...this.getCoreViews(), ...extensionSnapshot.views];
    const snapshot = this.store.buildSnapshot(
      this.getRuntimeStatus(),
      provider.id,
      getProviderOptions(),
      model,
      provider.getAvailableModels(),
      provider.getAuthState(model),
      views,
      extensionSnapshot.plugins,
    );
    snapshot.threadPreviewStateById = this.resolveThreadPreviewStates(
      snapshot.threadPreviewStateById,
    );
    snapshot.pendingPermissionRequest =
      this.pendingPermissionRequests[0]?.request ?? null;
    return snapshot;
  }

  openThreadPreviewItem(
    threadId: string | null | undefined,
    target: DesktopPreviewTarget,
  ): { threadId: string; state: DesktopThreadPreviewState } {
    const resolvedThreadId = this.resolvePreviewThreadId(threadId);
    this.store.openThreadPreviewItem(resolvedThreadId, target);
    const state = this.resolveThreadPreviewState(resolvedThreadId);
    this.emitSnapshot();
    return {
      threadId: resolvedThreadId,
      state,
    };
  }

  setThreadPreviewItems(
    threadId: string | null | undefined,
    targets: DesktopPreviewTarget[],
    activeIndex?: number | null,
  ): { threadId: string; state: DesktopThreadPreviewState } {
    const resolvedThreadId = this.resolvePreviewThreadId(threadId);
    const normalizedActiveIndex =
      typeof activeIndex === "number" &&
      Number.isInteger(activeIndex) &&
      activeIndex >= 0 &&
      activeIndex < targets.length
        ? activeIndex
        : null;
    const activeItemId =
      normalizedActiveIndex === null
        ? null
        : getDesktopPreviewItemId(targets[normalizedActiveIndex]);
    this.store.setThreadPreviewItems(resolvedThreadId, targets, activeItemId);
    const state = this.resolveThreadPreviewState(resolvedThreadId);
    this.emitSnapshot();
    return {
      threadId: resolvedThreadId,
      state,
    };
  }

  clearThreadPreview(
    threadId: string | null | undefined,
  ): { threadId: string; state: DesktopThreadPreviewState } {
    const resolvedThreadId = this.resolvePreviewThreadId(threadId);
    this.store.clearThreadPreview(resolvedThreadId);
    const state = this.resolveThreadPreviewState(resolvedThreadId);
    this.emitSnapshot();
    return {
      threadId: resolvedThreadId,
      state,
    };
  }

  setThreadPreviewVisibility(
    threadId: string | null | undefined,
    visible: boolean,
  ): { threadId: string; state: DesktopThreadPreviewState } {
    const resolvedThreadId = this.resolvePreviewThreadId(threadId);
    this.store.setThreadPreviewVisibility(resolvedThreadId, visible);
    const state = this.resolveThreadPreviewState(resolvedThreadId);
    this.emitSnapshot();
    return {
      threadId: resolvedThreadId,
      state,
    };
  }

  async fetchThreadPreviewResource(
    threadId: string,
    itemId: string,
    options: {
      pathname?: string;
      search?: string;
    } = {},
  ): Promise<DesktopPreviewFetchResult> {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      return {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
        bodyBase64: Buffer.from(`Unknown thread ${threadId}.`, "utf8").toString("base64"),
      };
    }

    const previewState = this.store.getThreadPreviewState(threadId);
    const item = previewState.items.find((entry) => entry.id === itemId) ?? null;
    if (!item) {
      return {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
        bodyBase64: Buffer.from(`Unknown preview item ${itemId}.`, "utf8").toString("base64"),
      };
    }

    if (item.target.kind === "file") {
      const localPath = this.resolveLocalPreviewFilePath(item.target);
      if (localPath) {
        return {
          status: 200,
          headers: {},
          localPath,
        };
      }

      return this.toPreviewFetchResult(
        await this.runtimeManager.fetchPreviewFile({
          provider: requireDesktopProvider(thread.provider),
          path: item.target.path,
        }),
      );
    }

    const baseUrl = new URL(item.target.url);
    const pathname = options.pathname?.trim() || baseUrl.pathname || "/";
    const nextUrl = new URL(`${pathname}${options.search ?? ""}`, baseUrl.origin);
    return this.toPreviewFetchResult(
      await this.runtimeManager.fetchPreviewUrl({
        provider: requireDesktopProvider(thread.provider),
        url: nextUrl.toString(),
      }),
    );
  }

  private getCurrentProvider() {
    return requireDesktopProvider(this.store.getProvider());
  }

  private toPreviewFetchResult(
    response: PreviewRuntimeResponse,
  ): DesktopPreviewFetchResult {
    return {
      status: response.status,
      headers: response.headers,
      bodyBase64: response.bodyBase64,
    };
  }

  private resolvePreviewThreadId(threadId: string | null | undefined): string {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    const resolvedThreadId = normalizedThreadId || this.store.getActiveThreadId();
    if (!resolvedThreadId) {
      throw new Error("No active thread is available for preview updates.");
    }
    if (!this.store.getThread(resolvedThreadId)) {
      throw new Error(`Thread ${resolvedThreadId} does not exist.`);
    }
    return resolvedThreadId;
  }

  private resolveThreadPreviewState(threadId: string): DesktopThreadPreviewState {
    return this.resolveThreadPreviewStates({
      [threadId]: this.store.getThreadPreviewState(threadId),
    })[threadId] ?? {
      visible: false,
      activeItemId: null,
      items: [],
    };
  }

  private getCurrentModel(provider = this.getCurrentProvider()): string {
    return provider.normalizeModel(this.store.getModel(provider.id));
  }

  private getRuntimeStatus(): DesktopRuntimeStatus {
    return this.runtimeStatus;
  }

  private loadPersistedHostMcpServers(): void {
    for (const server of this.listInstalledHostMcpServers()) {
      this.runtimeManager.registerHostMcpServer(
        createPersistedHostMcpServerRegistration(server, {
          dataDirectory: this.dataDirectory,
          oauthManager: this.hostMcpOAuthManager,
        }),
      );
    }
  }

  private getExtensionActivationContext() {
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel(provider);
    const runtimeStatus = this.getRuntimeStatus();
    const activeThreadId = this.store.getActiveThreadId();
    const harness = getHarnessAdapterForProvider(provider.id).id;
    return {
      provider: provider.id,
      harness,
      model,
      activeThreadId,
      runtimeStatus,
      runtimeDirectory:
        runtimeStatus.runtimeDirectory ?? this.runtimeManager.getRuntimeDirectory(),
      workspaceDirectory: this.runtimeManager.getWorkspaceDirectory(),
      threadStateDirectory: activeThreadId
        ? this.runtimeManager.getThreadStateDirectory(activeThreadId)
        : null,
    };
  }

  handleClientEvent(event: DesktopClientEvent): void {
    switch (event.type) {
      case "create_thread": {
        const thread = this.store.createThread(event.title, this.store.getProvider());
        this.activateDefaultThreadView(thread.id);
        this.emitSnapshot();
        return;
      }
      case "select_thread": {
        if (!this.activateDefaultThreadView(event.threadId)) {
          this.store.setActiveThread(event.threadId);
        }
        this.emitSnapshot();
        void this.ensureRuntimeRunning("startup");
        return;
      }
      case "select_view": {
        this.store.activateWorkspaceView(event.viewId);
        this.emitSnapshot();
        this.emitPageOpen(event.viewId);
        return;
      }
      case "select_tab": {
        this.store.selectTab(event.tabId);
        this.emitSnapshot();
        const selectedTab = this.getSnapshot().tabs.find((tab) => tab.id === event.tabId);
        if (selectedTab?.kind === "workspace") {
          this.emitPageOpen(selectedTab.viewId);
        }
        return;
      }
      case "close_tab": {
        const views = this.extensionHost.getSnapshot(
          this.getExtensionActivationContext(),
        ).views;
        this.store.closeTab(event.tabId, views);
        this.emitSnapshot();
        return;
      }
      case "preview_open_item": {
        this.store.openThreadPreviewItem(event.threadId, event.item);
        this.emitSnapshot();
        return;
      }
      case "preview_set_items": {
        this.store.setThreadPreviewItems(
          event.threadId,
          event.items,
          event.activeItemId,
        );
        this.emitSnapshot();
        return;
      }
      case "preview_select_item": {
        this.store.selectThreadPreviewItem(event.threadId, event.itemId);
        this.emitSnapshot();
        return;
      }
      case "preview_close_item": {
        this.store.closeThreadPreviewItem(event.threadId, event.itemId);
        this.emitSnapshot();
        return;
      }
      case "preview_clear": {
        this.store.clearThreadPreview(event.threadId);
        this.emitSnapshot();
        return;
      }
      case "preview_set_visibility": {
        this.store.setThreadPreviewVisibility(event.threadId, event.visible);
        this.emitSnapshot();
        return;
      }
      case "set_provider": {
        const provider = requireDesktopProvider(event.provider).id;
        const activeThreadId = this.store.getActiveThreadId();
        const activeThread =
          activeThreadId ? this.store.getThread(activeThreadId) : null;
        if (!activeThread) {
          this.store.setProvider(provider);
        } else if (
          activeThread.provider === provider ||
          !this.store.threadHasHarnessState(activeThread.id)
        ) {
          this.store.setThreadProvider(activeThread.id, provider);
        } else {
          this.store.setProvider(provider);
          this.store.createThread(undefined, provider);
        }
        this.emitSnapshot();
        void this.ensureRuntimeRunning("startup");
        return;
      }
      case "set_model": {
        const provider = this.getCurrentProvider();
        this.store.setModel(provider.normalizeModel(event.model), provider.id);
        this.emitSnapshot();
        return;
      }
      case "refresh_plugins": {
        void this.handleRefreshPlugins();
        return;
      }
      case "set_plugin_enabled": {
        void this.handleSetPluginEnabled(event.pluginId, event.enabled);
        return;
      }
      case "send_message": {
        void this.sendThreadTurn(event.threadId, event.content);
        return;
      }
      case "stop_thread": {
        void this.stopThread(event.threadId);
        return;
      }
      case "ping": {
        this.broadcast({
          type: "pong",
          now: Date.now(),
        });
        return;
      }
      case "respond_permission_request": {
        this.resolvePermissionRequest(event.requestId, event.decision);
        return;
      }
      default: {
        const neverEvent: never = event;
        throw new Error(`Unhandled event: ${JSON.stringify(neverEvent)}`);
      }
    }
  }

  private broadcast(event: DesktopServerEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async requestPermission(
    request: DesktopPermissionRequest,
  ): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      this.pendingPermissionRequests.push({
        request,
        resolve,
        reject,
      });
      this.emitSnapshot();
      this.broadcast({
        type: "permission_request",
        request,
      });
    });
  }

  private resolvePermissionRequest(
    requestId: string,
    decision: "approve" | "deny",
  ): void {
    const index = this.pendingPermissionRequests.findIndex(
      (entry) => entry.request.id === requestId,
    );
    if (index === -1) {
      throw new Error(`Unknown permission request: ${requestId}`);
    }

    const [pending] = this.pendingPermissionRequests.splice(index, 1);
    this.emitSnapshot();
    if (decision === "approve") {
      pending.resolve();
      return;
    }

    const action =
      pending.request.kind === "host_mcp_mutation"
        ? pending.request.action
        : "perform";
    pending.reject(
      new Error(
        `User denied permission to ${action} host MCP server ${pending.request.serverId}.`,
      ),
    );
  }

  private rejectPendingPermissionRequests(error: Error): void {
    while (this.pendingPermissionRequests.length > 0) {
      this.pendingPermissionRequests.shift()?.reject(error);
    }
  }

  private ensureDefaultTab(): void {
    if (this.store.getActiveTabId()) {
      return;
    }

    const activeThreadId = this.store.getActiveThreadId();
    if (activeThreadId && this.activateDefaultThreadView(activeThreadId)) {
      return;
    }

    const defaultWorkspaceViewId = this.extensionHost.getDefaultViewId("workspace");
    if (defaultWorkspaceViewId) {
      this.store.activateWorkspaceView(defaultWorkspaceViewId);
    }
  }

  private reconcileWorkbenchState(): void {
    const extensionSnapshot = this.extensionHost.getSnapshot(
      this.getExtensionActivationContext(),
    );
    const validViewIds = new Set(
      [...this.getCoreViews(), ...extensionSnapshot.views].map((view) => view.id),
    );
    const activeViewId = this.store.getActiveViewId();

    if (activeViewId && !validViewIds.has(activeViewId)) {
      this.store.setActiveView(null);
    }
  }

  private async handleRefreshPlugins(): Promise<void> {
    try {
      await this.extensionHost.refresh(this.getExtensionActivationContext());
      this.reconcileWorkbenchState();
      this.ensureDefaultTab();
      this.emitSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDesktop("desktop-service", "plugin-refresh-error", { error: message });
      this.broadcast({
        type: "error",
        message,
      });
      this.emitSnapshot();
    }
  }

  private async handleSetPluginEnabled(
    pluginId: string,
    enabled: boolean,
  ): Promise<void> {
    const plugin = this.getSnapshot().plugins.find((entry) => entry.id === pluginId);
    if (!plugin) {
      this.broadcast({
        type: "error",
        message: `Plugin ${pluginId} does not exist.`,
      });
      return;
    }
    if (!plugin.disableable) {
      this.broadcast({
        type: "error",
        message: `Plugin ${plugin.name} cannot be disabled.`,
      });
      return;
    }

    this.store.setPluginEnabled(pluginId, enabled);
    await this.handleRefreshPlugins();
  }

  private activateDefaultThreadView(threadId: string): boolean {
    this.store.activateThreadView(threadId, CORE_CHAT_VIEW_ID);
    return true;
  }

  private getCoreViews(): DesktopView[] {
    return [
      {
        id: CORE_CHAT_VIEW_ID,
        title: "Chat",
        description: "Thread-focused chat workspace.",
        icon: "MessagesSquare",
        pluginId: null,
        scope: "thread",
        isDefault: true,
        render: {
          kind: "host",
          component: "chat-thread",
        },
        hostData: null,
      },
    ];
  }

  private resolveLocalPreviewFilePath(target: Extract<DesktopPreviewTarget, { kind: "file" }>): string | null {
    const trimmedPath = target.path.trim();
    if (!trimmedPath) {
      return null;
    }

    if (target.source === "workspace") {
      const normalizedPath = normalizeWorkspacePreviewPath(trimmedPath);
      const workspaceRelativePath = normalizedPath.replace(/^\/+/, "");
      const localPath = resolve(
        this.runtimeManager.getManagedWorkspaceDirectory(),
        workspaceRelativePath,
      );
      if (!existsSync(localPath) || !statSync(localPath).isFile()) {
        return null;
      }
      return localPath;
    }

    if (existsSync(trimmedPath) && statSync(trimmedPath).isFile()) {
      return trimmedPath;
    }

    return null;
  }

  private resolvePreviewSource(target: DesktopPreviewTarget): string | null {
    if (target.kind === "url") {
      const normalizedUrl = target.url.trim();
      return normalizedUrl || null;
    }

    const localPath = this.resolveLocalPreviewFilePath(target);
    return localPath ? toDesktopPluginFileUrl(localPath) : null;
  }

  private resolvePreviewItem(item: DesktopPreviewItem): DesktopPreviewItem {
    const title = getDesktopPreviewItemTitle(item.target);
    return {
      ...item,
      title,
      src: this.resolvePreviewSource(item.target),
      contentType:
        item.target.kind === "file"
          ? item.target.contentType ?? item.contentType ?? null
          : null,
    };
  }

  private resolveThreadPreviewStates(
    states: Record<string, DesktopThreadPreviewState>,
  ): Record<string, DesktopThreadPreviewState> {
    return Object.fromEntries(
      Object.entries(states).map(([threadId, state]) => {
        const items = state.items.map((item) => this.resolvePreviewItem(item));
        const activeItemId =
          state.activeItemId && items.some((item) => item.id === state.activeItemId)
            ? state.activeItemId
            : items[0]?.id ?? null;

        return [
          threadId,
          {
            visible: state.visible && items.length > 0,
            activeItemId,
            items,
          },
        ];
      }),
    );
  }

  private emitPageOpen(viewId: string): void {
    void this.extensionHost.emit(
      "page_open",
      {
        type: "page_open",
        pageId: viewId,
      },
      this.getExtensionActivationContext(),
    );
  }

  private async ensureRuntimeRunning(
    reason: "startup" | "send_message",
    provider = this.getCurrentProvider(),
  ): Promise<void> {
    if (this.runtimeStartupPromise) {
      await this.runtimeStartupPromise;
      return;
    }

    this.runtimeStatus = {
      ...this.runtimeStatus,
      state: "starting",
      detail:
        reason === "startup"
          ? `Preparing the ${provider.label} Apple container runtime automatically.`
          : `Preparing the ${provider.label} Apple container runtime for this message.`,
      helperPath: null,
    };
    this.emitSnapshot();

    this.runtimeStartupPromise = (async () => {
      try {
        this.runtimeStatus = await this.runtimeManager.ensureRuntime(provider, (status) => {
          this.runtimeStatus = status;
          this.emitSnapshot();
        });
      } catch (error) {
        this.runtimeStatus = {
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
          helperPath: null,
        };
      } finally {
        this.emitSnapshot();
        this.runtimeStartupPromise = null;
      }
    })();

    await this.runtimeStartupPromise;
  }

  private appendErrorMessage(threadId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const assistant = this.store.appendMessage(
      threadId,
      "assistant",
      `Error: ${detail}`,
      "error",
    );
    this.emitSnapshot();
    this.broadcast({
      type: "error",
      threadId,
      message: extractTextContent(assistant.content),
    });
  }

  private async sendThreadTurn(threadId: string, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) {
      this.broadcast({
        type: "error",
        threadId,
        message: "Message content cannot be empty.",
      });
      return;
    }

    const promptUpdate = await this.extensionHost.applyBeforePrompt(
      threadId,
      trimmed,
      this.getExtensionActivationContext(),
    );
    if (promptUpdate.cancelled) {
      this.broadcast({
        type: "error",
        threadId,
        message: "A plugin cancelled this prompt before it reached the runtime.",
      });
      return;
    }
    const activeRun = this.activeThreadRuns.get(threadId);
    if (activeRun?.stopRequested) {
      this.broadcast({
        type: "error",
        threadId,
        message: "This thread is stopping. Wait for it to finish or send again after it stops.",
      });
      return;
    }

    const promptContent = promptUpdate.content;
    this.store.appendMessage(threadId, "user", promptContent, "done");
    this.emitSnapshot();
    if (activeRun) {
      void this.forwardPromptToActiveThread(threadId, promptContent, activeRun);
      return;
    }

    const nextActiveRun: ActiveThreadRun = {
      stopRequested: false,
    };
    this.activeThreadRuns.set(threadId, nextActiveRun);
    try {
      await this.processThreadTurn(threadId, promptContent, nextActiveRun);
    } finally {
      this.activeThreadRuns.delete(threadId);
    }
  }

  private async forwardPromptToActiveThread(
    threadId: string,
    content: string,
    activeRun: ActiveThreadRun,
  ): Promise<void> {
    const provider = requireDesktopProvider(this.store.getThreadProvider(threadId));
    const model = this.getCurrentModel(provider);
    const providerSessionId = this.store.getProviderSessionId(threadId, provider.id);

    try {
      await this.runtimeManager.streamPrompt({
        provider,
        threadId,
        content,
        model,
        sessionId: providerSessionId,
        onSessionId: (sessionId) => {
          this.store.setProviderSessionId(threadId, provider.id, sessionId);
        },
      });
    } catch (error) {
      if (activeRun.stopRequested) {
        return;
      }
      this.broadcast({
        type: "error",
        threadId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopThread(threadId: string): Promise<void> {
    const activeRun = this.activeThreadRuns.get(threadId);
    if (!activeRun || activeRun.stopRequested) {
      return;
    }

    activeRun.stopRequested = true;
    const provider = requireDesktopProvider(this.store.getThreadProvider(threadId));
    const model = this.getCurrentModel(provider);
    try {
      await this.runtimeManager.cancelPrompt({
        provider,
        threadId,
        model,
      });
    } catch (error) {
      activeRun.stopRequested = false;
      this.broadcast({
        type: "error",
        threadId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async processThreadTurn(
    threadId: string,
    content: string,
    activeRun: ActiveThreadRun,
  ): Promise<void> {
    const turnId = randomUUID();
    let assistantId: string | null = null;
    const provider = requireDesktopProvider(
      this.store.getThreadProvider(threadId),
    );
    const model = this.getCurrentModel(provider);
    const providerSessionId = this.store.getProviderSessionId(
      threadId,
      provider.id,
    );

    try {
      const assistant = this.store.appendMessage(
        threadId,
        "assistant",
        "",
        "streaming",
      );
      assistantId = assistant.id;
      this.emitSnapshot();

      const streamingMessageIds: Record<string, string | null> = {
        [threadId]: assistant.id,
      };

      await this.ensureRuntimeRunning("send_message", provider);
      await this.extensionHost.emit(
        "session_start",
        {
          type: "session_start",
          threadId,
        },
        this.getExtensionActivationContext(),
      );
      await this.extensionHost.emit(
        "turn_start",
        {
          type: "turn_start",
          threadId,
          content,
        },
        this.getExtensionActivationContext(),
      );
      this.emitSnapshot();

      const result = await this.runtimeManager.streamPrompt({
        provider,
        threadId,
        content,
        model,
        sessionId: providerSessionId,
        onSessionId: (sessionId) => {
          this.store.setProviderSessionId(threadId, provider.id, sessionId);
        },
        onRuntimeEvent: (event) => {
          if (!assistantId) {
            return;
          }
          const runtimeSessionId = extractProviderSessionIdFromRuntimeEvent(
            provider.id,
            event,
          );
          if (runtimeSessionId) {
            this.store.setProviderSessionId(threadId, provider.id, runtimeSessionId);
          }
          this.broadcast({
            type: "runtime_event",
            threadId,
            provider: provider.id,
            event,
          });

          const currentThreadMessages = this.store
            .getThreadMessages(threadId)
            .map(desktopMessageToUiMessage);
          const nextThreadMessages = applyRuntimeEventToMessages(
            currentThreadMessages,
            threadId,
            provider.id,
            event,
            streamingMessageIds,
          );
          this.store.replaceThreadMessages(
            threadId,
            uiMessagesToDesktopMessages(
              nextThreadMessages,
              this.store.getThreadMessages(threadId),
            ),
          );
          this.emitSnapshot();
        },
      });
      await this.extensionHost.emit(
        "turn_end",
        {
          type: "turn_end",
          threadId,
          content,
          response: result.finalText,
        },
        this.getExtensionActivationContext(),
      );

      const latestAssistant = this.store
        .getThreadMessages(threadId)
        .find((message) => message.id === assistant.id);
      const persistedAssistantText = latestAssistant
        ? extractTextContent(latestAssistant.content).trim()
        : "";
      this.store.finalizeMessage(
        threadId,
        assistant.id,
        "done",
        result.finalText.trim()
          ? persistedAssistantText.length === 0
            ? result.finalText
            : undefined
          : result.stopReason && persistedAssistantText.length === 0
            ? INTERRUPTED_MESSAGE_TEXT
            : undefined,
      );

      logDesktop("desktop-service", "send_message:completed", {
        turnId,
        threadId,
        provider: provider.id,
        assistantId,
        finalTextLength: result.finalText.length,
        model: result.model,
        stopReason: result.stopReason,
      });
      this.emitSnapshot();
    } catch (error) {
      logDesktop("desktop-service", "send_message:error", {
        turnId,
        threadId,
        provider: provider.id,
        assistantId,
        stopRequested: activeRun.stopRequested,
        error,
      });
      if (assistantId) {
        const detail = error instanceof Error ? error.message : String(error);
        if (activeRun.stopRequested) {
          this.store.finalizeMessage(
            threadId,
            assistantId,
            "done",
            INTERRUPTED_MESSAGE_TEXT,
          );
        } else {
          this.store.finalizeMessage(
            threadId,
            assistantId,
            "error",
            `Error: ${detail}`,
          );
        }
        this.emitSnapshot();
        if (!activeRun.stopRequested) {
          this.broadcast({
            type: "error",
            threadId,
            message: detail,
          });
        }
      } else {
        this.appendErrorMessage(threadId, error);
      }
    }
  }
}
