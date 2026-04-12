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
  DesktopThread,
  DesktopThreadPreviewState,
  DesktopThreadRuntimeState,
} from "../../desktop/shared/protocol";
import {
  getDesktopPreviewItemId,
  getDesktopPreviewItemTitle,
  normalizeTransferredPreviewPath,
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
import { ContainerRuntimeManager, type RuntimeManager } from "./container-runtime";
import { CamelAIExtensionHost } from "./extensions/host";
import { getHarnessAdapterForProvider } from "./extensions/harness-adapters";
import type {
  CamelAIHostMcpMutationContext,
  CamelAIHostPluginMutationContext,
  CamelAIMatchedHttpProxyRequest,
  CamelAIHttpRequest,
  CamelAIHttpResponse,
  CamelAIThreadCreateOptions,
  CamelAIThreadEvent,
  CamelAIThreadEventHandler,
  CamelAIThreadRecord,
  CamelAIThreadUpdate,
  CamelAIPluginAgentAssetsBundleRecord,
} from "./extensions/types";
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
import {
  installPluginFromDirectory,
  readPluginManifestFromDirectory,
  resolvePluginWorkspaceSourcePath,
} from "./persisted-plugins";
import {
  getInstalledPluginAgentAssetsStatus,
  reconcilePluginAgentAssets,
} from "./plugin-agent-assets";
import { getPersistedHostSecret, setPersistedHostSecret } from "./host-secrets";

type Listener = (event: DesktopServerEvent) => void;
type ThreadEventListener = CamelAIThreadEventHandler;

interface ActiveThreadRun {
  stopRequested: boolean;
}

interface PendingPermissionRequestRecord {
  request: DesktopPermissionRequest;
  resolve: (response: { secretValue?: string | null }) => void;
  reject: (error: Error) => void;
}

const INTERRUPTED_MESSAGE_TEXT = "[Request interrupted by user]";

export interface DesktopServiceOptions {
  hostMcpBrowserOpener?: HostMcpBrowserOpener;
}

function extractProviderSessionIdFromRuntimeEvent(
  _providerId: "claude" | "codex" | "pi" | "opencode",
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

const DEFAULT_PLUGIN_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_PLUGIN_HTTP_MAX_BODY_BYTES = 512 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STRIPPED_PROXY_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

function normalizeHttpRequestHeaders(
  value: unknown,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!value || typeof value !== "object") {
    return headers;
  }

  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) {
      continue;
    }
    headers[normalizedKey] = rawValue;
  }

  return headers;
}

function parsePluginHttpQuery(
  search: string,
): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  const params = new URLSearchParams(search);
  for (const [key, value] of params.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
      continue;
    }
    if (Array.isArray(existing)) {
      existing.push(value);
      continue;
    }
    query[key] = [existing, value];
  }
  return query;
}

function buildPluginHttpResponse(
  response: CamelAIHttpResponse,
): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (HOP_BY_HOP_HEADERS.has(key.trim().toLowerCase())) {
      continue;
    }
    headers[key] = value;
  }
  return {
    status: response.status,
    headers,
    body: response.body ?? "",
  };
}

function buildPluginProxyTargetUrl(
  baseUrl: string,
  path: string,
  search: string,
): URL {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const tailPath = path.replace(/^\/+/, "");
  url.pathname = tailPath ? `${basePath}/${tailPath}`.replace(/\/{2,}/g, "/") : basePath || "/";
  url.search = search;
  return url;
}

function filterPluginProxyRequestHeaders(
  headers: Record<string, string>,
  stripRequestHeaders: string[] | undefined,
): Record<string, string> {
  const stripped = new Set(
    (stripRequestHeaders ?? []).map((header) => header.trim().toLowerCase()),
  );
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STRIPPED_PROXY_REQUEST_HEADERS.has(key) || stripped.has(key)) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function filterPluginResponseHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

