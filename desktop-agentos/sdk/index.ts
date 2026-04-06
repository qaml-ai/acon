export type CamelAIHarness = "pi" | "opencode" | "claude-code" | "codex";
export type CamelAIThreadStateValue =
  | null
  | boolean
  | number
  | string
  | CamelAIThreadStateValue[]
  | { [key: string]: CamelAIThreadStateValue };

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
  settings?: string;
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

export interface CamelAIPanelRegistration {
  title: string;
  description?: string;
  icon?: string;
  autoOpen?: "never" | "new-thread" | "all-threads";
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

export type CamelAIEventName =
  | "runtime_ready"
  | "session_start"
  | "before_prompt"
  | "turn_start"
  | "turn_end"
  | "page_open"
  | "preview_open";

export interface CamelAIActivationApi {
  readonly pluginId: string;
  readonly harnessAdapters: CamelAIHarnessAdapterInfo[];
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
  ): void;
  registerView(id: string, view: CamelAIViewRegistration): void;
  registerPanel(id: string, panel: CamelAIPanelRegistration): void;
  registerCommand(id: string, command: CamelAICommandRegistration): void;
  registerTool<TParams = unknown, TResult = unknown>(
    id: string,
    tool: CamelAIToolRegistration<TParams, TResult>,
  ): void;
  threadState(threadId?: string | null): CamelAIThreadStateStore;
}

export interface CamelAIExtensionModule {
  activate(api: CamelAIActivationApi): void | Promise<void>;
}
