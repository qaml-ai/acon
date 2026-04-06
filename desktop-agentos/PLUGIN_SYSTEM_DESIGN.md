# AgentOS Plugin System Design

Historical first-cut design note. The active rewrite target is [PLUGIN_SYSTEM_V2.md](./PLUGIN_SYSTEM_V2.md).

This document describes the current Agent Hub plugin system used by the AgentOS desktop variant in `desktop-agentos/`.

It is intentionally practical. It focuses on what exists now, how the pieces fit together, and where the current boundaries are.

## Goals

The plugin system is built around a few concrete goals:

- Keep plugin discovery simple with a lightweight manifest.
- Let plugins register real behavior imperatively at activation time.
- Keep the app's UI model close to the desired product UX:
  - plugins can open full pages in the main area
  - chats own their own right-side preview pane
- Let plugin capabilities survive across harness differences through adapters.
- Let plugin state persist per chat thread.
- Keep plugin-owned web content isolated from the host renderer.

## Mental Model

There are three different concepts in play:

1. Plugin discovery
   Read plugin metadata from `package.json`.

2. Plugin activation
   Load the runtime module and let it register pages, tools, MCP servers, and skills.

3. Plugin presentation
   Render plugin content either:
   - as a full page in the main surface
   - as a chat-owned preview in the right pane

The key design choice is that plugin pages and chat previews are not the same state.

```text
Left sidebar click on plugin
        |
        v
  activePluginPageId
        |
        v
  main content becomes plugin page


Selected chat thread
        |
        v
threadPreviewStateById[threadId]
        |
        v
right pane shows plugin preview for that thread
```

## High-Level Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Electron Main                                                       │
│                                                                      │
│  - desktop backend lifecycle                                         │
│  - desktop-plugin:// protocol for local plugin assets                │
│  - preload bridge                                                    │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                v
┌──────────────────────────────────────────────────────────────────────┐
│ Desktop Service                                                      │
│                                                                      │
│  - threads/messages                                                  │
│  - active plugin page state                                          │
│  - per-thread preview state                                          │
│  - extension host                                                    │
│  - AgentOS runtime manager                                           │
└───────────────┬──────────────────────────────────────────────────────┘
                │
                v
┌──────────────────────────────────────────────────────────────────────┐
│ Agent Hub Extension Host                                             │
│                                                                      │
│  - manifest discovery                                                │
│  - activation on onStartup / onView:*                                │
│  - page/tool/MCP/skill registration                                  │
│  - per-thread plugin state context                                   │
│  - Pi bridge export                                                  │
└───────────────┬──────────────────────────────────────────────────────┘
                │
       ┌────────┴────────┐
       │                 │
       v                 v
┌───────────────┐   ┌────────────────────┐
│ Renderer      │   │ AgentOS Pi Session │
│               │   │                    │
│ - plugin pages│   │ - generated bridge │
│ - chat preview│   │ - plugin tools     │
│ - iframe/web  │   │ - plugin skills    │
└───────────────┘   └────────────────────┘
```

## Core Components

### 1. Shared protocol

File: `desktop/shared/protocol.ts`

The shared protocol defines the shape exchanged between backend and renderer.

Important state:

- `activeThreadId`
- `activePluginPageId`
- `threadPreviewStateById`
- `pages`
- `plugins`

This is the foundation of the current UX split:

```text
main surface state      = activePluginPageId
chat preview state      = threadPreviewStateById[threadId]
chat transcript state   = messagesByThread[threadId]
```

### 2. Desktop store

File: `desktop-agentos/backend/store.ts`

The store persists:

- threads
- messages
- provider/model state
- active plugin page
- per-thread preview state

It also persists per-thread preview state separately from main navigation.

```text
Persisted state
├── activeThreadId
├── activePluginPageId
├── threadPreviewStateById
├── threads
├── messagesByThread
└── provider/session state
```

### 3. Desktop service

File: `desktop-agentos/backend/service.ts`

The service is the orchestration layer.

It is responsible for:

- creating/selecting threads
- selecting plugin pages
- opening/closing thread previews
- activating plugin pages on demand
- auto-attaching default preview plugins to threads
- building snapshots for the renderer

The preview auto-open behavior currently comes from manifest metadata:

```text
manifest sidepanel entry
    openInChatByDefault: true
             |
             v
DesktopService.ensureDefaultThreadPreview(...)
             |
             v