async function readPluginResponseBody(
  response: Response,
  maxBodyBytes: number,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        throw new Error(
          `Plugin HTTP response exceeded ${maxBodyBytes} bytes.`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

export class DesktopService {
  private readonly store = new DesktopStore();
  private readonly runtimeManager: RuntimeManager;
  private readonly dataDirectory: string;
  private readonly hostMcpOAuthManager: HostMcpOAuthManager;
  private readonly extensionHost: CamelAIExtensionHost;
  private readonly activeThreadRuns = new Map<string, ActiveThreadRun>();
  private readonly listeners = new Set<Listener>();
  private readonly threadEventListeners = new Set<ThreadEventListener>();
  private readonly pendingPermissionRequests: PendingPermissionRequestRecord[] = [];
  private runtimeStatus: DesktopRuntimeStatus;
  private runtimeStartupPromise: Promise<void> | null = null;

  constructor(
    runtimeManager: RuntimeManager = new ContainerRuntimeManager(),
    options: DesktopServiceOptions = {},
  ) {
    this.runtimeManager = runtimeManager;
    this.runtimeManager.setHostRpcMethodHandler((method, params) =>
      this.handleRuntimeHostRpcMethod(method, params),
    );
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
      promptToStoreSecret: (options, context) =>
        this.promptToStoreSecret(options, context),
      uninstallInstalledHostMcpServer: (serverId, context) =>
        this.uninstallInstalledHostMcpServer(serverId, context),
      listInstalledPlugins: () => this.listInstalledPlugins(),
      installPluginFromWorkspace: (options, context) =>
        this.installPluginFromWorkspace(options, context),
      listPluginAgentAssets: (pluginId) => this.listPluginAgentAssets(pluginId),
      openThreadPreviewItem: (threadId, target) =>
        this.openThreadPreviewItem(threadId, target),
      setThreadPreviewItems: (threadId, targets, activeIndex) =>
        this.setThreadPreviewItems(threadId, targets, activeIndex),
      clearThreadPreview: (threadId) => this.clearThreadPreview(threadId),
      setThreadPreviewVisibility: (threadId, visible) =>
        this.setThreadPreviewVisibility(threadId, visible),
      listThreads: () => this.listThreads(),
      getThread: (threadId) => this.getThreadRecord(threadId),
      subscribeThreadEvents: (listener) => this.subscribeThreadEvents(listener),
      selectThread: (threadId) => this.selectThread(threadId),
      createThread: (options) => this.createThread(options),
      sendMessage: async (threadId, content) => {
        await this.sendMessage(threadId, content);
      },
      stopThread: async (threadId) => await this.stopThread(threadId),
      updateThread: (threadId, update) => this.updateThread(threadId, update),
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
        this.reconcileDeclaredPluginAgentAssets();
        this.ensureDefaultTab();
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

  subscribeThreadEvents(listener: ThreadEventListener): () => void {
    this.threadEventListeners.add(listener);
    return () => {
      this.threadEventListeners.delete(listener);
    };
  }

  dispose(): void {
    this.rejectPendingPermissionRequests(
      new Error("Desktop service disposed before the permission request was resolved."),
    );
    this.hostMcpOAuthManager.dispose();
    this.runtimeManager.dispose();
    this.listeners.clear();
    this.threadEventListeners.clear();
    this.activeThreadRuns.clear();
  }

  listThreads(): CamelAIThreadRecord[] {
    return this.store.listThreads().map((thread) => this.toPluginThreadRecord(thread));
  }

  getThreadRecord(threadId: string): CamelAIThreadRecord | null {
    const thread = this.store.getThread(threadId);
    return thread ? this.toPluginThreadRecord(thread) : null;
  }

  createThread(options?: CamelAIThreadCreateOptions): CamelAIThreadRecord {
    const provider = options?.provider
      ? requireDesktopProvider(options.provider).id
      : this.store.getProvider();
    const groupId = options?.groupId ?? this.store.getActiveGroupId();
    if (!groupId) {
      throw new Error("No active thread group is available.");
    }
    const thread = this.store.createThread({
      title: options?.title,
      provider,
      groupId,
      status: options?.status,
      lane: options?.lane,
      archivedAt: options?.archivedAt,
      hasUnreadUpdate: options?.hasUnreadUpdate,
    });
    this.activateDefaultThreadView(thread.id);
    this.emitSnapshot();
    const record = this.requireThreadRecord(thread.id);
    this.emitThreadEvent({
      type: "thread_created",
      thread: record,
    });
    return record;
  }

  createGroup(title?: string): void {
    this.store.createThreadGroup(title);
    this.emitSnapshot();
  }

  updateGroup(groupId: string, title: string): void {
    this.store.updateThreadGroup(groupId, title);
    this.emitSnapshot();
  }

  deleteGroup(groupId: string): void {
    this.store.deleteThreadGroup(groupId);
    this.emitSnapshot();
  }

  selectGroup(groupId: string): void {
    this.store.setActiveGroup(groupId);
    this.emitSnapshot();
  }

  selectThread(threadId: string): CamelAIThreadRecord {
    const existing = this.store.getThread(threadId);
    if (existing?.hasUnreadUpdate) {
      this.store.setThreadUnreadUpdate(threadId, false);
    }
    if (!this.activateDefaultThreadView(threadId)) {
      this.store.setActiveThread(threadId);
    }
    this.emitSnapshot();
    void this.ensureRuntimeRunning("startup");
    const record = this.requireThreadRecord(threadId);
    this.emitThreadEvent({
      type: "thread_selected",
      thread: record,
    });
    return record;
  }

  async sendMessage(threadId: string, content: string): Promise<void> {
    await this.sendThreadTurn(threadId, content);
  }

  async stopThread(threadId: string): Promise<boolean> {
    const activeRun = this.activeThreadRuns.get(threadId);
    if (!activeRun || activeRun.stopRequested) {
      return false;
    }
    await this.requestThreadStop(threadId);
    return true;
  }

  updateThread(
    threadId: string,
    update: CamelAIThreadUpdate,
  ): CamelAIThreadRecord {
    this.store.updateThread(threadId, update);
    this.emitSnapshot();
    const record = this.requireThreadRecord(threadId);
    this.emitThreadEvent({
      type: "thread_updated",
      thread: record,
      reason: "thread",
    });
    return record;
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

  listInstalledPlugins() {
    return this.getSnapshot().plugins;
  }

  listPluginAgentAssets(pluginId?: string | null): CamelAIPluginAgentAssetsBundleRecord[] {
    const plugins = pluginId ? [this.requirePluginAgentAssetPlugin(pluginId)] : this.listInstalledPlugins();
    return plugins.flatMap((plugin) => {
      const manifest = readPluginManifestFromDirectory(plugin.path);
      const agentAssets = manifest.agentAssets;
      if (!agentAssets) {
        return [];
      }
      return [
        {
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginVersion: plugin.version,
          source: plugin.source,
          path: plugin.path,
          skills: agentAssets.skills.map((skill) => ({
            id: skill.id,
          })),
          mcpServers: agentAssets.mcpServers.map((server) => ({
            id: server.id,
            transport: server.transport,
            name: server.name,
            version: server.version,
          })),
          installedByProvider: getInstalledPluginAgentAssetsStatus({
            runtimeDirectory: this.runtimeManager.getRuntimeDirectory(),
            pluginId: plugin.id,
          }),
        } satisfies CamelAIPluginAgentAssetsBundleRecord,
      ];
    });
  }

  private async handleRuntimeHostRpcMethod(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "http.request":
        return await this.handlePluginHttpRequest(params);
      default:
        throw new Error(`Unknown host RPC method: ${method || "<missing>"}.`);
    }
  }

  private async handlePluginHttpRequest(
    params: unknown,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    if (!params || typeof params !== "object") {
      throw new Error("http.request params must be an object.");
    }

    const record = params as Record<string, unknown>;
    const pathname = typeof record.pathname === "string" ? record.pathname.trim() : "";
    if (!pathname || !pathname.startsWith("/")) {
      throw new Error("http.request params.pathname must be a non-empty absolute path.");
    }

    const method =
      typeof record.method === "string" && record.method.trim()
        ? record.method.trim().toUpperCase()
        : "GET";
    const search =
      typeof record.search === "string" && record.search.trim()
        ? record.search
        : "";
    const request: CamelAIHttpRequest = {
      method,
      url: `${pathname}${search}`,
      pathname,
      search,
      path: pathname,
      query: parsePluginHttpQuery(search),
      headers: normalizeHttpRequestHeaders(record.headers),
      body: typeof record.body === "string" ? record.body : null,
    };

    const dispatchResult = await this.extensionHost.dispatchHttpRequest(
      request,
      this.getExtensionActivationContext(),
    );
    if (!dispatchResult) {
      return {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
        body: `No plugin HTTP route matched ${pathname}.`,
      };
    }
    if (dispatchResult.type === "response") {
      return buildPluginHttpResponse(dispatchResult.response);
    }
    return await this.executeRegisteredHttpProxy(dispatchResult.proxy);
  }

  private async executeRegisteredHttpProxy(
    proxyRequest: CamelAIMatchedHttpProxyRequest,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const headers = filterPluginProxyRequestHeaders(
      proxyRequest.request.headers,
      proxyRequest.proxy.stripRequestHeaders,
    );

    for (const [key, value] of Object.entries(proxyRequest.proxy.headers ?? {})) {
      headers[key.trim().toLowerCase()] = value;
    }

    const auth = proxyRequest.proxy.auth ?? null;
    if (auth && auth.type !== "none") {
      const secret = getPersistedHostSecret(this.dataDirectory, auth.secretRef);
      if (!secret) {
        throw new Error(
          `Plugin HTTP proxy ${proxyRequest.pluginId}/${proxyRequest.proxyId} is missing secret ${auth.secretRef}.`,
        );
      }
      if (auth.type === "bearer") {
        headers[(auth.headerName?.trim() || "authorization").toLowerCase()] =
          `Bearer ${secret}`;
      } else {
        headers[auth.headerName.trim().toLowerCase()] = secret;
      }
    }

    const timeoutMs =
      typeof proxyRequest.proxy.timeoutMs === "number" &&
      Number.isFinite(proxyRequest.proxy.timeoutMs)
        ? Math.max(1, Math.trunc(proxyRequest.proxy.timeoutMs))
        : DEFAULT_PLUGIN_HTTP_TIMEOUT_MS;
    const maxBodyBytes =
      typeof proxyRequest.proxy.maxBodyBytes === "number" &&
      Number.isFinite(proxyRequest.proxy.maxBodyBytes)
        ? Math.max(1, Math.trunc(proxyRequest.proxy.maxBodyBytes))
        : DEFAULT_PLUGIN_HTTP_MAX_BODY_BYTES;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`Plugin HTTP proxy timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);

    try {
      const upstreamUrl = buildPluginProxyTargetUrl(
        proxyRequest.proxy.baseUrl,
        proxyRequest.path,
        proxyRequest.request.search,
      );
      const response = await fetch(upstreamUrl, {
        method: proxyRequest.request.method,
        headers,
        body: proxyRequest.request.body ?? undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      return {
        status: response.status,
        headers: filterPluginResponseHeaders(response.headers),
        body: await readPluginResponseBody(response, maxBodyBytes),
      };
    } finally {
      clearTimeout(timeout);
    }
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
    const normalizedServer = {
      ...server,
      transport: server.transport ?? "streamable-http",
    } satisfies PersistedHostMcpHttpInstallOptions;
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
        transport: normalizedServer.transport,
        command: null,
        args: [],
        cwd: null,
        url: server.url,
        name: server.name ?? null,
        version: server.version ?? null,
      });
    }

    const installed = installPersistedHostMcpHttpServer({
      dataDirectory: this.dataDirectory,
      workspaceDirectory,
      server: normalizedServer,
    });
    this.runtimeManager.registerHostMcpServer(
      createPersistedHostMcpServerRegistration(installed, {
        dataDirectory: this.dataDirectory,
        oauthManager: this.hostMcpOAuthManager,
      }),
    );
    return installed;
  }

  async promptToStoreSecret(
    options: {
      secretRef?: string | null;
      title: string;
      message?: string | null;
      fieldLabel?: string | null;
    },
    context: Omit<CamelAIHostMcpMutationContext, "workspaceDirectory">,
  ): Promise<{ secretRef: string }> {
    const secretRef =
      typeof options.secretRef === "string" && options.secretRef.trim()
        ? options.secretRef.trim()
        : `secret-${randomUUID()}`;
    const response = await this.requestPermission({
      kind: "secret_prompt",
      id: randomUUID(),
      threadId: context.threadId,
      pluginId: context.pluginId,
      harness: context.harness,
      secretRef,
      title: options.title.trim() || "Store secret",
      message:
        typeof options.message === "string" && options.message.trim()
          ? options.message.trim()
          : null,
      fieldLabel:
        typeof options.fieldLabel === "string" && options.fieldLabel.trim()
          ? options.fieldLabel.trim()
          : null,
    });

    const secretValue =
      typeof response.secretValue === "string" && response.secretValue.trim()
        ? response.secretValue.trim()
        : null;
    if (!secretValue) {
      throw new Error(`No secret value was provided for ${secretRef}.`);
    }
    setPersistedHostSecret(this.dataDirectory, secretRef, secretValue);
    return { secretRef };
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

  async installPluginFromWorkspace(
    options: {
      path: string;
    },
    context: CamelAIHostPluginMutationContext,
  ): Promise<{
    pluginId: string;
    pluginName: string;
    version: string;
    installPath: string;
    replaced: boolean;
  }> {
    const sourcePath = resolvePluginWorkspaceSourcePath(
      this.runtimeManager.getManagedWorkspaceDirectory(),
      options.path,
    );
    const manifest = readPluginManifestFromDirectory(sourcePath);
    await this.requestPermission({
      kind: "plugin_mutation",
      id: randomUUID(),
      threadId: context.threadId,
      pluginId: context.pluginId,
      harness: context.harness,
      action: this.listInstalledPlugins().some((plugin) => plugin.id === manifest.id)
        ? "update"
        : "install",
      targetPluginId: manifest.id,
      targetPluginName: manifest.name,
      sourcePath: options.path,
      version: manifest.version,
    });

    const installed = installPluginFromDirectory({
      dataDirectory: this.dataDirectory,
      sourceDirectory: sourcePath,
    });
    await this.handleRefreshPlugins();
    return {
      pluginId: installed.id,
      pluginName: installed.name,
      version: installed.version,
      installPath: installed.installPath,
      replaced: installed.replaced,
    };
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
    const snapshot = this.store.buildSnapshot(
      this.getRuntimeStatus(),
      provider.id,
      getProviderOptions(),
      model,
      provider.getAvailableModels(),
      provider.getAuthState(model),
      extensionSnapshot.views,
      extensionSnapshot.sidebarPanels,
      extensionSnapshot.plugins,
    );
    snapshot.threadPreviewStateById = this.resolveThreadPreviewStates(
      snapshot.threadPreviewStateById,
    );
    snapshot.threadRuntimeById = this.resolveThreadRuntimeStates(snapshot.threads);
    snapshot.pendingPermissionRequest =
      this.pendingPermissionRequests[0]?.request ?? null;
    return snapshot;
  }

  resolvePreviewTargetSource(target: DesktopPreviewTarget): string | null {
    return this.resolvePreviewSource(target);
  }

  private resolveThreadRuntimeStates(
    threads: DesktopThread[],
  ): Record<string, DesktopThreadRuntimeState> {
    return Object.fromEntries(
      threads.map((thread) => {
        const activeRun = this.activeThreadRuns.get(thread.id);
        return [
          thread.id,
          {
            active: thread.id === this.store.getActiveThreadId(),
            hasMessages: this.store.getThreadMessages(thread.id).length > 0,
            sessionId: this.store.getProviderSessionId(thread.id, thread.provider),
            isRunning: Boolean(activeRun),
            stopRequested: activeRun?.stopRequested === true,
          },
        ];
      }),
    );
  }
  private toPluginThreadRecord(thread: DesktopThread): CamelAIThreadRecord {
    const activeRun = this.activeThreadRuns.get(thread.id);
    return {
      id: thread.id,
      groupId: thread.groupId,
      provider: thread.provider,
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      lastMessagePreview: thread.lastMessagePreview,
      status: thread.status,
      lane: thread.lane,
      archivedAt: thread.archivedAt,
      hasUnreadUpdate: thread.hasUnreadUpdate,
      active: thread.id === this.store.getActiveThreadId(),
      hasMessages: this.store.getThreadMessages(thread.id).length > 0,
      sessionId: this.store.getProviderSessionId(thread.id, thread.provider),
      isRunning: Boolean(activeRun),
      stopRequested: activeRun?.stopRequested === true,
    };
  }

  private requireThreadRecord(threadId: string): CamelAIThreadRecord {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist.`);
    }
    return this.toPluginThreadRecord(thread);
  }

  private requirePluginAgentAssetPlugin(pluginId: string) {
    const installedPlugin = this.listInstalledPlugins().find((plugin) => plugin.id === pluginId);
    if (installedPlugin) {
      return installedPlugin;
    }

    const persistedPluginPath = resolve(this.dataDirectory, "plugins", pluginId);
    if (existsSync(persistedPluginPath) && statSync(persistedPluginPath).isDirectory()) {
      const manifest = readPluginManifestFromDirectory(persistedPluginPath);
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        source: "user" as const,
        enabled: true,
        disableable: true,
        path: persistedPluginPath,
      };
    }

    throw new Error(`Plugin ${pluginId} is not installed.`);
  }

  private emitThreadEvent(event: CamelAIThreadEvent): void {
    for (const listener of this.threadEventListeners) {
      void Promise.resolve(listener(event)).catch((error) => {
        logDesktop("desktop-service", "thread-event-listener-error", {
          error: error instanceof Error ? error.message : String(error),
          eventType: event.type,
          threadId: event.thread.id,
        });
      });
    }
  }

  private emitThreadUpdated(
    threadId: string,
    reason: "message" | "thread" | "selection" | "session",
  ): void {
    const thread = this.store.getThread(threadId);
    if (!thread) {
      return;
    }
    this.emitThreadEvent({
      type: "thread_updated",
      thread: this.toPluginThreadRecord(thread),
      reason,
    });
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

  private getCurrentProvider() {
    return requireDesktopProvider(this.store.getProvider());
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
      activeGroupId: this.store.getActiveGroupId(),
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
        this.createThread({
          title: event.title,
          groupId: event.groupId,
          provider: this.store.getProvider(),
          status: event.status,
          lane: event.lane,
          archivedAt: event.archivedAt,
          hasUnreadUpdate: event.hasUnreadUpdate,
        });
        return;
      }
      case "create_group": {
        this.createGroup(event.title);
        return;
      }
      case "select_group": {
        this.selectGroup(event.groupId);
        return;
      }
      case "update_group": {
        this.updateGroup(event.groupId, event.title);
        return;
      }
      case "delete_group": {
        this.deleteGroup(event.groupId);
        return;
      }
      case "select_thread": {
        this.selectThread(event.threadId);
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
          this.emitThreadUpdated(activeThread.id, "thread");
        } else {
          this.store.setProvider(provider);
          this.createThread({ provider, groupId: this.store.getActiveGroupId() ?? activeThread.groupId });
          void this.ensureRuntimeRunning("startup");
          return;
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
        void this.sendMessage(event.threadId, event.content);
        return;
      }
      case "stop_thread": {
        void this.stopThread(event.threadId);
        return;
      }
      case "update_thread": {
        this.updateThread(event.threadId, event.updates);
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
        this.resolvePermissionRequest(event.requestId, event.decision, {
          secretValue: event.secretValue ?? null,
        });
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
  ): Promise<{ secretValue?: string | null }> {
    return await new Promise<{ secretValue?: string | null }>((resolve, reject) => {
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
    payload?: {
      secretValue?: string | null;
    },
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
      pending.resolve(payload ?? {});
      return;
    }

    const action =
      pending.request.kind === "host_mcp_mutation" ||
      pending.request.kind === "plugin_mutation"
        ? pending.request.action
        : "store";
    pending.reject(
      new Error(
        pending.request.kind === "host_mcp_mutation"
          ? `User denied permission to ${action} host MCP server ${pending.request.serverId}.`
          : pending.request.kind === "plugin_mutation"
            ? `User denied permission to ${action} plugin ${pending.request.targetPluginId}.`
          : `User denied permission to store secret ${pending.request.secretRef}.`,
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

  private ensureDefaultThreadPanels(): void {}

  private reconcileWorkbenchState(): void {
    const extensionSnapshot = this.extensionHost.getSnapshot(
      this.getExtensionActivationContext(),
    );
    const validViewIds = new Set(extensionSnapshot.views.map((view) => view.id));
    const activeViewId = this.store.getActiveViewId();

    if (activeViewId && !validViewIds.has(activeViewId)) {
      this.store.setActiveView(null);
    }
  }

  private async handleRefreshPlugins(): Promise<void> {
    try {
      await this.extensionHost.refresh(this.getExtensionActivationContext());
      this.reconcileDeclaredPluginAgentAssets();
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

  private reconcileDeclaredPluginAgentAssets(): void {
    const plugins = this.listInstalledPlugins().flatMap((plugin) => {
      try {
        const manifest = readPluginManifestFromDirectory(plugin.path);
        return [{
          pluginId: plugin.id,
          pluginName: plugin.name,
          pluginVersion: plugin.version,
          enabled: plugin.enabled && plugin.compatibility.compatible,
          agentAssets: manifest.agentAssets,
        }];
      } catch {
        return [];
      }
    });

    reconcilePluginAgentAssets({
      runtimeDirectory: this.runtimeManager.getRuntimeDirectory(),
      plugins,
    });
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
    const defaultThreadViewId = this.extensionHost.getDefaultViewId("thread");
    if (!defaultThreadViewId) {
      return false;
    }
    this.store.activateThreadView(threadId, defaultThreadViewId);
    return true;
  }

  private resolveLocalPreviewFilePath(target: Extract<DesktopPreviewTarget, { kind: "file" }>): string | null {
    const trimmedPath = target.path.trim();
    if (!trimmedPath) {
      return null;
    }

    const transferredPreview = normalizeTransferredPreviewPath(trimmedPath);
    if (target.source === "upload" || target.source === "output" || transferredPreview) {
      if (existsSync(trimmedPath) && statSync(trimmedPath).isFile()) {
        return trimmedPath;
      }

      const source = transferredPreview?.source ?? target.source;
      const relativePath = (transferredPreview?.path ?? trimmedPath).replace(/^\/+/, "");
      if (!relativePath || (source !== "upload" && source !== "output")) {
        return null;
      }

      const localPath = resolve(
        this.dataDirectory,
        "transfers",
        source === "upload" ? "uploads" : "outputs",
        relativePath,
      );
      if (!existsSync(localPath) || !statSync(localPath).isFile()) {
        return null;
      }
      return localPath;
    }

    const providerHomeMatch = trimmedPath.match(/^\/data\/providers\/([^/]+)\/home\/(.+)$/);
    if (providerHomeMatch) {
      const [, providerId, relativePath] = providerHomeMatch;
      const localPath = resolve(
        this.runtimeManager.getRuntimeDirectory(),
        "providers",
        providerId,
        "home",
        relativePath,
      );
      if (!existsSync(localPath) || !statSync(localPath).isFile()) {
        return null;
      }
      return localPath;
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

    const normalizedTransferPath =
      target.source === "upload" && trimmedPath.startsWith("/mnt/user-uploads/")
        ? trimmedPath.slice("/mnt/user-uploads/".length)
        : target.source === "output" && trimmedPath.startsWith("/mnt/user-outputs/")
          ? trimmedPath.slice("/mnt/user-outputs/".length)
          : trimmedPath;
    const transferRoot =
      target.source === "upload"
        ? this.runtimeManager.getUserUploadsDirectory()
        : this.runtimeManager.getUserOutputsDirectory();
    const candidatePath = resolve(
      transferRoot,
      normalizedTransferPath.replace(/^\/+/, ""),
    );
    if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
      return candidatePath;
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
    const renderer = this.extensionHost.resolvePreviewRenderer(item.target);
    return {
      ...item,
      title,
      src: this.resolvePreviewSource(item.target),
      contentType:
        item.target.kind === "file"
          ? item.target.contentType ?? item.contentType ?? null
          : null,
      renderer,
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
    this.emitThreadUpdated(threadId, "message");
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
    this.store.updateThread(threadId, {
      status: "in_progress",
      lane: "in_progress",
      archivedAt: null,
      hasUnreadUpdate: false,
    });
    this.emitSnapshot();
    this.emitThreadUpdated(threadId, "message");
    if (activeRun) {
      void this.forwardPromptToActiveThread(threadId, promptContent, activeRun);
      return;
    }

    const nextActiveRun: ActiveThreadRun = {
      stopRequested: false,
    };
    this.activeThreadRuns.set(threadId, nextActiveRun);
    this.emitThreadUpdated(threadId, "session");
    try {
      await this.processThreadTurn(threadId, promptContent, nextActiveRun);
    } finally {
      this.activeThreadRuns.delete(threadId);
      this.emitThreadUpdated(threadId, "session");
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
    const processEnv = this.extensionHost.getResolvedProcessEnv(provider.id);

    try {
      await this.runtimeManager.streamPrompt({
        provider,
        threadId,
        content,
        model,
        sessionId: providerSessionId,
        processEnv,
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

  private async requestThreadStop(threadId: string): Promise<void> {
    const activeRun = this.activeThreadRuns.get(threadId);
    if (!activeRun || activeRun.stopRequested) {
      return;
    }

    activeRun.stopRequested = true;
    this.emitThreadUpdated(threadId, "session");
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
      this.emitThreadUpdated(threadId, "session");
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
    const processEnv = this.extensionHost.getResolvedProcessEnv(provider.id);

    try {
      const assistant = this.store.appendMessage(
        threadId,
        "assistant",
        "",
        "streaming",
      );
      assistantId = assistant.id;
      this.emitSnapshot();
      this.emitThreadUpdated(threadId, "session");

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
        processEnv,
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
      this.store.updateThread(threadId, {
        status: "ready_for_review",
        lane: "ready_for_review",
        archivedAt: null,
        hasUnreadUpdate: true,
      });

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
      this.emitThreadUpdated(threadId, "message");
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
        this.store.updateThread(threadId, {
          status: "ready_for_review",
          lane: "ready_for_review",
          archivedAt: null,
          hasUnreadUpdate: true,
        });
        this.emitSnapshot();
        this.emitThreadUpdated(threadId, "message");
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
