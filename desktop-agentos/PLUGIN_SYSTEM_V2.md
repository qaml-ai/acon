# AgentOS Plugin System V2

This document proposes the next version of the AgentOS desktop plugin system.

V2 is meant to combine:

- the workbench and packaging strengths of VS Code extensions
- the runtime and lifecycle strengths of Pi extensions
- the desktop-specific surfaces we already need in camelAI

This is a target design, not a description of the current implementation.

## Goal

Build a plugin platform where:

- plugins can add full pages to the app shell
- plugins can render into a chat-owned right preview pane
- plugins can extend the live agent runtime with tools, commands, hooks, and providers
- the same plugin can work across Pi, Codex, Claude Code, and OpenCode through adapters
- manifests stay lightweight and stable
- most real behavior is registered imperatively in code

## Design Summary

V2 should be:

- VS Code-like for discovery, installability, commands, pages, webviews, and storage
- Pi-like for tools, lifecycle hooks, provider extension, and runtime interception

In one line:

```text
VS Code shell + Pi runtime core
```

## Non-Goals

V2 should not try to become:

- a full VS Code contribution-point clone
- a desktop-only page registry with no runtime hooks
- a Pi clone that ignores our app-shell and chat-preview needs

## Mental Model

There are three layers:

```text
┌───────────────────────────────────────────────────────┐
│ Package Layer                                         │
│ manifest, install metadata, icons, entrypoints        │
└───────────────────┬───────────────────────────────────┘
                    │
                    v
┌───────────────────────────────────────────────────────┐
│ Runtime Layer                                         │
│ tools, commands, hooks, providers, thread state       │
└───────────────────┬───────────────────────────────────┘
                    │
                    v
┌───────────────────────────────────────────────────────┐
│ Surface Layer                                         │
│ app pages, left nav items, chat preview panes,        │
│ webviews, host-rendered panels                        │
└───────────────────────────────────────────────────────┘
```

The key V2 rule:

```text
Manifest discovers the plugin.
Activation defines the plugin.
Runtime events drive the plugin.
Host surfaces display the plugin.
```

## Core Principles

## 1. Manifest is metadata, not behavior

The manifest should only answer:

- what is this package
- how do we load it
- what icons/resources/settings schema does it expose

It should not be the primary place where runtime capability is declared.

## 2. Activation API is the real contract

The primary plugin contract should be the TypeScript activation API.

That is where plugins register:

- commands
- tools
- pages
- preview panes
- providers
- lifecycle handlers
- message renderers

## 3. Unified runtime events come before harness specifics

Plugins should write against one event model.

Harness adapters should translate native Pi/Codex/Claude/OpenCode behavior into that unified model.

## 4. App pages and chat previews are different surfaces

We should preserve the product split:

- left nav plugin item opens a full plugin page in the main area
- right preview pane belongs to a specific chat thread

Those are separate surfaces and separate pieces of state.

## 5. Thread state is first-class

Plugins need durable thread-scoped state, not just ephemeral render props.

That state should be available to:

- host-rendered panels
- plugin webviews through a bridge
- tool execution
- lifecycle event handlers

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│ Electron Main                                                   │
│                                                                 │
│ - extension asset protocol                                      │
│ - sandboxed webview hosting                                     │
│ - preload bridge                                                │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────────────────┐
│ Desktop Service                                                 │
│                                                                 │
│ - thread/message state                                          │
│ - nav state                                                     │
│ - thread preview state                                          │
│ - extension runtime host                                        │
│ - harness adapter orchestration                                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────────────────┐
│ Extension Runtime Host                                          │
│                                                                 │
│ - manifest discovery                                            │
│ - module loading                                                │
│ - activation                                                    │
│ - event bus                                                     │
│ - command/tool/provider registration                            │
│ - storage access                                                │
│ - page/preview registration                                     │
└───────────────┬───────────────────────┬─────────────────────────┘
                │                       │
                v                       v
