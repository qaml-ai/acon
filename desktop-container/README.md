# camelAI Desktop Container Backend

This desktop backend keeps the existing Electron shell and renderer, and runs coding agents inside Apple `container` VMs through ACPX.

Current scope:

- Apple `container` on top of Apple Virtualization.framework
- ACPX as the stable agent-facing protocol layer
- Codex and Claude providers only
- packaged builds resolve the Apple `container` CLI from app resources instead of assuming a system install
- the same persisted local threads and renderer used by `desktop/`
- per-provider runtime data persisted under the desktop runtime directory inside one shared agent container
- V2 desktop extension host with lightweight `camelai` manifest discovery plus runtime-first activation
- repo-shipped plugin discovery from `desktop-container/plugins/` plus user plugin discovery from the desktop data directory under `plugins/`
- Extension Lab can install a user plugin by copying a selected folder into the desktop data `plugins/` directory and refreshing the runtime catalog
- shared desktop sidebar can open plugin-contributed panes beside chat

Current limits:

- dev-only prototype; no staging or packaged runtime flow yet
- workspace is mounted directly from the host checkout into the VM at `/workspace`
- auth is seeded from host `~/.codex`, host `~/.claude` / `~/.claude.json`, or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- the backend currently uses fixed default models per provider (`gpt-5.4` for Codex and `sonnet` for Claude)
- ACPX sessions persist per thread inside a single long-lived shared agent container, but host-to-container transport still uses `container exec` per turn
- release packaging still needs to vendor the Apple `container` binary at `desktop/bin/container`

## Commands

```bash
bun install
bun run dev
bun run check
bun run backend
bun run probe:claude
bun run probe:codex
bun run probe
bun run test:integration
bun run start
```

Notes:

- `dev` is the main command. It starts the renderer plus Electron and picks a free localhost port automatically.
- `backend` is a smoke check for backend startup, not a long-lived backend server.
- `probe` runs an end-to-end stdio turn against the desktop backend using the default provider.
- `probe:claude` forces the Claude provider through the same end-to-end probe.
- `probe:codex` forces the Codex provider through the same end-to-end probe.
- `test:integration` runs the opt-in Vitest suite that drives the real desktop backend over stdio, sends two turns through ACPX inside Apple containers, and checks session continuity for both Claude and Codex.
- `start` is the lower-level Electron entrypoint and expects the renderer URL to already be available.
- The integration command sets `RUN_DESKTOP_CONTAINER_INTEGRATION=1` for you. Run it only on a machine that has Apple `container` plus valid Codex and Claude auth.

## Environment

Optional:

```bash
export DESKTOP_CONTAINER_WORKSPACE_DIR=/absolute/path/to/workspace
export DESKTOP_CONTAINER_USER_DATA_DIR=/custom/path
export DESKTOP_CONTAINER_ACPX_IMAGE=acon-desktop-acpx:0.1
export DESKTOP_CONTAINER_BIN_PATH=/absolute/path/to/container
```

Codex auth:

```bash
codex login
```

Claude auth:

```bash
claude auth login
```

Optional API key fallback:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

## Architecture

- `desktop-container/backend/container-runtime.ts` owns Apple container image preparation, the long-lived shared agent container, and ACPX turn execution with per-thread session reuse.
- The backend mounts the current workspace into the container at `/workspace`.
- Provider-specific runtime data lives under the shared desktop runtime directory and is mounted into the container under `/data/providers/<provider>`.
- `desktop-container/container-images/` contains the shared Apple-container image definition that installs ACPX, Codex, and Claude Code together.
- Packaged builds should stage the Apple `container` CLI at `Contents/Resources/desktop/bin/container` and the image contexts at `Contents/Resources/desktop/container-images/`.
- `desktop-container/backend/extensions/host.ts` discovers V2 `camelai` plugin manifests from `desktop-container/plugins/builtin/` plus the user install directory, loads extension modules, exposes a runtime-first API (`on`, `registerView`, `registerPanel`, `registerCommand`, `registerTool`), and materializes workbench views plus per-thread companion panels into the shared snapshot model.
- `desktop-container/backend/extensions/thread-state.ts` provides a persistent per-thread plugin state store under the desktop runtime directory so workbench views, companion panels, and runtime hooks can share thread-scoped JSON state.
- `desktop-container/backend/extensions/harness-adapters.ts` is the abstraction layer between supported harnesses and the unified extension model; it currently includes `codex`, `claude-code`, and `opencode` adapter identities.
- `desktop/electron/main.mjs` exposes the desktop-shell install flow for user plugins, including folder selection, copying into the user plugin directory, and triggering a live catalog refresh.
- `desktop-container/plugins/` contains repo-shipped V2 plugins, with `plugins/builtin/` reserved for curated builtins. The current builtin set includes `chat-core`, `extension-lab`, and `thread-journal`.
- `desktop-container/sdk/index.ts` contains the extension-facing V2 manifest and activation API types.
- `desktop-container/electron/main.mjs` loads the desktop backend service directly into the Electron main process via `tsx`.
- The shared desktop renderer (`desktop/renderer/src/App.tsx`) renders a plugin-contributed workbench. Chat itself is a builtin `chat-core` view instead of a renderer special case, companion panels remain thread-scoped, host-rendered surfaces are resolved from a trusted renderer registry, and plugin-owned webviews can render `http:`, `https:`, `data:`, and plugin-local HTML entrypoints in a sandboxed iframe via the desktop file/webview bridge.
- `desktop-container/scripts/dev.mjs` reuses the existing desktop renderer and shared Electron shell, but writes state into a separate user-data directory so it does not collide with the older helper-based prototype.
