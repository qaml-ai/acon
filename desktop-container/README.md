# camelAI Desktop Container Backend

This desktop backend keeps the existing Electron shell and renderer, and runs coding agents inside Apple `container` VMs through a small JS runtime daemon named `acon-agentd`.

Current scope:

- Apple `container` on top of Apple Virtualization.framework
- `acon-agentd` as the internal agent/session runtime layer
- Codex, Claude, PI, and OpenCode providers
- packaged builds resolve the Apple `container` CLI from app resources instead of assuming a system install
- the same persisted local threads and renderer used by `desktop/`
- per-provider runtime data persisted under the desktop runtime directory inside one shared agent container
- V2 desktop extension host with lightweight `camelai` manifest discovery plus runtime-first activation
- repo-shipped plugin discovery from `desktop-container/plugins/` plus user plugin discovery from the desktop data directory under `plugins/`
- Extension Lab can install a user plugin by copying a selected folder into the desktop data `plugins/` directory and refreshing the runtime catalog
- shared desktop sidebar can open a dedicated thread preview pane beside chat

Current limits:

- release packaging supports Developer ID signing plus Apple notarization for direct macOS distribution, but TestFlight or Mac App Store packaging is not wired
- the container workspace at `/workspace` is an app-managed persistent directory under desktop app data, not a live mount of the host checkout
- auth is seeded from host `~/.codex`, host `~/.claude` / `~/.claude.json`, host `~/.pi`, host OpenCode auth/config under `~/.local/share/opencode` and `~/.config/opencode`, or forwarded API keys such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `OPENCODE_API_KEY`
- provider startup writes a small built-in global instruction file into the Codex and Claude runtime homes, while PI and OpenCode reuse the shared workspace `AGENTS.md` plus their seeded auth/config state
- the backend currently uses fixed default models for Codex and Claude, plus provider-family selectors for PI and OpenCode (`OpenRouter`, `OpenCode Go`, `OpenCode Zen`, or the provider default)
- provider sessions persist per thread inside a single long-lived shared agent container, and the container's main daemon process brokers both agent control and guest-to-host RPC over one stdio connection to the desktop backend
- release packaging still needs to stage the vendored Apple `container` binary and image contexts into app resources

## Commands

```bash
bun install
bun run prepare:container
bun run build:bundle
bun run build:bundle:release
bun run build:dmg
bun run build:dmg:notarized
bun run build:release:notarized
bun run dev
bun run check
bun run backend
bun run probe:claude
bun run probe:codex
bun run probe
bun run setup:notary
bun run test:integration
bun run start
```

Notes:

- `prepare:container` copies a usable Apple `container` install into `desktop-container/vendor/apple-container/` and prebuilds the shared Codex/Claude/PI/OpenCode image plus the internal `acon-agentd` runtime before runtime.
- The shared agent image also installs a general-purpose guest toolchain: Python 3, Node.js 22, Ruby, OpenJDK, ffmpeg, ImageMagick, Tesseract OCR, Pandoc, LibreOffice, sqlite3, jq, git, curl, wget, `postgresql-client`, and ODBC/FreeTDS packages for warehouse and database connectivity. System package versions intentionally track the current Debian Bookworm packages used by the base image instead of pinning older versions from external lists.
- The shared agent image also preinstalls curated Python libraries from `desktop-container/container-images/acpx-shared/python-requirements.txt` plus `desktop-container/container-images/acpx-shared/python-connectivity-requirements.txt` for Office documents, PDF processing, AI/ML, data analysis, DuckDB/Postgres/Redshift/BigQuery/Snowflake/Databricks/SQL Server connectivity, DynamoDB and MongoDB document-store access, Redis, Neo4j, OpenSearch, ClickHouse, Trino, DuckDB CLI access, SQLAlchemy-based database workflows, parsing, image/media work, OCR, and LibreOffice UNO workflows.
- `build` only builds the renderer.
- `build:bundle` assembles the packaged desktop resources, bundles the backend entrypoint, stages builtin plugin manifests for packaged discovery, and produces an unpacked macOS `.app` bundle in `dist/bundle/`.
- `build:bundle:release` builds direct-distribution macOS release artifacts in `dist/bundle/`. It expects a `Developer ID Application` certificate in the local keychain and notarization credentials in `APPLE_KEYCHAIN_PROFILE`, or `APPLE_API_KEY_PATH` (or inline `APPLE_API_KEY`, which also needs `APPLE_API_KEY_ID`) plus optional `APPLE_API_ISSUER`, or `APPLE_ID` plus `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.
- `setup:notary` stores a reusable `notarytool` keychain profile. Set `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and optionally `APPLE_API_KEY_PATH` first. If `APPLE_API_KEY_PATH` is omitted, the script looks for `~/Downloads/AuthKey_<APPLE_API_KEY_ID>.p8`. The default keychain profile name is `super-camel-notary`.
- `build:dmg` builds the signed drag-install disk image in `dist/bundle/`.
- `build:dmg:notarized` builds the same `.dmg` and notarizes it using `APPLE_KEYCHAIN_PROFILE` or the default `super-camel-notary` profile.
- `build:release:notarized` builds notarized `dmg` and `zip` release artifacts using the same keychain profile behavior.
- `dev` is the main command. It starts the renderer plus Electron and picks a free localhost port automatically.
- `dev` runs container-asset preparation by default. Set `DESKTOP_PREPARE_CONTAINER_ASSETS=0` to skip it.
- `backend` is a smoke check for backend startup, not a long-lived backend server.
- `probe` runs an end-to-end stdio turn against the desktop backend using the default provider.
- `probe:claude` forces the Claude provider through the same end-to-end probe.
- `probe:codex` forces the Codex provider through the same end-to-end probe.
- `test:integration` runs the opt-in Vitest suite that drives the real desktop backend over stdio, sends two turns through the container daemon, and checks session continuity for the currently covered live providers.
- `start` is the lower-level Electron entrypoint and expects the renderer URL to already be available.
- The integration command sets `RUN_DESKTOP_CONTAINER_INTEGRATION=1` for you. Run it only on a machine that has Apple `container` plus valid provider auth for the providers you want to exercise.

Host MCP notes:

- Host code can register MCP servers on `DesktopService` with `registerHostMcpServer({ id, createServer })`.
- Plugins can register in-process MCP servers with `api.registerMcpServer(id, { createServer })`; plugin-owned HTTP routes and authenticated upstream proxies declare `serve-http`, provider-process environment injection declares `container-env`, plugin-owned MCP servers declare `serve-mcp`, persisted host MCP registry mutation requires `host-mcp`, and plugin bundle installation plus bundled `camelai.agentAssets` inspection require `host-plugins`.
- Persisted host MCP server registrations live under the desktop data directory at `host-mcp/servers/*.json`.
- Persisted remote MCP servers can use `streamable-http` or legacy `sse` transport. Host-managed OAuth is configured automatically, and OAuth tokens/client state are kept in the host secret store. On macOS this uses Keychain; other environments fall back to host-local secret files under the desktop data directory.
- Persisted stdio MCP servers can attach `envSecretRefs`, and persisted remote HTTP MCP servers can attach `headerSecretRefs`, so secrets stay in the host vault and are only resolved at launch time.
- The builtin `host-mcp-manager` plugin registers a host MCP server that can list, install, and remove persisted host MCP servers, prompt the user to store secrets in the host vault, install the repo-local `rest-api` stdio MCP server, install local plugin bundles from the managed guest workspace into the desktop user's plugin directory, and inspect plugin-declared `camelai.agentAssets`. Those bundled skills and MCP configs are reconciled declaratively into the Codex and Claude runtime homes when plugins are loaded or refreshed.
- Repo-shipped builtin stdio servers should be launched through `desktop-container/bin/acon-mcp-builtin.mjs <name>` so persisted configs stay stable even if the underlying implementation files move.
- The builtin `preview-control` plugin registers a host MCP server that can open, replace, clear, and hide/show thread preview items for workspace files and URLs in the right-side preview pane.
- Inside the container, `acon-mcp --help` shows the CLI surface.
- `acon-mcp servers` lists the host MCP servers that the Electron app has registered for that backend session.
- `acon-mcp tools <server-id>` lists the tools exposed by one registered host MCP server.
- `acon-mcp call <server-id> <tool-name> --input '{"key":"value"}'` invokes one tool without exposing the raw MCP session.
- `acon-mcp prompts <server-id>`, `acon-mcp prompt <server-id> <prompt-name>`, `acon-mcp resources <server-id>`, `acon-mcp resource-templates <server-id>`, and `acon-mcp read-resource <server-id> <uri>` cover the standard prompt/resource discovery flows.
- Inside the container, `@acon/host-rpc` is preinstalled and copied into `/workspace/node_modules/@acon/host-rpc` so guest JavaScript or TypeScript can call the same host RPC bridge directly.
- `createHostRpcClient()` exposes typed helpers for `ping`, `fetch`, `listMcpServers`, `listMcpTools`, `callMcpTool`, `listMcpPrompts`, `getMcpPrompt`, `listMcpResources`, `listMcpResourceTemplates`, `readMcpResource`, and `withMcpSession(...)` for managed multi-step flows.
- The guest package intentionally exposes only the managed convenience helpers for MCP access.
- The guest daemon also exposes a loopback HTTP bridge at `$ACON_HOST_HTTP_BASE_URL`. Plugin HTTP routes are mounted at `$ACON_HOST_HTTP_BASE_URL/plugins/<plugin-id>/routes/<route-id>/...`, and plugin-managed authenticated proxies are mounted at `$ACON_HOST_HTTP_BASE_URL/plugins/<plugin-id>/proxies/<proxy-id>/...`.
- Plugins can also register provider-process env vars with `registerProcessEnv()`. Values may be literal strings or references to the plugin's own HTTP route/proxy mount URLs, which lets plugins point tools like Wrangler at authenticated host-side proxies without exposing the underlying token to the container.
- Example:

```js
import { createHostRpcClient } from "@acon/host-rpc";

const client = createHostRpcClient();
const servers = await client.listMcpServers();
const tools = await client.listMcpTools("server-id");
const result = await client.callMcpTool("server-id", "tool-name", {
  example: true,
});
const prompts = await client.listMcpPrompts("server-id");
const prompt = await client.getMcpPrompt("server-id", "prompt-name", {
  topic: "release",
});
const resources = await client.listMcpResources("server-id");
const resource = await client.readMcpResource("server-id", "file:///workspace/README.md");
```

- The daemon-backed guest-to-host bridge is internal. The positive loopback and host-MCP cases are covered by the integration test in `tests/desktop-container-agentd.integration.test.ts`.

## Environment

Optional:

```bash
export DESKTOP_CONTAINER_WORKSPACE_DIR=/absolute/path/to/workspace
export DESKTOP_CONTAINER_USER_DATA_DIR=/custom/path
export DESKTOP_CONTAINER_AGENT_IMAGE=acon-desktop-acpx:0.1
export DESKTOP_APPLE_CONTAINER_REPO_DIR=/absolute/path/to/apple-container
export DESKTOP_CONTAINER_CLAUDE_IMAGE=acon-desktop-claude:0.1
export DESKTOP_CONTAINER_CODEX_IMAGE=acon-desktop-codex:0.1
export DESKTOP_CONTAINER_BIN_PATH=/absolute/path/to/container
export DESKTOP_PREPARE_CONTAINER_ASSETS=0
export APPLE_KEYCHAIN_PROFILE=acon-notary
export APPLE_API_KEY_PATH=/absolute/path/to/AuthKey_ABCDEFGHIJ.p8
export APPLE_API_KEY_ID=ABCDEFGHIJ
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
export APPLE_ID=developer@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=ABCDEFGHIJ
```

`DESKTOP_CONTAINER_ACPX_IMAGE` is still accepted as a legacy alias.

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

