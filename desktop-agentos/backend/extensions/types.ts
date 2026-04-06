import type {
  DesktopHarness,
  DesktopModel,
  DesktopPluginHostPanelData,
  DesktopPluginRecord,
  DesktopProvider,
  DesktopRuntimeStatus,
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

export interface CamelAIPageRenderContext extends CamelAIActivationContext {
  pluginId: string;
  pageId: string;
  threadState: AgentExtensionThreadStateStore;
  plugin: DesktopPluginRecord;
}

export interface CamelAIPreviewRenderContext extends CamelAIActivationContext {
  pluginId: string;
  previewId: string;
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

export interface CamelAIPageRegistration {
  title: string;
  description?: string;
  icon?: string;
  render:
    | { kind: "host"; component: string }
    | { kind: "webview"; webviewId: string };
  buildHostData?: (
    context: CamelAIPageRenderContext,
  ) => DesktopPluginHostPanelData;
}

export interface CamelAIPreviewPaneRegistration {
  title: string;
  description?: string;
  icon?: string;
  autoOpen?: "never" | "new-thread" | "all-threads";
  render:
    | { kind: "host"; component: string }
    | { kind: "webview"; webviewId: string };
  buildHostData?: (
    context: CamelAIPreviewRenderContext,
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
  registerPage(id: string, page: CamelAIPageRegistration): void;
  registerPreviewPane(id: string, preview: CamelAIPreviewPaneRegistration): void;
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
  pages: Map<string, CamelAIPageRegistration>;
  previewPanes: Map<string, CamelAIPreviewPaneRegistration>;
  commands: Map<string, CamelAICommandRegistration>;
  tools: Map<string, CamelAIToolRegistration>;
  handlers: Map<CamelAIEventName, CamelAIEventHandler[]>;
}

