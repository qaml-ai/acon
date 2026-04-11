export type CamelAIHarness = "opencode" | "claude-code" | "codex" | "pi";
export type CamelAIProvider = "claude" | "codex" | "pi" | "opencode";
export const CAMELAI_PLUGIN_API_VERSION = 1;
export type CamelAIPermission =
  | "host-mcp"
  | "host-plugins"
  | "serve-mcp"
  | "thread-preview";
export type CamelAISettingFieldType =
  | "boolean"
  | "number"
  | "secret"
  | "select"
  | "string";
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
  provider: CamelAIProvider;
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
  provider?: CamelAIProvider;
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

export interface CamelAIThreadStateStore {
  readonly pluginId: string;
  readonly threadId: string | null;
  get<T extends CamelAIThreadStateValue = CamelAIThreadStateValue>(
    key: string,
  ): T | undefined;
  set(key: string, value: CamelAIThreadStateValue): void;
  delete(key: string): void;
  clear(): void;
  snapshot(): Record<string, CamelAIThreadStateValue>;
}

export interface CamelAIManifest {
  id: string;
  name?: string;
  description?: string;
  icon?: string;
  main?: string;
  webviews?: Record<string, string>;
  apiVersion?: number;
  minApiVersion?: number;
  permissions?: CamelAIPermission[];
  disableable?: boolean;
  settings?: string | CamelAISettingsSchema;
  agentAssets?: {
    skillsPath: string | null;
    mcpServersPath: string | null;
  } | null;
}

export interface CamelAIHarnessAdapterInfo {
  id: CamelAIHarness;
  label: string;
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
}

export interface CamelAISidebarPanelRegistration {
  title: string;
  description?: string;
  icon?: string;
  placement?: "content" | "footer";
  order?: number;
  render: { kind: "host"; component: string };
}

export interface CamelAICommandRegistration {
  title: string;
  description?: string;
  run?: (context: {
    pluginId: string;
    threadId: string | null;
    threadState: CamelAIThreadStateStore;
  }) => Promise<void> | void;
}

export interface CamelAIToolExecutionContext {
  harness: CamelAIHarness;
  pluginId: string;
  threadId?: string;
  workspacePath: string;
  threadState: CamelAIThreadStateStore;
}

export interface CamelAIToolRegistration<TParams = unknown, TResult = unknown> {
  title?: string;
  description?: string;
  schema?: unknown;
  availableTo?: Array<CamelAIHarness | "*">;
  execute?: (
    params: TParams,
    context: CamelAIToolExecutionContext,
  ) => Promise<TResult>;
}

export interface CamelAIMcpServerSessionContext {
  pluginId: string;
  serverId: string;
  sessionId: string;
  harness: CamelAIHarness;
  activeThreadId: string | null;
  runtimeStatus: {
    state: string;
    detail: string;
    runtimeDirectory?: string | null;
  };
  runtimeDirectory: string | null;
  workspaceDirectory: string;
  threadState(threadId?: string | null): CamelAIThreadStateStore;
}

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
export type CamelAIPreviewTarget =
  | {
      kind: "file";
      source: "workspace" | "upload" | "output";
      workspaceId?: string | null;
      path: string;
      filename?: string | null;
      title?: string | null;
      contentType?: string | null;
    }
  | {
      kind: "url";
      url: string;
      title?: string | null;
    };

export interface CamelAIPreviewItem {
  id: string;
  title: string;
  target: CamelAIPreviewTarget;
}

export interface CamelAIThreadPreviewState {
  visible: boolean;
  activeItemId: string | null;
  items: CamelAIPreviewItem[];
}

export interface CamelAIThreadPreviewMutationResult {
  threadId: string;
  state: CamelAIThreadPreviewState;
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

export type CamelAIInstallHostMcpServerResult =
  CamelAIPersistedHostMcpServerRecord & {
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

export type CamelAIPluginAgentAssetProvider = "codex" | "claude";

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
export type CamelAIEventName =
  | "runtime_ready"
  | "session_start"
  | "before_prompt"
  | "turn_start"
  | "turn_end"
  | "page_open";

export interface CamelAIActivationApi {
  readonly pluginId: string;
  readonly harnessAdapters: CamelAIHarnessAdapterInfo[];
  registerDisposable(disposable: CamelAIDisposableLike): CamelAIDisposable;
  on(
    event: CamelAIEventName,
    handler: (
      event: { type: CamelAIEventName; [key: string]: unknown },
      context: {
        pluginId: string;
        threadId: string | null;
        threadState: CamelAIThreadStateStore;
      },
    ) => Promise<unknown> | unknown,
  ): CamelAIDisposable;
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
  registerTool<TParams = unknown, TResult = unknown>(
    id: string,
    tool: CamelAIToolRegistration<TParams, TResult>,
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
    target: CamelAIPreviewTarget,
    threadId?: string | null,
  ): CamelAIThreadPreviewMutationResult;
  setThreadPreviewItems(
    targets: CamelAIPreviewTarget[],
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
  threadState(threadId?: string | null): CamelAIThreadStateStore;
}

export interface CamelAIExtensionModule {
  activate?(
    api: CamelAIActivationApi,
  ): void | Promise<void> | CamelAIDisposableLike;
  deactivate?(): void | Promise<void>;
}
