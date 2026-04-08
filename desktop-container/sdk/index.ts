export type CamelAIHarness = "opencode" | "claude-code" | "codex";
export const CAMELAI_PLUGIN_API_VERSION = 1;
export type CamelAIPermission = "host-mcp" | "thread-preview";
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

export interface CamelAIHostMcpSessionServer {
  connect(transport: any): Promise<void>;
  close(): Promise<void>;
}

export interface CamelAIHostMcpServerRegistration {
  id: string;
  createServer: () => CamelAIHostMcpSessionServer;
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
  registerView(id: string, view: CamelAIViewRegistration): CamelAIDisposable;
  registerCommand(
    id: string,
    command: CamelAICommandRegistration,
  ): CamelAIDisposable;
  registerTool<TParams = unknown, TResult = unknown>(
    id: string,
    tool: CamelAIToolRegistration<TParams, TResult>,
  ): CamelAIDisposable;
  registerHostMcpServer(
    registration: CamelAIHostMcpServerRegistration,
  ): CamelAIDisposable;
  unregisterHostMcpServer(serverId: string): boolean;
  listInstalledHostMcpServers(): CamelAIPersistedHostMcpServerRecord[];
  installStdioHostMcpServer(
    server: CamelAIInstallStdioHostMcpServerOptions,
  ): Promise<CamelAIInstallHostMcpServerResult>;
  installHttpHostMcpServer(
    server: CamelAIInstallHttpHostMcpServerOptions,
  ): Promise<CamelAIInstallHostMcpServerResult>;
  uninstallInstalledHostMcpServer(serverId: string): Promise<boolean>;
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
