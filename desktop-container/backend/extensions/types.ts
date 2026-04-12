import type {
  DesktopHarness,
  DesktopModel,
  DesktopPreviewTarget,
  DesktopPluginHostPanelData,
  DesktopPluginPermission,
  DesktopPluginRecord,
  DesktopProvider,
  DesktopRuntimeStatus,
  DesktopThreadPreviewState,
  DesktopView,
} from "../../../desktop/shared/protocol";
import type {
  CamelAIHarnessAdapterInfo,
} from "./harness-adapters";
import type {
  AgentExtensionThreadStateStore,
} from "./thread-state";

export type CamelAIThreadStateValue =
  | null
  | boolean
  | number
  | string
  | CamelAIThreadStateValue[]
  | { [key: string]: CamelAIThreadStateValue };

export interface CamelAIThreadRecord {
  id: string;
  groupId: string;
  provider: DesktopProvider;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string | null;
  status: string | null;
  lane: string | null;
  archivedAt: number | null;
  hasUnreadUpdate: boolean;
  active: boolean;
  hasMessages: boolean;
  sessionId: string | null;
  isRunning: boolean;
  stopRequested: boolean;
}

export interface CamelAIThreadCreateOptions {
  title?: string;
  groupId?: string;
  provider?: DesktopProvider;
  status?: string | null;
  lane?: string | null;
  archivedAt?: number | null;
  hasUnreadUpdate?: boolean;
}

export interface CamelAIThreadUpdate {
  title?: string | null;
  groupId?: string | null;
  status?: string | null;
  lane?: string | null;
  archivedAt?: number | null;
  hasUnreadUpdate?: boolean;
}

export type CamelAIThreadEvent =
  | {
      type: "thread_created";
      thread: CamelAIThreadRecord;
    }
  | {
      type: "thread_selected";
      thread: CamelAIThreadRecord;
    }
  | {
      type: "thread_updated";
      thread: CamelAIThreadRecord;
      reason: "message" | "thread" | "selection" | "session";
    };

export type CamelAIThreadEventHandler = (
  event: CamelAIThreadEvent,
) => unknown | Promise<unknown>;

export const CAMELAI_CURRENT_API_VERSION = 1;

export type CamelAISettingFieldType =
  | "boolean"
  | "number"
  | "secret"
  | "select"
  | "string";

export interface CamelAISettingFieldOption {
  label: string;
  value: string;
}

export interface CamelAISettingsField {
  type: CamelAISettingFieldType;
  label: string;
  description?: string;
  required?: boolean;
  options?: CamelAISettingFieldOption[];
}

export interface CamelAISettingsSchema {
  description?: string;
  fields: Record<string, CamelAISettingsField>;
}

export interface CamelAIDisposable {
  dispose(): void | Promise<void>;
}

export type CamelAIDisposableLike =
  | CamelAIDisposable
  | (() => void | Promise<void>);

export interface CamelAIManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  icon?: string;
  main?: string;
  webviews?: Record<string, string>;
  apiVersion?: number;
  minApiVersion?: number;
  permissions?: DesktopPluginPermission[];
  disableable?: boolean;
  settings?: string | CamelAISettingsSchema;
  agentAssets?: {
    skillsPath: string | null;
    mcpServersPath: string | null;
  } | null;
}

export interface DiscoveredCamelAIExtension {
  id: string;
  extensionPath: string;
  entryPath: string;
  builtin: boolean;
  packageName: string;
  packageVersion: string;
  manifest: CamelAIManifest;
}

export interface CamelAIActivationContext {
  provider: DesktopProvider;
  harness: DesktopHarness;
  model: DesktopModel;
  activeThreadId: string | null;
  activeGroupId: string | null;
  runtimeStatus: DesktopRuntimeStatus;
  runtimeDirectory: string | null;
  workspaceDirectory: string;
  threadStateDirectory: string | null;
}

