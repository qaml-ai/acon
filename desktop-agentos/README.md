# camelAI Desktop AgentOS Prototype

This is a sibling desktop prototype that keeps the existing Electron shell and renderer, but replaces the Docker or Apple-containerized runtime with a local [AgentOS](https://rivet.dev/docs/agent-os/overview/) VM.

Current scope:

- no Docker
- no Swift runtime helper
- local AgentOS VM booted directly from the Electron-hosted desktop service
- Pi agent sessions via `@rivet-dev/agent-os-pi`
- the same persisted local threads and renderer used by `desktop/`
- per-thread Pi session state persisted under the AgentOS runtime home so old chats can resume after a desktop restart
- V2 desktop extension host with lightweight `camelai` manifest discovery plus runtime-first activation
- repo-shipped plugin discovery from `desktop-agentos/plugins/` plus user plugin discovery from the desktop data directory under `plugins/`
- Extension Lab can install a user plugin by copying a selected folder into the desktop data `plugins/` directory and refreshing the runtime catalog
- shared desktop sidebar can now open plugin-contributed panes beside chat

Current limits:

- dev-only prototype; no staging or packaged runtime flow yet
- single `agentos` provider only
- workspace is mounted directly from the host checkout into the VM at `/workspace`
- auth prefers Pi credentials from `~/.pi/agent/auth.json` and falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- the session model is chosen from `DESKTOP_AGENTOS_MODEL` and written into a Pi settings file before boot
- the default model currently prefers Anthropic (`claude-sonnet-4-20250514`) because Pi over AgentOS ACP dropped empty responses for `openai/gpt-5.4` in local testing even though direct Pi SDK calls succeeded

## Commands

```bash
bun install
bun run desktop-agentos:dev
bun run desktop-agentos:check
bun run desktop-agentos:backend
bun run desktop-agentos:probe-resume
bun run desktop-agentos:probe-turn
bun run desktop-agentos:test-gpt54
bun run desktop-agentos:start
```

Notes:

- `desktop-agentos:dev` is the main command. It starts the renderer plus Electron and picks a free localhost port automatically.
- `desktop-agentos:backend` is a smoke check for the AgentOS runtime bootstrap, not a long-lived backend server.
- `desktop-agentos:probe-resume` runs two real turns across a full desktop-service restart and fails unless the second turn remembers the first.
- `desktop-agentos:test-gpt54` runs a real AgentOS ACP probe against `gpt-5.4` and fails if streamed assistant text chunks do not appear.
- `desktop-agentos:probe-turn` runs an end-to-end stdio turn against the AgentOS backend using a fresh temporary desktop data directory.
- `desktop-agentos:start` is the lower-level Electron entrypoint and expects the renderer URL to already be available.

Design:

- [AgentOS Plugin System V2](./PLUGIN_SYSTEM_V2.md)
- [pi-mono Plugin System Notes](./PI_MONO_PLUGIN_SYSTEM_NOTES.md)
- [AgentOS Plugin System Design](./PLUGIN_SYSTEM_DESIGN.md)

## Environment

Optional:

```bash
export DESKTOP_AGENTOS_WORKSPACE_DIR=/absolute/path/to/workspace
export DESKTOP_AGENTOS_USER_DATA_DIR=/custom/path
export DESKTOP_AGENTOS_MODEL=gpt-5.4
export DESKTOP_AGENTOS_THOUGHT_LEVEL=medium
```

Pi OAuth or API-key auth:

```bash
pi
# then run /login for Claude or ChatGPT Codex
```

Optional API key fallback:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

## Architecture

- `desktop-agentos/backend/runtime.ts` owns the AgentOS VM lifecycle and per-thread session management.
- The backend mounts the current workspace into the VM at `/workspace`.
- The backend writes Pi settings into a dedicated runtime home, stages host Pi auth from `~/.pi/agent/auth.json`, mounts that into the VM at `/home/user/.pi`, and assigns each thread a dedicated persisted Pi session directory under `/home/user/.pi/thread-sessions/<provider>/<threadId>`.
- `desktop-agentos/backend/extensions/host.ts` discovers V2 `camelai` plugin manifests from `desktop-agentos/plugins/builtin/` plus the user install directory, loads extension modules, exposes a runtime-first API (`on`, `registerView`, `registerPanel`, `registerCommand`, `registerTool`), and materializes workbench views plus per-thread companion panels into the shared snapshot model.
- `desktop-agentos/backend/extensions/thread-state.ts` provides a persistent per-thread plugin state store backed by the shared `.pi` home so workbench views, companion panels, and runtime hooks can share thread-scoped JSON state.
- `desktop-agentos/backend/extensions/harness-adapters.ts` is the abstraction layer between platform-native harnesses and the unified extension model; it currently includes `pi`, `codex`, `claude-code`, and `opencode` adapter identities and provider-to-harness mapping.
- `desktop/electron/main.mjs` exposes the desktop-shell install flow for user plugins, including folder selection, copying into the user plugin directory, and triggering a live catalog refresh.
- `desktop-agentos/plugins/` contains repo-shipped V2 plugins, with `plugins/builtin/` reserved for curated builtins. The current builtin set includes `chat-core`, `extension-lab`, and `thread-journal`.
- `desktop-agentos/sdk/index.ts` contains the extension-facing V2 manifest and activation API types.
- `desktop-agentos/electron/main.mjs` loads the AgentOS desktop service directly into the Electron main process via `tsx`.
- The shared desktop renderer (`desktop/renderer/src/App.tsx`) now renders a plugin-contributed workbench. Chat itself is a builtin `chat-core` view instead of a renderer special case, companion panels remain thread-scoped, host-rendered surfaces are resolved from a trusted renderer registry, and plugin-owned webviews can render `http:`, `https:`, `data:`, and plugin-local HTML entrypoints in a sandboxed iframe via the desktop file/webview bridge.
- `desktop-agentos/scripts/dev.mjs` reuses the existing desktop renderer and shared Electron shell, but writes state into a separate user-data directory so it does not collide with the Docker-backed prototype.
