# Agent Browser Roadmap

## Framing

The desktop app should move toward being the web browser of agents: the main surface people use to interface with agents, agent work, and agent-produced artifacts.

That means the app should not be treated primarily as a chat client with plugins. It should be treated as an agent workbench with browser-like primitives:

- tabs
- navigation history
- permissions
- installable extensions
- inspectable runtime state
- first-class rendered artifacts
- background execution

Chat remains important, but it should become one built-in surface among several, not the defining abstraction of the product.

## Product Direction

The browser analogy suggests a few core principles:

- The host owns identity, security, persistence, lifecycle, navigation, and permissions.
- Extensions and built-in modules own most visible surfaces.
- Agents should be able to produce and inhabit durable surfaces, not only message transcripts.
- Users should be able to move between agents, tasks, artifacts, and contexts as fluidly as they move between pages and tabs in a browser.

## Highest-Priority Next Additions

### 1. Agent Tabs And Navigation

The app needs true browser-style navigation for agent work:

- tabs for threads, tasks, artifacts, and agent sessions
- pinned tabs
- reopen closed tab
- back/forward navigation
- split view
- restorable navigation history

This is the next major UX primitive after the new workbench view/panel model.

### 2. Capability Permissions

The app needs a real permission model for agents and extensions:

- filesystem access
- network access
- git access
- browser automation access
- connector/app access
- clipboard and local desktop integration

Permissions should support:

- per-agent grants
- per-workspace grants
- session-only vs persistent grants
- audit logs
- easy revocation

### 3. Renderer Extension Host

The app now has a workbench model, but renderer extensibility is still limited.

The next step is a renderer-side extension host so extensions can contribute:

- message renderers
- artifact renderers
- transcript decorations
- composer actions
- thread actions
- status items
- trusted built-in workbench surfaces

This is the point where the UI starts to feel platform-like instead of host-hardcoded.

### 4. First-Class Artifacts

Agents should produce durable outputs that are not forced into transcript form:

- documents
- diffs
- notebooks
- previews
- dashboards
- forms
- reports
- tasks

Artifacts should have stable identities, open in tabs/views, and be linkable across the workbench.

### 5. Background Agents

The platform needs background execution primitives similar to service workers or background tabs:

- scheduled runs
- watchers
- long-running tasks
- resumable jobs
- inbox items
- notifications
- retryable failures

Agents should not stop existing just because a chat surface is closed.

### 6. Agent Devtools

If this is a platform, it needs tooling to inspect what agents and extensions are doing:

- event timeline
- tool call trace
- prompt inspection
- token/cost usage
- permission checks
- state diffs
- render diagnostics
- extension contribution inspector

This should be treated as a first-class product area, not just internal debugging.

## Important Follow-On Areas

### Installable Extension Ecosystem

The app needs the platform mechanics for third-party extensions:

- extension packaging
- signing and trust levels
- versioning and updates
- settings UI
- install/uninstall flows
- capability declarations

Suggested trust tiers:

- built-in trusted extensions
- trusted local development extensions
- sandboxed third-party extensions

### Canonical Agent URL Model

Everything should have a stable address:

- agent sessions
- threads
- tasks
- artifacts
- files
- extension surfaces
- background jobs

That will make deep-linking, restore, and sharing much cleaner.

### Multi-Agent Composition

Agents should become composable runtime surfaces:

- one agent can delegate to another
- one surface can open another surface
- one task can subscribe to another task's outputs
- agent work can span tabs, panels, and background jobs

### Sync And Identity

Longer term, the app should support:

- session sync
- workspace sync
- shared views
- sharable artifact links
- account-aware state restore

## Suggested Implementation Order

1. Add tabs and navigation history on top of the current workbench model.
2. Add a real permission system for agents and extensions.
3. Add a renderer extension host with trusted built-in renderer contributions.
4. Introduce a first-class artifact model and artifact tabs.
5. Add background agents, inbox, and notifications.
6. Add agent devtools.
7. Add extension packaging, trust levels, and install/update flows.
8. Add stable deep links and canonical resource URLs.

## Repo Implications

For this repository specifically, the likely next architectural moves are:

- extend the shared desktop protocol beyond `views` and `panels` into tabs, navigation state, and artifact identities
- add a renderer contribution registry instead of keeping host surface resolution inside a single `App.tsx`
- separate trusted renderer extensions from sandboxed webview extensions
- add a first-class artifact/state model in the backend store instead of treating transcript messages as the only durable output
- add permission and audit primitives in the desktop backend before broadening extension capabilities

## Summary

The app should aim to become the trusted operating surface for agent work.

The key product shift is:

- from chat client
- to agent workbench

And the key platform shift is:

- from plugin-added side pages
- to a browser-like system where core features, built-ins, and extensions all contribute surfaces on top of a stable host kernel
