# pi-mono Plugin System Notes

This note summarizes the plugin system in `badlogic/pi-mono` and compares it to the current AgentOS desktop plugin system.

Inspected repo:

- `https://github.com/badlogic/pi-mono`
- commit: `773f91f40a36a3d7380fbb48bedba35993a556b8`

## Bottom Line

Pi's extension system is much more runtime-first than ours.

Our current system is centered on:

- manifest discovery
- page/pane registration
- bridge export into Pi
- desktop-specific capabilities

Pi is centered on:

- loading TypeScript modules directly
- giving them a large imperative runtime API
- letting them hook deeply into session, model, provider, tool, and UI lifecycles
- treating manifest metadata as minimal path discovery only

If we want ours to feel "a lot more like theirs", the main shift is:

```text
Current center of gravity:
manifest -> host snapshot -> UI/runtime bridge

Target center of gravity:
extension runtime API -> lifecycle hooks -> host surfaces/adapters
```

## What pi Actually Does

## 1. Discovery is lightweight

Pi discovers extensions from a few standard places:

```text
project/.pi/extensions/
global-agent-dir/extensions/
explicitly configured paths
```

Discovery rules are simple:

- direct `*.ts` or `*.js` files load as extensions
- a directory can expose `index.ts` or `index.js`
- a directory can have `package.json` with a small `pi` manifest

That manifest is only for entry/resource paths, not contribution-point declarations.

Example shape:

```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "themes": ["./themes"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

The important part is what is not in there:

- no tool declarations
- no command declarations
- no UI contribution schema
- no event declarations

Those are all registered in code at runtime.

## 2. Extensions are just TypeScript modules

An extension is a TS module with a default factory:

```ts
export default function (pi: ExtensionAPI) {
  // register runtime behavior here
}
```

That factory can:

- subscribe to events
- register tools
- register commands
- register keyboard shortcuts
- register CLI flags
- register message renderers
- register or override model providers
- send messages back into the session

## 3. Runtime API is the real plugin contract

Pi's `ExtensionAPI` is the core abstraction.

High-level shape:

```text
Extension Module
      |
      v
  ExtensionAPI
      |
      +-- on(event, handler)
      +-- registerTool(...)
      +-- registerCommand(...)
      +-- registerShortcut(...)
      +-- registerFlag(...)
      +-- registerMessageRenderer(...)
      +-- registerProvider(...)
      +-- sendMessage(...)
      +-- sendUserMessage(...)
      +-- appendEntry(...)
      +-- exec(...)
      +-- setSessionName(...)
      +-- setActiveTools(...)
      +-- setModel(...)
      +-- events (shared event bus)
```

This is a much larger and more powerful contract than our current `AgentHubActivationApi`.

## 4. Extensions hook into the agent lifecycle

Pi has a real event model, not just activation events.

Examples of runtime hooks:

- `resources_discover`
- `session_start`
- `session_before_switch`
- `session_before_fork`
- `session_before_compact`
- `session_shutdown`
- `context`
- `before_provider_request`
- `before_agent_start`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `tool_call`
- `tool_result`
- `user_bash`
- `input`

That means extensions can modify or intercept the live session flow:

```text
user prompt
   |
   v
before_agent_start
   |
   v
context
   |
   v
before_provider_request
   |
   v
agent/turn/message/tool execution events
```

This is the biggest architectural difference from our system today.

## 5. Pi extensions can extend the harness itself

Pi extensions are not only "app plugins". They can affect the actual coding harness.

Examples:

- add LLM-callable tools
- add slash commands
- add custom UI widgets
- replace or augment the editor/footer/header
- intercept tool calls/results
- register custom model providers
- implement OAuth login for those providers

That is much closer to "host extensibility" than to a marketplace-style page system.

## 6. UI is imperative too

Pi's extension context exposes UI primitives directly:

- dialogs
- notifications
- widgets above/below the editor
- custom focused overlays
- custom footer/header
- editor replacement
- theme access
- raw terminal input listeners

So the UI model is:

```text
extension code
   |
   v
call UI primitives directly
   |
   v
host renders extension-owned interaction
```

This is more immediate than our current "register page metadata, host renders based on snapshot" approach.

## 7. Examples confirm the code-first model

The repo contains both packaged examples and user-local examples:

- `packages/coding-agent/examples/extensions/with-deps`
- `packages/coding-agent/examples/extensions/custom-provider-anthropic`
- `.pi/extensions/files.ts`
- `.pi/extensions/prompt-url-widget.ts`

These examples are notable because they do real runtime work:

- registering a provider
- using extension-local npm deps
- rebuilding UI from session history
- opening editor widgets and custom pickers

## Where Our System Differs

Our current AgentOS system is strong on desktop app integration, but weaker as a runtime extension platform.

```text
Current AgentOS strengths
-------------------------
- desktop page registration
- chat-owned right preview pane
- webview isolation
- per-thread persisted plugin state
- plugin discovery/installation path
- Pi bridge export for tools/skills