export interface CamelAIViewRenderContext extends CamelAIActivationContext {
  pluginId: string;
  viewId: string;
  threadState: AgentExtensionThreadStateStore;
  plugin: DesktopPluginRecord;
}

export interface CamelAICommandContext extends CamelAIActivationContext {
  pluginId: string;
  threadId: string | null;
  threadState: AgentExtensionThreadStateStore;
}

export interface CamelAIToolExecutionContext {
  harness: DesktopHarness;
  pluginId: string;
  threadId?: string;
  workspacePath: string;
  threadState: AgentExtensionThreadStateStore;
}

export interface CamelAIMcpServerSessionContext extends CamelAIActivationContext {
  pluginId: string;
  serverId: string;
  sessionId: string;
  threadState(threadId?: string | null): AgentExtensionThreadStateStore;
}

export interface CamelAIViewRegistration {
  title: string;
  description?: string;
  icon?: string;
  scope?: "thread" | "workspace";
  default?: boolean;
  render:
    | { kind: "host"; component: string }
    | { kind: "webview"; webviewId: string };
  buildHostData?: (
    context: CamelAIViewRenderContext,
  ) => DesktopPluginHostPanelData;
}

export interface CamelAISidebarPanelRegistration {
  title: string;
  description?: string;
  icon?: string;
  placement?: "content" | "footer";
  order?: number;
  render: { kind: "host"; component: string };
  buildHostData?: (
    context: CamelAIViewRenderContext,
  ) => DesktopPluginHostPanelData;
}

export interface CamelAICommandRegistration {
  title: string;
  description?: string;
  run?: (context: CamelAICommandContext) => Promise<void> | void;
}

export interface CamelAIToolRegistration<TParams = unknown, TResult = unknown> {
  title?: string;
  description?: string;
  schema?: unknown;
  availableTo?: Array<DesktopHarness | "*">;
  execute?: (
    params: TParams,
    context: CamelAIToolExecutionContext,
  ) => Promise<TResult>;
}

export interface CamelAIHttpRequest {
  method: string;
  url: string;
  pathname: string;
  search: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: string | null;
}

export interface CamelAIHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface CamelAIHttpRouteExecutionContext {
  harness: DesktopHarness;
  pluginId: string;
  routeId: string;
  threadId: string | null;
  workspacePath: string;
  mountPath: string;
  threadState: AgentExtensionThreadStateStore;
}

export interface CamelAIHttpRouteRegistration {
  title?: string;
  description?: string;
  methods?: string[];
  handle?: (
    request: CamelAIHttpRequest,
    context: CamelAIHttpRouteExecutionContext,
  ) => Promise<CamelAIHttpResponse> | CamelAIHttpResponse;
}

export type CamelAIHttpProxyAuth =
  | {
      type: "none";
    }
  | {
      type: "bearer";
      secretRef: string;
      headerName?: string;
    }
  | {
      type: "header";
      headerName: string;
      secretRef: string;
    };

export interface CamelAIHttpProxyRegistration {
  title?: string;
  description?: string;
  baseUrl: string;
  methods?: string[];
  headers?: Record<string, string>;
  auth?: CamelAIHttpProxyAuth | null;
  stripRequestHeaders?: string[];
  timeoutMs?: number;
  maxBodyBytes?: number;
}

export type CamelAIProcessEnvValue =
  | string
  | {
      kind: "httpUrl";
      target: "route" | "proxy";
      id: string;
      path?: string;
    };

export interface CamelAIProcessEnvRegistration {
  title?: string;
  description?: string;
  providers?: Array<DesktopProvider | "*">;
  vars: Record<string, CamelAIProcessEnvValue>;
}

export type CamelAIResolvedProcessEnvValue =
  | {
      kind: "literal";
      value: string;
    }
  | {
      kind: "httpUrl";
      pluginId: string;
      target: "route" | "proxy";
      id: string;
      path: string;
    };

export type CamelAIResolvedProcessEnvMap = Record<string, CamelAIResolvedProcessEnvValue>;

