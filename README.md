# acon

Standalone repository for the Apple `container` backed camelAI desktop app.

This repo keeps the local Electron shell and shared desktop renderer, and runs chats inside Apple `container` VMs through ACPX-backed Codex and Claude providers.

## Commands

```bash
bun install
bun run dev
bun run check
bun run probe
bun run test:renderer
bun run test:integration
```

Useful variants:

- `bun run start` launches Electron against an already-running renderer.
- `bun run check:backend` checks only the Apple `container` backend.
- `bun run check:renderer` checks only the shared renderer.
- `bun run probe:claude` and `bun run probe:codex` run provider-specific end-to-end turn probes.

## Structure

- `desktop-container/` container backend, scripts, SDK, and builtin plugins
- `desktop/renderer/` shared desktop renderer
- `desktop/electron/` shared Electron shell
- `desktop/shared/` backend/renderer protocol
- `src/` shared UI components and utilities used by the renderer

## Branches

- `main` is the standalone split of the original repo's `main` branch
- `codex/plugin-system-v2-rewrite` carries the plugin-system rewrite branch
