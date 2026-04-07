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

- local bundle builds exist, but signed/notarized release packaging is still not wired
- workspace is mounted directly from the host checkout into the VM at `/workspace`
- auth is seeded from host `~/.codex`, host `~/.claude` / `~/.claude.json`, or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`
- the backend currently uses fixed default models per provider (`gpt-5.4` for Codex and `sonnet` for Claude)
- ACPX sessions persist per thread inside a single long-lived shared agent container, and the backend keeps a long-lived `container exec --interactive` bridge process attached to that container for guest-to-host RPC
- release packaging still needs to stage the vendored Apple `container` binary and image contexts into app resources

## Commands

```bash
bun install
bun run prepare:container
bun run build:bundle
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

- `prepare:container` copies a usable Apple `container` install into `desktop-container/vendor/apple-container/` and prebuilds the shared ACPX/Codex/Claude image when Apple container tooling is available.
- `build` only builds the renderer.
- `build:bundle` assembles the packaged desktop resources, bundles the backend entrypoint, stages builtin plugin manifests for packaged discovery, and produces an unpacked macOS `.app` bundle in `dist/bundle/`.
- `dev` is the main command. It starts the renderer plus Electron and picks a free localhost port automatically.
- `dev` only runs container-asset preparation when `DESKTOP_PREPARE_CONTAINER_ASSETS=1`.
- `backend` is a smoke check for backend startup, not a long-lived backend server.
- `probe` runs an end-to-end stdio turn against the desktop backend using the default provider.
- `probe:claude` forces the Claude provider through the same end-to-end probe.
- `probe:codex` forces the Codex provider through the same end-to-end probe.
- `test:integration` runs the opt-in Vitest suite that drives the real desktop backend over stdio, sends two turns through ACPX inside Apple containers, and checks session continuity for both Claude and Codex.
- `start` is the lower-level Electron entrypoint and expects the renderer URL to already be available.
- The integration command sets `RUN_DESKTOP_CONTAINER_INTEGRATION=1` for you. Run it only on a machine that has Apple `container` plus valid Codex and Claude auth.

Host MCP notes:

- Host code can register MCP servers on `DesktopService` with `registerHostMcpServer({ id, createServer })`.
- Inside the container, `acon-mcp --help` shows the CLI surface.
- `acon-mcp servers` lists the host MCP servers that the Electron app has registered for that backend session.
- `acon-mcp tools <server-id>` lists the tools exposed by one registered host MCP server.
- `acon-mcp <server-id>` exposes that registered host MCP server over stdio for ACPX or any other MCP client running in the guest.
- The guest-to-host bridge itself is internal. The positive loopback and host-MCP cases are covered by the integration test in `tests/desktop-container-acpx.integration.test.ts`.

## Environment

Optional:

```bash
export DESKTOP_CONTAINER_WORKSPACE_DIR=/absolute/path/to/workspace
export DESKTOP_CONTAINER_USER_DATA_DIR=/custom/path
export DESKTOP_CONTAINER_ACPX_IMAGE=acon-desktop-acpx:0.1
export DESKTOP_APPLE_CONTAINER_REPO_DIR=/absolute/path/to/apple-container
export DESKTOP_CONTAINER_CLAUDE_IMAGE=acon-desktop-claude:0.1
export DESKTOP_CONTAINER_CODEX_IMAGE=acon-desktop-codex:0.1
export DESKTOP_CONTAINER_BIN_PATH=/absolute/path/to/container
export DESKTOP_PREBUILD_CONTAINER_IMAGES=0
export DESKTOP_PREPARE_CONTAINER_ASSETS=1
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
- `desktop-container/container-images/` contains the shared Apple-container image definition that installs ACPX, Codex, and Claude Code together, plus the internal `acon-host-bridge` daemon and the `acon-mcp` stdio proxy so agents can reach host MCP servers from inside the container.
- Packaged builds should stage the Apple `container` CLI at `Contents/Resources/desktop/bin/container`, the helper tree at `Contents/Resources/desktop/libexec/container/`, builtin plugin manifests under `Contents/Resources/desktop/plugins/builtin/`, and the image contexts at `Contents/Resources/desktop/container-images/`.
- `desktop-container/backend/extensions/host.ts` discovers V2 `camelai` plugin manifests from `desktop-container/plugins/builtin/` plus the user install directory, loads extension modules, exposes a runtime-first API (`on`, `registerView`, `registerPanel`, `registerCommand`, `registerTool`), and materializes workbench views plus per-thread companion panels into the shared snapshot model.
- `desktop-container/backend/extensions/thread-state.ts` provides a persistent per-thread plugin state store under the desktop runtime directory so workbench views, companion panels, and runtime hooks can share thread-scoped JSON state.
- `desktop-container/backend/extensions/harness-adapters.ts` is the abstraction layer between supported harnesses and the unified extension model; it currently includes `codex`, `claude-code`, and `opencode` adapter identities.
- `desktop/electron/main.mjs` exposes the desktop-shell install flow for user plugins, including folder selection, copying into the user plugin directory, and triggering a live catalog refresh.
- `desktop-container/plugins/` contains repo-shipped V2 plugins, with `plugins/builtin/` reserved for curated builtins. The current builtin set includes `chat-core`, `extension-lab`, and `thread-journal`.
- `desktop-container/sdk/index.ts` contains the extension-facing V2 manifest and activation API types.
- `desktop-container/electron/main.mjs` loads the desktop backend service directly into the Electron main process via `tsx`.
- The shared desktop renderer (`desktop/renderer/src/App.tsx`) renders a plugin-contributed workbench. Chat itself is a builtin `chat-core` view instead of a renderer special case, companion panels remain thread-scoped, host-rendered surfaces are resolved from a trusted renderer registry, and plugin-owned webviews can render `http:`, `https:`, `data:`, and plugin-local HTML entrypoints in a sandboxed iframe via the desktop file/webview bridge.
- `desktop-container/scripts/dev.mjs` reuses the existing desktop renderer and shared Electron shell, but writes state into a separate user-data directory so it does not collide with the older helper-based prototype.