export interface CamelAIHostMcpSessionServer {
  connect(transport: any): Promise<void>;
  close(): Promise<void>;
}

export interface CamelAIMcpServerRegistration {
  name?: string;
  version?: string;
  description?: string;
  createServer: (
    context: CamelAIMcpServerSessionContext,
  ) => CamelAIHostMcpSessionServer;
}

/** @deprecated Use CamelAIMcpServerRegistration with registerMcpServer(id, registration). */
export interface CamelAIHostMcpServerRegistration
  extends CamelAIMcpServerRegistration {
  id: string;
}

export type CamelAIPreviewSelector =
  | {
      kind: "fileExtension";
      value: string;
    }
  | {
      kind: "glob";
      value: string;
    }
  | {
      kind: "mime";
      value: string;
    }
  | {
      kind: "url";
      value: string;
    }
  | {
      kind: "urlHost";
      value: string;
    }
  | {
      kind: "urlRegex";
      value: string;
    };

export type CamelAIPreviewProviderPriority = "option" | "default" | "builtin";

export interface CamelAIPreviewProviderRegistration {
  title: string;
  description?: string;
  selectors: CamelAIPreviewSelector[];
  priority?: CamelAIPreviewProviderPriority;
  render: {
    kind: "webview";
    webviewId: string;
  };
}
export interface CamelAIHostMcpOAuthConfig {
  clientId: string | null;
  clientSecretRef: string | null;
  clientName: string | null;
  clientUri: string | null;
  clientMetadataUrl: string | null;
  scope: string | null;
  tokenEndpointAuthMethod: string | null;
}

export interface CamelAIPersistedHostMcpStdioServerRecord {
  id: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  envSecretRefs: Record<string, string>;
  name: string | null;
  version: string | null;
}

export interface CamelAIPersistedHostMcpHttpServerRecord {
  id: string;
  transport: "streamable-http" | "sse";
  url: string;
  headers: Record<string, string>;
  headerSecretRefs: Record<string, string>;
  oauth: CamelAIHostMcpOAuthConfig | null;
  name: string | null;
  version: string | null;
}

export type CamelAIPersistedHostMcpServerRecord =
  | CamelAIPersistedHostMcpStdioServerRecord
  | CamelAIPersistedHostMcpHttpServerRecord;

export type CamelAIInstallHostMcpServerResult = CamelAIPersistedHostMcpServerRecord & {
  configPath: string;
  replaced: boolean;
};

export interface CamelAIInstallStdioHostMcpServerOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  envSecretRefs?: Record<string, string>;
  name?: string | null;
  version?: string | null;
}

export interface CamelAIHostMcpMutationContext {
  pluginId: string;
  harness: DesktopHarness;
  threadId: string | null;
  workspaceDirectory: string;
}

export interface CamelAIHostPluginMutationContext {
  pluginId: string;
  harness: DesktopHarness;
  threadId: string | null;
  workspaceDirectory: string;
}

export interface CamelAIThreadPreviewMutationResult {
  threadId: string;
  state: DesktopThreadPreviewState;
}

export interface CamelAIInstallHttpHostMcpServerOptions {
  id: string;
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  headerSecretRefs?: Record<string, string>;
  oauth?: CamelAIHostMcpOAuthConfig | null;
  name?: string | null;
  version?: string | null;
}

export interface CamelAIPromptToStoreSecretOptions {
  secretRef?: string | null;
  title: string;
  message?: string | null;
  fieldLabel?: string | null;
}

export interface CamelAIStoredSecretResult {
  secretRef: string;
}

export interface CamelAIInstalledPluginRecord {
  id: string;
  name: string;
  version: string;
  source: "builtin" | "user";
  enabled: boolean;
  disableable: boolean;
  path: string;
}

export interface CamelAIInstallPluginResult {
  pluginId: string;
  pluginName: string;
  version: string;
  installPath: string;
  replaced: boolean;
}

