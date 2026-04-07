# acon

## Overview

This repository contains only the standalone `acon` desktop app.

Core areas:

- `desktop-agentos/` AgentOS-backed desktop backend, scripts, SDK, and builtin plugins
- `desktop/renderer/` shared desktop renderer used by the app
- `desktop/electron/` shared Electron shell
- `desktop/shared/` backend/renderer protocol and message-state helpers
- `src/` shared UI components, hooks, styles, and utilities consumed by the renderer

## Commands

- `bun run desktop-agentos:dev` start the app in development
- `bun run desktop-agentos:start` launch Electron against an already-running renderer
- `bun run desktop-agentos:check` typecheck the AgentOS backend path
- `bun run desktop:check` typecheck the shared renderer path
- `bun run test:desktop-agentos-renderer` run the renderer streaming test

## Repo Policy

- Do not reintroduce the old monorepo web app, Workers, sandbox-host, or deployment code here.
- Prefer `desktop-agentos/` for runtime and extension-host changes.
- Prefer `desktop/renderer/` and `src/` for desktop UI changes.
- User plugins are installed into the desktop data directory under `plugins/`, and the builtin Extension Lab view is the primary install/manage entrypoint for them.
- AgentOS synthesizes a read-only `/home/user/.agents` mount from plugin-local `.agents/skills/` directories so Pi can auto-discover plugin-provided skills.
- Keep this file current when the standalone architecture changes.
