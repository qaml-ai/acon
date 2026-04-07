# acon

## Overview

This repository contains only the standalone `acon` desktop app.

Core areas:

- `desktop-container/` Apple `container` desktop backend, scripts, SDK, and builtin plugins
- `desktop/renderer/` shared desktop renderer used by the app
- `desktop/electron/` shared Electron shell
- `desktop/shared/` backend/renderer protocol and message-state helpers
- `src/` shared UI components, hooks, styles, and utilities consumed by the renderer

## Commands

- `bun run desktop-container:dev` start the app in development
- `bun run desktop-container:start` launch Electron against an already-running renderer
- `bun run desktop-container:check` typecheck the container backend path
- `bun run desktop:check` typecheck the shared renderer path
- `bun run test:desktop-container-renderer` run the renderer streaming test

## Repo Policy

- Do not reintroduce the old monorepo web app, Workers, sandbox-host, or deployment code here.
- Prefer `desktop-container/` for runtime and extension-host changes.
- Prefer `desktop/renderer/` and `src/` for desktop UI changes.
- User plugins are installed into the desktop data directory under `plugins/`, and the builtin Extension Lab view is the primary install/manage entrypoint for them.
- Keep this file current when the standalone architecture changes.