┌───────────────────────────┐   ┌─────────────────────────────────┐
│ Surface Registry          │   │ Harness Adapters                │
│                           │   │                                 │
│ - pages                   │   │ - Pi                            │
│ - left nav items          │   │ - Codex                         │
│ - preview panes           │   │ - Claude Code                   │
│ - webviews                │   │ - OpenCode                      │
└───────────────────────────┘   └─────────────────────────────────┘
```

## Package Model

V2 manifest should be intentionally small.

Example:

```json
{
  "name": "@camelai/random-site-companion",
  "version": "0.1.0",
  "camelai": {
    "id": "random-site-companion",
    "name": "Random Site Companion",
    "icon": "./icon.png",
    "main": "./index.ts",
    "webviews": {
      "random-site-frame": "./site/index.html"
    },
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "settings": "./settings.schema.json"
  }
}
```

The manifest may include:

- `id`
- `name`
- `icon`
- `main`
- `webviews`
- resource directories
- settings schema
- install compatibility metadata

The manifest should not need to enumerate:

- every tool
- every command
- every runtime hook
- every page and pane detail

Those should be registered from `activate()`.

## API Shape

V2 should expose one main activation object with three capability areas:

```ts
export interface CamelAIExtensionApi
  extends CamelAIRuntimeApi,
    CamelAISurfaceApi,
    CamelAIStorageApi {}
```

## Runtime API

```ts
export interface CamelAIRuntimeApi {
  readonly pluginId: string;
  readonly harnessAdapters: CamelAIHarnessAdapterInfo[];
  readonly events: CamelAIEventBus;

  on<E extends CamelAIEventName>(
    event: E,
    handler: CamelAIEventHandler<E>,
  ): CamelAIDisposable;

  registerTool<TParams = unknown, TResult = unknown>(
    id: string,
    tool: CamelAIToolRegistration<TParams, TResult>,
  ): CamelAIDisposable;

  registerCommand(
    id: string,
    command: CamelAICommandRegistration,
  ): CamelAIDisposable;

  registerProvider(
    id: string,
    provider: CamelAIProviderRegistration,
  ): CamelAIDisposable;

  registerMessageRenderer(
    type: string,
    renderer: CamelAIMessageRenderer,
  ): CamelAIDisposable;

  sendMessage(
    threadId: string,
    message: CamelAISystemMessage,
  ): Promise<void>;

  sendUserMessage(
    threadId: string,
    message: CamelAIUserMessage,
  ): Promise<void>;

  getThreadState(threadId?: string): CamelAIThreadStateStore;
}
```

## Surface API

```ts
export interface CamelAISurfaceApi {
  registerPage(
    id: string,
    page: CamelAIPageRegistration,
  ): CamelAIDisposable;

  registerPreviewPane(
    id: string,
    pane: CamelAIPreviewPaneRegistration,
  ): CamelAIDisposable;

  registerNavigationItem(
    id: string,
    item: CamelAINavigationItemRegistration,
  ): CamelAIDisposable;

  openPage(pageId: string, options?: { focus?: boolean }): Promise<void>;

  openPreviewPane(
    threadId: string,
    paneId: string,
    input?: CamelAIPreviewInput,
  ): Promise<void>;

  updatePreviewPane(
    threadId: string,
    patch: CamelAIPreviewStatePatch,
  ): Promise<void>;

  closePreviewPane(threadId: string): Promise<void>;
}
```

## Storage API

```ts
export interface CamelAIStorageApi {
  globalState: CamelAIKeyValueStore;
  workspaceState(workspaceId?: string): CamelAIKeyValueStore;
  threadState(threadId?: string): CamelAIThreadStateStore;
  secrets: CamelAISecretStore;
}
```

## Unified Event Model

This is the most important V2 addition.

Plugins need real lifecycle hooks.

```text
Session lifecycle
-----------------
session_start
session_resume
session_end

Turn lifecycle
--------------
before_turn
turn_start
turn_end

Prompt/provider lifecycle
-------------------------
before_prompt
before_harness_request
after_harness_response

Message lifecycle
-----------------
message_start
message_delta
message_end

Tool lifecycle
--------------
tool_call
tool_execution_start
tool_execution_update
tool_execution_end
tool_result

UI lifecycle
------------
page_open
page_close
preview_open
preview_update
preview_close

Process lifecycle
-----------------
runtime_ready
runtime_shutdown
```

## Event Contracts

Handlers should be able to:

- observe
- augment
- cancel
- rewrite specific payloads where safe

Example:

```ts
export interface CamelAIBeforePromptEvent {
  type: "before_prompt";
  threadId: string;
  messages: CamelAIChatMessage[];
}