- `desktop-container/backend/container-runtime.ts` verifies that the prebuilt Apple container image is available, starts the long-lived shared agent container daemon, and drives provider turns with per-thread session reuse.
- The backend mounts an app-managed persistent workspace into the container at `/workspace`.
- Provider-specific runtime data lives under the shared desktop runtime directory and is mounted into the container under `/data/providers/<provider>`.
- `desktop-container/container-images/` contains the shared Apple-container image definition that installs Codex, Claude Code, PI, `pi-acp`, and OpenCode together, plus the internal `acon-agentd` daemon and the `acon-mcp` convenience CLI so agents can reach host MCP servers from inside the container.
- Packaged builds should stage the Apple `container` CLI at `Contents/Resources/desktop/bin/container`, the helper tree at `Contents/Resources/desktop/libexec/container/`, builtin plugin manifests under `Contents/Resources/desktop/plugins/builtin/`, and the image contexts at `Contents/Resources/desktop/container-images/`.
- `desktop-container/backend/extensions/host.ts` discovers V2 `camelai` plugin manifests from `desktop-container/plugins/builtin/` plus the user install directory, loads extension modules, enforces manifest metadata such as API compatibility and declared permissions, supports registration disposables plus `deactivate()` cleanup, and exposes the runtime-first API (`on`, `registerView`, `registerCommand`, `registerTool`, `registerHttpRoute`, `registerHttpProxy`, `registerProcessEnv`, `registerMcpServer`, persisted host MCP management, thread preview mutation) that materializes plugin workbench views into the shared snapshot model.
- `desktop-container/backend/extensions/thread-state.ts` provides a persistent per-thread plugin state store under the desktop runtime directory so workbench views and runtime hooks can share thread-scoped JSON state.
- `desktop-container/backend/extensions/harness-adapters.ts` is the abstraction layer between supported harnesses and the unified extension model; it currently includes `codex`, `claude-code`, `pi`, and `opencode` adapter identities.
- `desktop/electron/main.mjs` exposes the desktop-shell install flow for user plugins, including folder selection, copying into the user plugin directory, and triggering a live catalog refresh; enabled and disabled plugin state is persisted in the desktop backend store and surfaced through Extension Lab.
- `desktop-container/plugins/` contains repo-shipped V2 plugins, with `plugins/builtin/` reserved for curated builtins. The current builtin set includes `chat`, `extension-lab`, `host-mcp-manager`, `kanban`, `preview-control`, and `thread-journal`.
- V2 plugin manifests can optionally declare `camelai.agentAssets` with `skills` and/or `mcpServers` relative paths. `skills` points at a directory of `SKILL.md` folders bundled in the plugin, and `mcpServers` points at a JSON file with an `mcpServers` object using the portable subset (`stdio` command/args/env/cwd or `streamable-http`/`sse` url/headers). These assets are reconciled declaratively on plugin load and refresh for the providers that currently consume plugin agent assets: Codex installs skills under `~/.codex/skills/` and writes namespaced `mcp_servers.*` entries into `~/.codex/config.toml`, while Claude installs skills under `~/.claude/skills/` and writes project-scoped `mcpServers` entries for `/workspace` in `~/.claude.json`.
- `desktop-container/sdk/index.ts` contains the extension-facing V2 manifest and activation API types.
- `desktop-container/electron/main.mjs` loads the desktop backend service directly into the Electron main process via `tsx`.
- The shared desktop renderer (`desktop/renderer/src/App.tsx`) renders builtin and plugin-contributed workbench surfaces. Trusted builtin plugins can bind host-rendered components directly into the renderer tree through a namespaced registry, while plugin-contributed sidebar panels populate the left navigation around the workbench. Chat-owned preview tabs still live in a thread-scoped side pane that is separate from the main workbench tabs, and plugin-owned webviews can render `http:`, `https:`, `data:`, and plugin-local HTML entrypoints in a sandboxed iframe via the desktop file/webview bridge.
- `desktop-container/scripts/dev.mjs` reuses the existing desktop renderer and shared Electron shell, but writes state into a separate user-data directory so it does not collide with the older helper-based prototype.
