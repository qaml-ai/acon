import type {
  DesktopHarness,
  DesktopModel,
  DesktopPluginHostPanelData,
  DesktopPluginPermission,
  DesktopPluginRecord,
  DesktopPanel,
  DesktopProvider,
  DesktopRuntimeStatus,
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

export interface CamelAIPanelRenderContext extends CamelAIActivationContext {
  pluginId: string;
  panelId: string;
  threadId: string | null;
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

export interface CamelAIPanelRegistration {
  title: string;
  description?: string;
  icon?: string;
  autoOpen?: "never" | "new-thread" | "all-threads";
  render:
    | { kind: "host"; component: string }
    | { kind: "webview"; webviewId: string };
  buildHostData?: (
    context: CamelAIPanelRenderContext,
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

export interface CamelAIHostMcpSessionServer {
  connect(transport: any): Promise<void>;
  close(): Promise<void>;
}

export interface CamelAIHostMcpServerRegistration {
  id: string;
  createServer: () => CamelAIHostMcpSessionServer;
}

export interface CamelAIHostMcpOAuthConfig {
  clientId: string | null;
  clientSecret: string | null;
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
  name: string | null;
  version: string | null;
}

export interface CamelAIPersistedHostMcpHttpServerRecord {
  id: string;
  transport: "streamable-http" | "sse";
  url: string;
  headers: Record<string, string>;
  oauth: CamelAIHostMcpOAuthConfig | null;
  name: string | null;
  version: string | null;
}

export type CamelAIPersistedHostMcpServerRecord =
  | CamelAIPersistedHostMcpStdioServerRecord
  | CamelAIPersistedHostMcpHttpServerRecord;

export interface CamelAIInstallHostMcpServerResult
  extends CamelAIPersistedHostMcpServerRecord {
  configPath: string;
  replaced: boolean;
}

export interface CamelAIInstallStdioHostMcpServerOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  name?: string | null;
  version?: string | null;
}

export interface CamelAIInstallHttpHostMcpServerOptions {
  id: string;
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  name?: string | null;
  version?: string | null;
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

export interface CamelAIPreviewOpenEvent {
  type: "preview_open";
  threadId: string;
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
  | CamelAIPreviewOpenEvent
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
  registerView(id: string, view: CamelAIViewRegistration): CamelAIDisposable;
  registerPanel(id: string, panel: CamelAIPanelRegistration): CamelAIDisposable;
  registerCommand(
    id: string,
    command: CamelAICommandRegistration,
  ): CamelAIDisposable;
  registerTool(id: string, tool: CamelAIToolRegistration): CamelAIDisposable;
  registerHostMcpServer(
    registration: CamelAIHostMcpServerRegistration,
  ): CamelAIDisposable;
  unregisterHostMcpServer(serverId: string): boolean;
  listInstalledHostMcpServers(): CamelAIPersistedHostMcpServerRecord[];
  installStdioHostMcpServer(
    server: CamelAIInstallStdioHostMcpServerOptions,
  ): CamelAIInstallHostMcpServerResult;
  installHttpHostMcpServer(
    server: CamelAIInstallHttpHostMcpServerOptions,
  ): CamelAIInstallHostMcpServerResult;
  uninstallInstalledHostMcpServer(serverId: string): boolean;
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
  panels: Map<string, CamelAIPanelRegistration>;
  commands: Map<string, CamelAICommandRegistration>;
  tools: Map<string, CamelAIToolRegistration>;
  handlers: Map<CamelAIEventName, CamelAIEventHandler[]>;
  disposables: CamelAIDisposable[];
  deactivate?: (() => void | Promise<void>) | null;
  registeredHostMcpServerIds: Set<string>;
}