export interface CamelAIBeforePromptResult {
  messages?: CamelAIChatMessage[];
  appendSystemMessages?: CamelAISystemMessage[];
  cancel?: boolean;
}
```

And:

```ts
api.on("before_prompt", async (event, ctx) => {
  const threadState = ctx.threadState;
  const mode = threadState.get<string>("analysisMode");
  if (mode === "strict") {
    return {
      appendSystemMessages: [
        {
          role: "system",
          content: "Use stricter verification and explicit assumptions."
        }
      ]
    };
  }
});
```

## Harness Adapter Model

Adapters should do more than tool-shape translation.

They should translate native harness behavior into the unified runtime model.

```text
Pi native events
        \
Codex native events
          \
Claude Code native events ---> Unified CamelAI runtime events
          /
OpenCode native events
        /
```

Each adapter should own:

- request lifecycle mapping
- message streaming mapping
- tool lifecycle mapping
- provider/model metadata mapping
- thread/session resume semantics
- interrupt semantics

Minimal adapter interface:

```ts
export interface CamelAIHarnessAdapter {
  id: "pi" | "codex" | "claude-code" | "opencode";
  supports: CamelAIHarnessCapabilities;

  attach(runtime: CamelAIAdapterRuntime): CamelAIDisposable;

  toUnifiedEvent(
    nativeEvent: unknown,
    context: CamelAIAdapterContext,
  ): CamelAIEvent | null;

  fromUnifiedTool(
    tool: CamelAIToolRegistration,
  ): CamelAINativeTool | null;
}
```

## Commands

VS Code gets this right: commands are a fundamental extension primitive.

We should add them explicitly.

```ts
export interface CamelAICommandRegistration {
  title: string;
  category?: string;
  when?: CamelAIEnablementExpression;
  run(context: CamelAICommandContext): Promise<void> | void;
}
```

Commands should be invokable from:

- command palette
- plugin pages
- chat UI controls
- keyboard shortcuts later

## Pages

Pages are app-shell surfaces.

They are not tied to a thread by default.

```ts
export interface CamelAIPageRegistration {
  title: string;
  icon?: string;
  route?: string;
  render:
    | { kind: "host"; component: string }
    | { kind: "webview"; webviewId: string };
  buildHostData?: (
    context: CamelAIPageRenderContext,
  ) => CamelAIHostPanelData;
}
```

Example uses:

- plugin manager
- connection browser
- workspace dashboard
- app deployment console

## Preview Panes

Preview panes are chat-owned.

They are part of thread state, not nav state.

```ts
export interface CamelAIPreviewPaneRegistration {
  title: string;
  icon?: string;
  autoOpen?: "never" | "new-thread" | "all-threads";
  render:
    | { kind: "host"; component: string }
    | { kind: "webview"; webviewId: string };
  resolveInput?: (
    context: CamelAIPreviewResolveContext,
  ) => Promise<CamelAIPreviewInput | undefined>;
  buildHostData?: (
    context: CamelAIPreviewRenderContext,
  ) => CamelAIHostPanelData;
}
```

The state model should stay:

```text
activeNavTarget = chat:<threadId> | page:<pluginId>/<pageId>

threadPreviewStateById[threadId] = {
  paneId: string;
  visible: boolean;
  input?: unknown;
}
```

## Webviews

We should keep the Electron isolation model.

But V2 webviews need a real bridge, closer to VS Code webviews.

```text
Host page / preview
        |
        v
sandboxed webview
        |
        v
preload bridge
        |
        +-- getThreadState()
        +-- setThreadState()
        +-- postMessage()
        +-- invokeCommand()
        +-- updatePreview()
