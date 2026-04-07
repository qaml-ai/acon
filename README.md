# acon

Standalone repository for the Apple `container` backed camelAI desktop app.

This repo keeps the local Electron shell and shared desktop renderer, and runs chats inside Apple `container` VMs through ACPX-backed Codex and Claude providers.

## Commands

```bash
bun install
bun run desktop-container:dev
bun run desktop-container:check
bun run desktop:check
bun run test:desktop-container-renderer
```

## Structure

- `desktop-container/` container backend, scripts, SDK, and builtin plugins
- `desktop/renderer/` shared desktop renderer
- `desktop/electron/` shared Electron shell
- `desktop/shared/` backend/renderer protocol
- `src/` shared UI components and utilities used by the renderer

## Branches

- `main` is the standalone split of the original repo's `main` branch
- `codex/plugin-system-v2-rewrite` carries the plugin-system rewrite branch
