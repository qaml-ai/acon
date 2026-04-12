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
- Keep chat as a builtin trusted plugin surface rendered inside the workbench host tree, not as a webview.
- Use plugin-contributed sidebar panels for extensible left-nav sections such as recent chats or workflow boards.
- Treat thread preview items as regular workbench tabs that can open in a neighboring split pane beside chat.
- Use the builtin `preview-control` extension when host MCP or plugin code needs to open or manage thread-scoped file or URL tabs.
- When running a web server inside the guest container, bind it to `0.0.0.0` instead of `localhost`.
- When opening a preview URL for a guest web server, use the current container IP instead of `localhost`.
- User plugins are installed into the desktop data directory under `plugins/`, and the builtin Extension Lab view is the primary install/manage entrypoint for them.
- User-uploaded files are mounted into the guest container at `/mnt/user-uploads`. Read user-provided input files from there when the prompt references them.
- User-deliverable artifacts such as spreadsheets, reports, exports, and generated documents should be written to `/mnt/user-outputs` so the desktop app can offer them back to the user via download.
- When producing a deliverable in `/mnt/user-outputs`, mention the full output path in the assistant response so the desktop app can surface the result clearly.
- Keep this file current when the standalone architecture changes.