Current AgentOS weaknesses vs pi
--------------------------------
- small runtime API
- almost no lifecycle hooks
- plugins cannot shape the live harness deeply
- provider/model interception is missing
- command/shortcut/input extensibility is missing
- manifest still carries too much product meaning
```

More concretely:

## 1. Our manifest is still too central

Today the `agent-hub` manifest carries:

- sidepanel entries/pages
- tools
- MCP servers
- skills
- default preview behavior

In Pi, the manifest only helps find code and resources.

Recommendation:

- keep manifest for install/discovery metadata only
- move runtime capability declaration into `activate()`

## 2. Our API surface is too small

Current public API is roughly:

- `registerSidepanelPage(...)`
- `registerTool(...)`
- `manageMcpServer(...)`

That is not enough if we want Pi-like extensions.

Recommendation:

- add a richer `ExtensionRuntimeAPI`
- keep page/preview registration, but make it only one slice of the API

Target additions:

- `on(event, handler)`
- `registerCommand(...)`
- `registerAction(...)`
- `registerProvider(...)`
- `registerModelTransform(...)`
- `sendMessage(...)`
- `sendUserMessage(...)`
- `appendThreadEntry(...)`
- `openThreadPreview(...)`
- `setThreadPreviewState(...)`
- `registerMessageRenderer(...)`

## 3. We need real lifecycle events

Right now we mostly have:

- discovery
- activation
- snapshot building
- tool execution

That is too static.

We should add a proper event bus around the live runtime:

```text
thread_open
thread_resume
before_turn
before_prompt_send
before_harness_request
message_stream_start
message_stream_delta
message_stream_end
tool_call
tool_result
thread_preview_opened
thread_preview_closed
plugin_page_opened
runtime_shutdown
```

Not every harness exposes the same shape, which is why the adapter layer matters.

## 4. Harness adapters should be event translators, not just tool shims

Our original adapter idea was correct, but too narrow.

Right now it is mostly about translating tool capability shape.

Pi-like design needs adapters to translate:

- provider/model concepts
- prompt/request lifecycle
- message streaming lifecycle
- tool invocation lifecycle
- input/command/interrupt semantics
- preview-pane capabilities where relevant

Target model:

```text
Native Harness
   |
   v
Harness Adapter
   |
   v
Unified Runtime Events + Unified Runtime API
   |
   v
Extensions
```

## 5. Plugin pages and chat previews should remain desktop-specific surfaces

We should not throw away the desktop-specific parts we already built.

Pi does not have our exact desktop UI problem.

So the correct move is not "copy Pi literally".
It is:

- adopt Pi's runtime-first extension model
- keep our desktop page and per-thread preview surfaces as first-class host features

That means the extension API should treat them as capabilities on top of the runtime model, not as the core model itself.

## Recommended Direction

## Phase 1. Make the runtime contract primary

Introduce a new API layer roughly like:

```ts
export interface AgentExtensionRuntimeApi {
  on(event: AgentExtensionEventName, handler: AgentExtensionHandler): void;
  registerTool(...): void;
  registerCommand(...): void;
  registerProvider(...): void;
  sendMessage(...): void;
  sendUserMessage(...): void;
  appendThreadEntry(...): void;
  getThreadStateStore(threadId?: string): ThreadStateStore;
  events: EventBus;
}

export interface AgentExtensionDesktopApi {
  registerPage(...): void;
  registerThreadPreview(...): void;
  openThreadPreview(...): void;
}

export interface AgentExtensionApi
  extends AgentExtensionRuntimeApi,
    AgentExtensionDesktopApi {}
```

Make this the main programming model.

## Phase 2. Reduce manifest scope

Manifest should describe only:

- id
- name
- version
- icon
- extension entrypoint(s)
- optional resource directories
- install metadata

Not:

- the full list of tools
- the full list of pages
- the full list of runtime behavior

Those should come from `activate()`.

## Phase 3. Add unified runtime events

Define a host event model that feels Pi-like, then map each harness into it.

Example:

```text
Unified events
--------------
session_start
session_resume
before_turn
before_prompt
before_harness_request
turn_start
turn_end
message_start
message_delta
message_end
tool_call
tool_result
thread_preview_change
page_open
page_close
shutdown
```

Then let adapters translate:

- Pi native session/tool/message callbacks
- Codex app-server events
- Claude Code events
- OpenCode events

## Phase 4. Make previews part of the runtime API

The preview pane is specific to a chat thread, so extensions should be able to control it directly from runtime hooks and tool execution.

Example:

```ts
api.registerThreadPreview("random-site", ...);

api.on("session_start", (event, ctx) => {
  api.openThreadPreview(ctx.threadId, "random-site");
});
```

That aligns the desktop surface with the same imperative model Pi uses for everything else.

## Phase 5. Add commands and provider registration

If we want Pi parity in spirit, the next two high-value capabilities are:

- command registration
- provider registration

These are both central to why Pi extensions feel powerful.

## What We Should Keep From Our Current System

We already have some good decisions that Pi does not solve for directly:

- full-page plugin navigation in the desktop app
- per-thread right companion pane state
- isolated webview rendering in Electron
- persistent thread-scoped plugin state store
- marketplace-ish discovery/install flow

So the target should look like this:

```text
          pi-like runtime model
                   +
      our desktop page/preview surfaces
                   +
       harness adapter normalization layer
```

Not:

```text
copy pi literally and throw away desktop concepts
```

## Concrete Rewrite Goal

The practical rewrite target is:

```text
Today
-----
manifest-first desktop plugin host
with some imperative registration

Target
------
runtime-first extension host
with lightweight manifest discovery
plus desktop page/preview capabilities
plus harness adapters that translate lifecycle events
```

## Suggested Next Implementation Steps

1. Introduce a new `on(event, handler)` event API in our SDK.
2. Move tool declarations fully out of manifest and into activation.
3. Add `registerThreadPreview(...)` and imperative preview control methods.
4. Add a unified event bus in the backend service/runtime path.
5. Expand harness adapters from tool-shape translators into lifecycle translators.
6. Add command registration before tackling provider registration.
7. Keep manifest only for install/discovery/resource metadata.

## Short Recommendation

If you want the shortest version:

```text
Steal Pi's extension runtime.
Keep our desktop surfaces.
Demote the manifest.
Promote lifecycle hooks and imperative APIs.
Use harness adapters to make that portable.
```
