import type {
  DesktopHarness,
  DesktopModel,
  DesktopPluginHostPanelData,
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

export interface CamelAIManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  icon?: string;
  main?: string;
  webviews?: Record<string, string>;
  settings?: string;
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
  on(event: CamelAIEventName, handler: CamelAIEventHandler): void;
  registerView(id: string, view: CamelAIViewRegistration): void;
  registerPanel(id: string, panel: CamelAIPanelRegistration): void;
  registerCommand(id: string, command: CamelAICommandRegistration): void;
  registerTool(id: string, tool: CamelAIToolRegistration): void;
  threadState(threadId?: string | null): AgentExtensionThreadStateStore;
}

export interface CamelAIExtensionModule {
  activate?: (api: CamelAIPluginApi) => void | Promise<void>;
}

export interface CamelAIRuntimeRecord {
  discovered: DiscoveredCamelAIExtension;
  activated: boolean;
  activationError: string | null;
  views: Map<string, CamelAIViewRegistration>;
  panels: Map<string, CamelAIPanelRegistration>;
  commands: Map<string, CamelAICommandRegistration>;
  tools: Map<string, CamelAIToolRegistration>;
  handlers: Map<CamelAIEventName, CamelAIEventHandler[]>;
}