export interface CamelAIInstallWorkspacePluginOptions {
  path: string;
}

export type CamelAIPluginAgentAssetProvider =
  | "codex"
  | "claude"
  | "pi"
  | "opencode";

export interface CamelAIPluginAgentSkillAssetRecord {
  id: string;
}

export interface CamelAIPluginAgentMcpServerAssetRecord {
  id: string;
  transport: "stdio" | "streamable-http" | "sse";
  name: string | null;
  version: string | null;
}

export interface CamelAIPluginAgentAssetInstallState {
  provider: CamelAIPluginAgentAssetProvider;
  installedSkillIds: string[];
  installedMcpServerIds: string[];
}

export interface CamelAIPluginAgentAssetsBundleRecord {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  source: "builtin" | "user";
  path: string;
  skills: CamelAIPluginAgentSkillAssetRecord[];
  mcpServers: CamelAIPluginAgentMcpServerAssetRecord[];
  installedByProvider: CamelAIPluginAgentAssetInstallState[];
}
export interface CamelAIBeforePromptEvent {
  type: "before_prompt";
  threadId: string;
  content: string;
}

export interface CamelAISessionStartEvent {
  type: "session_start";
  threadId: string;
}

export interface CamelAITurnStartEvent {
  type: "turn_start";
  threadId: string;
  content: string;
}

export interface CamelAITurnEndEvent {
  type: "turn_end";
  threadId: string;
  content: string;
  response: string;
}

export interface CamelAIPageOpenEvent {
  type: "page_open";
  pageId: string;
}

export interface CamelAIRuntimeReadyEvent {
  type: "runtime_ready";
}

export type CamelAIEvent =
  | CamelAIBeforePromptEvent
  | CamelAISessionStartEvent
  | CamelAITurnStartEvent
  | CamelAITurnEndEvent
  | CamelAIPageOpenEvent
  | CamelAIRuntimeReadyEvent;

export type CamelAIEventName = CamelAIEvent["type"];

export interface CamelAIBeforePromptResult {
  cancel?: boolean;
  prepend?: string;
  append?: string;
  content?: string;
}

export interface CamelAIEventContext extends CamelAIActivationContext {
  pluginId: string;
  threadId: string | null;
  threadState: AgentExtensionThreadStateStore;
}

export type CamelAIEventHandler = (
  event: CamelAIEvent,
  context: CamelAIEventContext,
) => unknown | Promise<unknown>;

