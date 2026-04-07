# Apple Container Codex Stdio POC

This is a separate proof of concept for running `codex app-server` inside Apple's open-source `container` runtime and talking to it over attached `stdin`/`stdout`.

What it proves:

- `container run -i` is enough to host a newline-delimited JSON-RPC stdio session.
- `codex app-server --listen stdio://` works cleanly inside a Linux container.
- A mounted data volume can persist `CODEX_HOME` across runs.
- A mounted workspace can be used as the thread `cwd`.

## Files

- `Containerfile`: builds a Linux image with the Codex CLI installed.
- `entrypoint.sh`: sets `HOME` and `CODEX_HOME` under `/data`, then launches the app server.
- `run-raw-stdio.sh`: launches the container and leaves stdio attached for manual experimentation.
- `smoke-test.mjs`: starts the container, performs `initialize`, `thread/start`, and `turn/start`, then waits for `turn/completed`.
- `smoke-test.sh`: builds the image if needed, then runs the automated smoke test.

## Requirements

- Apple `container` CLI installed and running.
- Network access from the container if Codex needs to reach OpenAI.
- Either:
  - `OPENAI_API_KEY` in the host environment, or
  - host auth under `~/.codex/` so the script can mount that directory into the container on first run and seed `auth.json`.

## Build

```bash
./experiments/apple-container-codex-stdio-poc/build-image.sh
```

Optional:

```bash
CODEX_VERSION=0.118.0 ./experiments/apple-container-codex-stdio-poc/build-image.sh
```

## Manual Raw Stdio

This runs the container with the app server attached directly to your terminal:

```bash
./experiments/apple-container-codex-stdio-poc/run-raw-stdio.sh
```

You can then send newline-delimited JSON-RPC messages such as:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"poc","version":"0.1.0"}}}
{"method":"initialized"}
```

## Automated Smoke Test

```bash
./experiments/apple-container-codex-stdio-poc/smoke-test.sh
```

The smoke test:

1. starts the container with stdio attached
2. initializes the Codex app server
3. creates a thread with `/workspace` as the cwd
4. sends a single turn asking for `POC OK`
5. prints the final assistant text and thread id

## Notes

- This POC intentionally avoids a separate HTTP control plane.
- The app server itself is the only protocol endpoint.
- The transport is plain stdio, not websockets or HTTP.
- The data volume defaults to `experiments/apple-container-codex-stdio-poc/.local/data`.
