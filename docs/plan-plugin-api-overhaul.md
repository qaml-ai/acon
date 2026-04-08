# Plan: Obsidian-Inspired Plugin API Overhaul

## Goal

Turn the current plugin system into a stable extension kernel: explicit lifecycle, declared policy, persisted plugin state, host-brokered privileged actions, and a richer management surface in Extension Lab.

The right comparison to Obsidian is not "run arbitrary plugin code everywhere." The useful lesson is a stable manifest, lots of narrow contribution points, strong lifecycle cleanup, and a first-class plugin manager. `acon` also spans host, guest, MCP, and runtime hooks, so it needs a stricter capability model than Obsidian does.

## Current State

Today plugins can:
- Register workspace and thread views
- Register thread panels
- Register commands
- Register guest-callable tools
- Subscribe to runtime events
- Persist per-thread plugin state
- Register host MCP servers and install persisted host MCP servers

Current gaps:
- No real disable/enable system
- No lifecycle cleanup or reliable unload story
- No compatibility metadata
- No declared permission model for privileged APIs
- No typed settings system
- Extension Lab is mostly inspection, not management

## Design Principles

1. Keep the app kernel small and stable.
2. Prefer many narrow contribution APIs over one broad ambient API.
3. Make privileged operations explicit and host-brokered.
4. Make plugin state and compatibility visible in the product.
5. Default builtin plugins to protected, user plugins to manageable.

## Target Architecture

### 1. Stable Manifest Contract

Expand the `camelai` manifest with:
- `apiVersion`
- `minApiVersion`
- `permissions`
- `disableable`
- `settingsSchema`

This gives us:
- Compatibility checks before activation
- A clear place to declare privileged intent
- Enough metadata for Extension Lab to explain what a plugin is allowed to do

### 2. Real Plugin Lifecycle

Add a proper runtime contract:
- `activate(api)`
- optional `deactivate()`
- registration disposables returned from `on`, `registerView`, `registerPanel`, `registerCommand`, `registerTool`, and host MCP registration methods
- `registerDisposable(...)` on the activation API

This makes refresh, disable, reinstall, and future hot reload safe.

### 3. Persisted Plugin State

Persist per-plugin state in desktop app storage:
- enabled / disabled
- future home for plugin settings

Rules:
- builtin plugins are non-disableable by default unless they opt in
- user plugins are disableable by default unless they opt out
- disabled plugins stay discovered but do not activate or contribute UI/tools/hooks

### 4. Declared Permissions and Host Brokering

Add manifest permissions for privileged surfaces. Initial focus:
- `host-mcp`

Meaning:
- plugins can still be discovered and loaded without ambient power
- privileged APIs reject calls from plugins that did not declare the matching permission

Future permissions should include:
- `runtime-hooks`
- `guest-tools`
- `network`
- `secrets`

### 5. Better Extension Lab Management

Extension Lab should move from passive inspection toward real management:
- show enabled / disabled state
- show compatibility status
- show declared permissions
- show API version metadata
- show whether a plugin is protected or user-manageable
- expose enable / disable controls where allowed

### 6. Typed Settings

Replace the current string-only `settings` metadata with a schema-driven settings model:
- typed fields
- defaults
- secret fields separated from normal persisted config
- host-rendered settings UI

This should be phased in after the lifecycle and state model are stable.

## Phased Rollout

### Phase 1: Foundation

Implement now:
- manifest metadata for API version, permissions, disableability, and settings schema
- compatibility reporting in plugin snapshots
- lifecycle disposables and deactivate support
- persisted plugin enabled / disabled state
- backend and UI support for enable / disable
- initial permission enforcement for host MCP APIs

### Phase 2: Better Contribution Surfaces

Add narrowly scoped APIs such as:
- `registerSettingsTab`
- `registerNavigationItem`
- `registerStatusItem`
- `registerComposerAction`
- `registerSlashCommand`
- `registerThreadDecoration`
- `registerPromptTemplate`

### Phase 3: Settings and Secrets

Add:
- per-plugin settings persistence
- typed host-rendered settings forms
- secret storage for plugin credentials

### Phase 4: Packaging and Trust

Add:
- packaged plugin artifacts
- stronger compatibility/version checks
- reviewed vs local-dev trust tiers
- update and uninstall flows for user plugins

## Implementation Plan For This Change

1. Extend shared protocol types so the UI can understand plugin policy and compatibility.
2. Extend store persistence with plugin enabled / disabled state.
3. Upgrade the extension host to:
   - parse richer manifest metadata
   - skip activation for disabled or incompatible plugins
   - support deactivation and cleanup
   - enforce declared permissions for host MCP APIs
4. Update builtin manifests where needed for explicit permissions.
5. Update Extension Lab to expose plugin state and policy metadata.
6. Add focused tests for lifecycle cleanup, compatibility, and enable / disable behavior.

## Expected Outcome After Phase 1

After this change, `acon` plugins will be more modular and safer in practice:
- plugins can be disabled without being uninstalled
- refreshes do not leak prior registrations
- privileged host MCP access becomes explicit
- Extension Lab can explain plugin policy instead of only listing contributions

That gives us a real kernel to build the next contribution APIs on top of, instead of continuing to accrete one-off plugin hooks.