threadPreviewStateById[threadId] = plugin page id
```

### 4. Extension host

File: `desktop-agentos/backend/extensions/host.ts`

The extension host discovers plugins, loads them, and turns runtime registrations into snapshot data.

Responsibilities:

- scan plugin directories
- read `agent-hub` from `package.json`
- dynamically import plugin entrypoints
- provide the activation API
- build plugin page metadata
- export Pi bridge plugin definitions
- detect the default thread-preview page

Discovery roots:

```text
desktop-agentos/plugins/
desktop-agentos/plugins/builtin/
$DESKTOP_DATA_DIR/plugins/
optional override dir
```

### 5. Runtime bridge for Pi

Files:

- `desktop-agentos/backend/runtime.ts`
- `desktop-agentos/backend/extensions/pi-bridge.ts`

New Pi sessions receive generated bridge extensions under the app-managed `.pi/agent` tree.

That bridge loads plugin modules again inside Pi-compatible extension wrappers and exposes:

- tools
- skills
- managed MCP metadata
- per-thread plugin state

```text
Desktop plugin registration
        |
        v
AgentExtensionHost.getPiBridgePlugins()
        |
        v
syncPiExtensionBridge(...)
        |
        v
.pi/agent/extensions/agent-hub-*.cjs
        |
        v
Pi sees plugin tools + skills
```

### 6. Renderer

Files:

- `desktop/renderer/src/App.tsx`
- `desktop/renderer/src/desktop-sidebar.tsx`

The renderer treats plugin pages and chat previews differently:

```text
if activePluginPageId != null
  -> show plugin page in main content
  -> hide chat

else
  -> show chat
  -> if threadPreviewStateById[threadId].visible
       show right preview pane
```

The companion webview path is memoized so streaming message updates do not remount the iframe on every turn event.

### 7. Electron webview asset serving

File: `desktop/electron/main.mjs`

Local plugin HTML is not embedded through raw `file://` URLs anymore.

Electron serves plugin-local assets through a custom protocol:

```text
local plugin file
  /.../plugin/site/index.html
        |
        v
desktop:resolve-webview-src
        |
        v
desktop-plugin://local/.../plugin/site/index.html
        |
        v
Electron protocol handler -> net.fetch(file://...)
```

This avoids `Not allowed to load local resource` errors in the iframe while preserving relative JS/CSS asset loading.

## Plugin Shape

A plugin has two layers:

### Manifest layer

The manifest is lightweight and declarative.

It is used for:

- discovery
- listing metadata
- activation events
- dependency-free capability declarations

Example:

```json
{
  "agent-hub": {
    "id": "random-site-companion",
    "name": "Random Site Companion",
    "activationEvents": ["onStartup"],
    "contributes": {
      "sidepanelEntries": [
        {
          "id": "random-site-companion.site",
          "title": "Random Site Companion",
          "openInChatByDefault": true
        }
      ]
    }
  }
}
```

### Activation layer

The runtime module registers actual behavior.

Example:

```ts
export function activate(api) {
  api.registerSidepanelPage("random-site-companion.site", {
    title: "Random Site Companion",
    render: {
      kind: "webview",
      entrypoint: "./site/index.html",
    },
  });
}
```

The API name still says `registerSidepanelPage`, but in practice this registration now powers:

- full plugin pages in the main area
- chat-owned right previews when selected by thread preview state

That name is legacy and can be cleaned up later.

## UI Surface Model

The product surface model is:

```text
┌───────────────┬───────────────────────────────┬──────────────────────┐
│ Left Sidebar  │ Main Area                     │ Right Preview Pane   │
├───────────────┼───────────────────────────────┼──────────────────────┤
│ Threads       │ Chat transcript               │ Thread-specific      │
│ Plugin pages  │ or plugin page                │ plugin preview       │
└───────────────┴───────────────────────────────┴──────────────────────┘
```

Important rules:

- Clicking a plugin in the sidebar opens a full plugin page.
- That does not mutate the chat thread's preview state.
- The right pane belongs to the chat thread, not to global navigation.
- A plugin can be both:
  - a full page
  - a thread preview

## Thread State Store

Files:

- `desktop-agentos/backend/extensions/thread-state.ts`
- `desktop-agentos/sdk/index.ts`

Plugins receive a persistent per-thread state store in:

- host render contexts
- tool execution contexts
- Pi bridge tool execution contexts

The store is backed by JSON files under the app-managed `.pi` home.

Conceptually:

```text
thread state root
└── .pi/agent-hub-state/threads/
    ├── <thread-a>/
    │   ├── project-inspector.json
    │   └── random-site-companion.json
    └── <thread-b>/
        └── random-site-companion.json
```