```

V2 webview bridge should expose:

- read/write thread state
- page/preview context
- command invocation
- postMessage channel to host
- theme and host appearance info

## Storage Model

We should mirror the rough VS Code split:

- `globalState`
- `workspaceState`
- `threadState`
- `secrets`

For our app, `threadState` is the most important custom addition.

```text
Storage buckets
---------------
globalState      -> plugin-wide
workspaceState   -> current workspace / project
threadState      -> current chat thread
secrets          -> encrypted credentials/tokens
```

## Settings Model

Plugins should be able to contribute settings without needing a huge contribution-point framework.

Manifest should optionally point to a JSON schema file:

```json
{
  "camelai": {
    "settings": "./settings.schema.json"
  }
}
```

The host can merge those schemas into a plugin settings registry and expose:

```ts
export interface CamelAISettingsApi {
  get<T>(key: string): T | undefined;
  onDidChange<T>(key: string, handler: (value: T | undefined) => void): CamelAIDisposable;
}
```

## Proposed Example

Example plugin that adds:

- a full page
- a chat preview pane
- a command
- a tool
- a runtime hook

```ts
import type { CamelAIExtensionModule } from "@camelai/agent-hub";

const extension: CamelAIExtensionModule = {
  activate(api) {
    api.registerPage("launchpad", {
      title: "Launchpad",
      icon: "rocket",
      render: { kind: "webview", webviewId: "launchpad-app" },
    });

    api.registerPreviewPane("random-site", {
      title: "Random Site",
      autoOpen: "all-threads",
      render: { kind: "webview", webviewId: "random-site-frame" },
    });

    api.registerCommand("random-site.refresh", {
      title: "Refresh Random Site",
      async run(ctx) {
        const threadId = ctx.activeThreadId;
        if (!threadId) return;
        const store = api.threadState(threadId);
        store.delete("siteUrl");
        await api.openPreviewPane(threadId, "random-site");
      },
    });

    api.registerTool("pick_random_site", {
      title: "Pick Random Site",
      description: "Assign a random site to the active chat thread preview.",
      availableTo: ["pi", "codex", "claude-code", "opencode"],
      async execute(_params, ctx) {
        const sites = [
          "https://example.com",
          "https://developer.mozilla.org",
          "https://www.rfc-editor.org"
        ];
        const store = ctx.threadState;
        const selected = sites[Math.floor(Math.random() * sites.length)];
        store.set("siteUrl", selected);
        if (ctx.threadId) {
          await api.openPreviewPane(ctx.threadId, "random-site");
        }
        return { ok: true, siteUrl: selected };
      },
    });

    api.on("session_start", async (event, ctx) => {
      await api.openPreviewPane(event.threadId, "random-site");
    });
  },
};

export default extension;
```

## Why This Is Better

Compared to current AgentOS:

- richer runtime contract
- fewer manifest obligations
- cleaner separation of package metadata vs behavior
- direct path for tools, commands, and providers
- preview panes become runtime-controlled, not manifest-controlled

Compared to Pi:

- better app-shell model
- better navigation model
- explicit full-page vs thread-preview distinction
- stronger desktop webview story
- more structured storage buckets

Compared to VS Code:

- less bureaucratic
- more centered on live agent/runtime control
- built around thread-scoped chat state

## Compatibility Plan

We should migrate incrementally.

## Phase 1

Add the runtime event bus and `api.on(...)` without breaking current plugins.

Compatibility:

- keep current manifest field parsing
- keep `registerSidepanelPage(...)` as a compatibility alias to `registerPage(...)`

## Phase 2

Add command registration and preview registration.

Compatibility:

- keep current page registrations working
- map old default-preview flags into `autoOpen`

## Phase 3

Move tool declarations out of manifest and into activation code.

Compatibility:

- still read manifest tool metadata for older plugins
- prefer runtime registrations when both exist

## Phase 4

Add provider registration and richer harness lifecycle hooks.

## Phase 5

Add a proper webview host bridge for thread/page state and commands.

## Current-to-V2 Mapping

```text
Current                          -> V2
------------------------------------------------------------
registerSidepanelPage            -> registerPage
sidepanel entry in manifest      -> nav/page metadata + activate()
openInChatByDefault              -> registerPreviewPane({ autoOpen })
thread state store               -> threadState()
tool manifest metadata           -> registerTool()
Pi bridge export                 -> harness adapter runtime export
harness adapter tool shim        -> full lifecycle adapter
```

## Recommendation

The rewrite target should be:

```text
light manifest
+ runtime-first activation API
+ unified lifecycle events
+ desktop page surfaces
+ thread-owned preview panes
+ adapter-based harness portability
```

That is the version that is:

- more like Pi where it matters
- more like VS Code where it helps
- still correct for camelAI's desktop/chat product model