export interface CamelAIPluginApi {
  readonly pluginId: string;
  readonly harnessAdapters: CamelAIHarnessAdapterInfo[];
  registerDisposable(disposable: CamelAIDisposableLike): CamelAIDisposable;
  on(event: CamelAIEventName, handler: CamelAIEventHandler): CamelAIDisposable;
  listThreads(): CamelAIThreadRecord[];
  getThread(threadId: string): CamelAIThreadRecord | null;
  subscribeThreadEvents(handler: CamelAIThreadEventHandler): CamelAIDisposable;
  selectThread(threadId: string): CamelAIThreadRecord;
  createThread(options?: CamelAIThreadCreateOptions): CamelAIThreadRecord;
  sendMessage(threadId: string, content: string): Promise<void>;
  stopThread(threadId: string): Promise<boolean>;
  updateThread(
    threadId: string,
    update: CamelAIThreadUpdate,
  ): CamelAIThreadRecord;
  registerView(id: string, view: CamelAIViewRegistration): CamelAIDisposable;
  registerSidebarPanel(
    id: string,
    panel: CamelAISidebarPanelRegistration,
  ): CamelAIDisposable;
  registerCommand(
    id: string,
    command: CamelAICommandRegistration,
  ): CamelAIDisposable;
  registerPreviewProvider(
    id: string,
    provider: CamelAIPreviewProviderRegistration,
  ): CamelAIDisposable;
  registerTool(id: string, tool: CamelAIToolRegistration): CamelAIDisposable;
  registerHttpRoute(
    id: string,
    route: CamelAIHttpRouteRegistration,
  ): CamelAIDisposable;
  registerHttpProxy(
    id: string,
    proxy: CamelAIHttpProxyRegistration,
  ): CamelAIDisposable;
  registerProcessEnv(
    id: string,
    registration: CamelAIProcessEnvRegistration,
  ): CamelAIDisposable;
  registerMcpServer(
    id: string,
    registration: CamelAIMcpServerRegistration,
  ): CamelAIDisposable;
  unregisterMcpServer(serverId: string): boolean;
  listInstalledHostMcpServers(): CamelAIPersistedHostMcpServerRecord[];
  installStdioHostMcpServer(
    server: CamelAIInstallStdioHostMcpServerOptions,
  ): Promise<CamelAIInstallHostMcpServerResult>;
  installHttpHostMcpServer(
    server: CamelAIInstallHttpHostMcpServerOptions,
  ): Promise<CamelAIInstallHostMcpServerResult>;
  promptToStoreSecret(
    options: CamelAIPromptToStoreSecretOptions,
  ): Promise<CamelAIStoredSecretResult>;
  uninstallInstalledHostMcpServer(serverId: string): Promise<boolean>;
  listInstalledPlugins(): CamelAIInstalledPluginRecord[];
  installPluginFromWorkspace(
    options: CamelAIInstallWorkspacePluginOptions,
  ): Promise<CamelAIInstallPluginResult>;
  listPluginAgentAssets(
    pluginId?: string | null,
  ): CamelAIPluginAgentAssetsBundleRecord[];
  openThreadPreviewItem(
    target: DesktopPreviewTarget,
    threadId?: string | null,
  ): CamelAIThreadPreviewMutationResult;
  setThreadPreviewItems(
    targets: DesktopPreviewTarget[],
    options?: {
      threadId?: string | null;
      activeIndex?: number | null;
    },
  ): CamelAIThreadPreviewMutationResult;
  clearThreadPreview(threadId?: string | null): CamelAIThreadPreviewMutationResult;
  setThreadPreviewVisibility(
    visible: boolean,
    threadId?: string | null,
  ): CamelAIThreadPreviewMutationResult;
  threadState(threadId?: string | null): AgentExtensionThreadStateStore;
}

export interface CamelAIExtensionModule {
  activate?: (
    api: CamelAIPluginApi,
  ) => void | Promise<void> | CamelAIDisposableLike;
  deactivate?: () => void | Promise<void>;
}

export interface CamelAIRuntimeRecord {
  discovered: DiscoveredCamelAIExtension;
  enabled: boolean;
  activated: boolean;
  activationError: string | null;
  compatibilityError: string | null;
  views: Map<string, CamelAIViewRegistration>;
  sidebarPanels: Map<string, CamelAISidebarPanelRegistration>;
  commands: Map<string, CamelAICommandRegistration>;
  previewProviders: Map<string, CamelAIPreviewProviderRegistration>;
  tools: Map<string, CamelAIToolRegistration>;
  httpRoutes: Map<string, CamelAIHttpRouteRegistration>;
  httpProxies: Map<string, CamelAIHttpProxyRegistration>;
  processEnvs: Map<string, CamelAIProcessEnvRegistration>;
  handlers: Map<CamelAIEventName, CamelAIEventHandler[]>;
  disposables: CamelAIDisposable[];
  deactivate?: (() => void | Promise<void>) | null;
  registeredHostMcpServerIds: Set<string>;
}

export interface CamelAIMatchedHttpProxyRequest {
  pluginId: string;
  proxyId: string;
  mountPath: string;
  path: string;
  request: CamelAIHttpRequest;
  proxy: CamelAIHttpProxyRegistration;
}

export type CamelAIHttpDispatchResult =
  | {
      type: "response";
      response: CamelAIHttpResponse;
    }
  | {
      type: "proxy";
      proxy: CamelAIMatchedHttpProxyRequest;
    }
  | null;