The API is intentionally small:

```text
threadState.get(key)
threadState.set(key, value)
threadState.delete(key)
threadState.clear()
threadState.snapshot()
```

This is enough for:

- preview UI state
- tool counters
- plugin-specific thread memory
- lightweight cached derivations

## Current Example Plugins

### `random-site-companion`

Purpose:

- auto-opens in the right pane for every chat
- chooses a stable random website per thread

How it works:

```text
thread id
   |
   v
simple hash
   |
   v
pick one site from candidate list
   |
   v
plugin page redirects webview to that site
```

### `webview-playground`

Purpose:

- example full plugin page
- local HTML/CSS/JS bundle loaded through the custom protocol

### `project-inspector`

Purpose:

- example tool + MCP + skill plugin
- demonstrates persistent thread state in tool execution

## Event Flow

### Opening a plugin page

```text
User clicks plugin in sidebar
        |
        v
Renderer sends select_plugin_page
        |
        v
DesktopService.setActivePluginPage(...)
        |
        v
Extension host activates on onView:<entry>
        |
        v
Snapshot emitted
        |
        v
Renderer shows plugin page in main area
```

### Showing a thread preview

```text
Thread selected or created
        |
        v
DesktopService.ensureDefaultThreadPreview(...)
        |
        v
threadPreviewStateById[threadId] updated
        |
        v
Snapshot emitted
        |
        v
Renderer mounts right-pane preview iframe
```

### Running a plugin tool inside Pi

```text
User sends chat message
        |
        v
DesktopService asks runtime manager for stream
        |
        v
runtime.ts syncs Pi bridge plugins
        |
        v
Pi wrapper calls plugin execute()
        |
        v
execute() receives threadState + threadId + workspacePath
```

## Design Tradeoffs

### Why hybrid manifest + activation?

Because it gives:

- cheap discovery
- simple marketplace/install metadata
- explicit runtime registration for actual behavior

without building a full VS Code contribution engine up front.

### Why harness adapters?

Because tools and skills are not called the same way across:

- Pi
- Codex
- Claude Code
- OpenCode

The plugin should target one platform model. The adapter absorbs harness-specific differences.

### Why per-thread preview state instead of global preview state?

Because the preview belongs to the conversation.

If a chat opens a notebook, browser page, or preview plugin, that should stay with that thread rather than becoming a global desktop mode.

### Why persistent thread state in `.pi`?

Because the plugin runtime already needs a shared location reachable by both:

- the host-side desktop process
- the Pi bridge runtime

Using the app-managed `.pi` home gives one practical shared boundary.

## Current Limitations

The current design is solid enough to build on, but it still has known limitations:

### 1. Naming drift

The API still uses `registerSidepanelPage`, even though the product model is now "plugin pages" plus "thread previews".

### 2. No dedicated preview registration API

Right now, the same registered page object is reused for:

- main plugin pages
- thread previews

There is not yet a separate `registerPreviewPane(...)` API.

### 3. Webviews do not get a rich host bridge yet

Plugin-owned browser code currently gets context via URL parameters/fragments.

There is not yet a first-class preload bridge for:

- reading thread state directly from webview JS
- writing thread state directly from webview JS
- receiving host events incrementally

### 4. Managed MCP servers are still mostly metadata

Plugins can declare and manage MCP servers, but the full lifecycle and harness injection story is still incomplete compared to tools.

### 5. No marketplace/install UX yet

Discovery supports repo-shipped and user-installed plugins, but there is not yet a full install/update/remove UI.

## Recommended Next Steps

If this system keeps expanding, the next best moves are:

1. Rename the plugin page API
   Move from `registerSidepanelPage` to something like `registerPage`.

2. Add a dedicated preview API
   Example: `registerThreadPreview(...)`.

3. Add a webview bridge
   Let webview JS read/write thread state and receive host context without URL tricks.

4. Add preview payload support
   Let the right pane carry typed preview payloads per thread, not just a page id.

5. Expand harness injection
   Complete the MCP/tool story across non-Pi harnesses.

## Summary

The current AgentOS plugin system is best understood as:

```text
lightweight manifest discovery
            +
imperative runtime activation
            +
separate state for:
  - main plugin pages
  - chat-owned right previews
            +
harness adapter bridge
            +
persistent per-thread plugin state
```

That combination is what makes the current design workable. It stays simple enough to extend, but it already supports:

- full plugin pages
- per-thread preview panes
- plugin tools/skills
- persistent thread state
- Pi bridge loading
- plugin-owned local web assets
