# acon

Standalone repository for the AgentOS-backed camelAI desktop app.

This repo keeps the local Electron shell and shared desktop renderer, but runs chats against an embedded [AgentOS](https://rivet.dev/docs/agent-os/overview/) VM instead of the older containerized desktop runtime.

## Commands

```bash
bun install
bun run desktop-agentos:dev
bun run desktop-agentos:check
bun run desktop:check
bun run test:desktop-agentos-renderer
```

## Structure

- `desktop-agentos/` AgentOS backend, scripts, SDK, and builtin plugins
- `desktop/renderer/` shared desktop renderer
- `desktop/electron/` shared Electron shell
- `desktop/shared/` backend/renderer protocol
- `src/` shared UI components and utilities used by the renderer

## Branches

- `main` is the standalone split of the original repo's `main` branch
- `codex/plugin-system-v2-rewrite` carries the plugin-system rewrite branch
