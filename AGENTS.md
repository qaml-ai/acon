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

- `bun run dev` start the app in development
- `bun run start` launch Electron against an already-running renderer
- `bun run check` typecheck both the container backend and the shared renderer paths
- `bun run check:backend` typecheck only the container backend path
- `bun run check:renderer` typecheck only the shared renderer path
- `bun run test:renderer` run the renderer streaming test

## Repo Policy

- Do not reintroduce the old monorepo web app, Workers, sandbox-host, or deployment code here.
- Prefer `desktop-container/` for runtime and extension-host changes.
- Prefer `desktop/renderer/` and `src/` for desktop UI changes.
- Keep chat as a core desktop surface owned by the workbench, not a builtin plugin contribution.
- Keep thread preview items in the dedicated right-side preview pane instead of the main workbench tab strip.
- Use the builtin `preview-control` extension when host MCP or plugin code needs to open or manage thread preview items for files or URLs.
- User plugins are installed into the desktop data directory under `plugins/`, and the builtin Extension Lab view is the primary install/manage entrypoint for them.
- Keep this file current when the standalone architecture changes.
