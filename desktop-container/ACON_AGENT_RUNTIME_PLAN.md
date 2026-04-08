# Acon Agent Runtime Plan

## Summary

The desktop container backend should stop depending on ACPX in production and replace it with a smaller app-specific runtime written in JavaScript.

The replacement should also absorb the current guest-to-host bridge daemon so the system has:

- one long-lived process inside the container
- one persistent stdio pipe between host and guest
- one app-owned session model
- no runtime `npx` adapter downloads
- no Rust compile step in container image preparation

## Why Replace ACPX

ACPX is not large in absolute terms, but it is larger and more generic than this app needs.

Local measurements from the vendored package:

- `acpx` dist: about 12k JS lines
- biggest files are generic prompt/session/runtime code, not provider-specific logic

For this app, we currently use only a small slice of that surface:

- ensure a persistent session
- set model
- stream a prompt
- cancel a prompt

What ACPX adds beyond that:

- generic CLI parsing
- config files and defaults
- queue-owner TTL management
- output formatting modes
- replay/flow/runtime extras
- runtime `npx` adapter download behavior

Those are useful for a general-purpose CLI, but they are not core product requirements for `acon`.

## Current Problem

We now have two separate concerns layered together:

1. agent session runtime
2. guest-to-host RPC bridge for MCP and fetch

Today this is split across:

- ACPX for agent sessions
- `acon-host-bridge.mjs` for guest-to-host RPC
- `acon-mcp` as a small guest CLI that talks to the bridge socket

That creates unnecessary moving parts:

- ACPX session lifecycle
- bridge daemon lifecycle
- separate transport assumptions
- downloaded or compiled adapters

## Recommendation

Build a small app-specific guest daemon, tentatively `acon-agentd.mjs`.

It should replace both ACPX and `acon-host-bridge.mjs`.

That daemon should:

- own provider session state for Codex and Claude
- expose prompt/cancel/model/session operations to the host backend
- expose a guest-local socket for `acon-mcp`
- forward MCP and fetch requests back to the host over the same stdio connection

This gives us one host/guest transport and one supervised process.

## Target Architecture

```text
desktop backend
    |
    | stdio JSON-RPC
    v
container main process: acon-agentd.mjs
    |
    | local session management
    | local provider adapters
    | local unix socket
    v
guest helpers like acon-mcp
```

### Host To Guest

The desktop backend talks to `acon-agentd` over stdio with JSON-RPC messages such as:

- `session.ensure`
- `session.set_model`
- `session.prompt`
- `session.cancel`
- `session.close`

### Guest To Host

`acon-agentd` sends host-owned requests back over the same stdio pipe for:

- `host.mcp.list_servers`
- `host.mcp.request`
- `host.mcp.close`
- `host.fetch`
- optional `host.log`

### Guest Local Socket

Inside the container, `acon-agentd` can still expose a Unix socket for helper CLIs:

- `acon-mcp`

That socket is only guest-local. The only host/guest transport is still the stdio pipe to `acon-agentd`.

## Adapter Complexity

The inherent complexity is not zero, but it is smaller than the full ACPX plus custom bridge stack.

### Claude

Claude is the easier path.

The official Claude ACP adapter is already TypeScript-based and uses the Claude Agent SDK. That suggests a JS-native adapter for `acon` is realistic.

Likely responsibilities:

- launch and manage the Claude session/client
- stream assistant/tool events
- cancel active work
- preserve thread session identity

### Codex

Codex is the harder path.

The hard part is not spawning a process. The hard part is matching Codex turn semantics correctly:

- start a turn
- stream updates
- cancel a turn
- queue follow-up input or steer active input
- keep transcript/event ordering sane

The earlier forking work showed that Codex behavior around overlapping prompts is real, but the semantics matter. If we want native steering, the right path is to talk to Codex's native structured protocol, not scrape a PTY.

### Practical Estimate

My estimate for an app-specific replacement is:

- runtime daemon and transport layer: modest
- Claude adapter: modest
- Codex adapter: moderate

The complexity is concentrated in Codex streaming and turn semantics, not in the generic runtime shell.

## What Should Not Be Rebuilt

We should not rebuild all of ACPX.

We do not need:

- generic config files
- generic flow/replay support
- generic adapter registry
- `npx` install logic
- a general-purpose CLI UX

We need a small internal runtime for this app.

## Proposed Internal Interface

```ts
type AgentAdapter = {
  ensureSession(args: EnsureSessionArgs): Promise<EnsureSessionResult>;
  setModel?(args: SetModelArgs): Promise<void>;
  prompt(args: PromptArgs): AsyncIterable<AgentEvent>;
  cancel(args: CancelArgs): Promise<void>;
  close?(args: CloseArgs): Promise<void>;
};
```

The daemon owns:

- session registry
- adapter lookup
- stream multiplexing
- request ids
- persistence paths
- guest-local RPC socket for `acon-mcp`

The desktop backend owns:

- threads and message state
- renderer-facing state
- host MCP registry
- auth seeding
- container lifecycle

## Transport Recommendation

Use bidirectional JSON-RPC over stdio between host and `acon-agentd`.

Reasons:

- already proven workable in the current bridge shape
- easy to debug
- no extra daemon inside the container
- no mounted host socket dependency
- no NPM download step
- no Rust toolchain or cross-build requirement

## `acon-mcp` Recommendation

Keep `acon-mcp` as a tiny helper CLI, but make it talk to `acon-agentd` instead of a separate bridge daemon.

That keeps the guest UX simple:

- `acon-mcp servers`
- `acon-mcp tools <server-id>`
- `acon-mcp <server-id>`

But removes the extra bridge process.

## Migration Plan

1. Add `acon-agentd.mjs` with only host RPC passthrough and local socket support.
2. Move `acon-host-bridge.mjs` functionality into it.
3. Update `acon-mcp` to talk to `acon-agentd`.
4. Add a Claude adapter inside `acon-agentd`.
5. Change the backend to use direct daemon RPC for Claude instead of ACPX.
6. Add a Codex adapter inside `acon-agentd`.
7. Change the backend to use direct daemon RPC for Codex.
8. Remove ACPX from the container image and runtime path.
9. Delete the Codex ACP fork/build path entirely.

## Bottom Line

For `acon`, replacing ACPX with a JS-native internal runtime is justified.

The key constraint is not generic RPC or CLI complexity. The key constraint is implementing Codex and Claude session semantics correctly.

The right end state is:

- one guest daemon
- one host/guest stdio transport
- one app-owned session model
- tiny guest helper CLIs
- no runtime adapter download
- no Rust build in container preparation
