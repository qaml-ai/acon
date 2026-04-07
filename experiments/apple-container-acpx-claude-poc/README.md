# Apple Container ACPX Claude POC

This proof of concept runs `acpx` inside an Apple `container` VM and uses Claude Code as the underlying agent.

The container command is:

```bash
acpx --format json --approve-all --cwd /workspace claude exec --file -
```

That means:

- stdin carries the prompt text
- stdout emits ACP JSON-RPC messages from `acpx`
- Claude Code is the underlying agent
- `~/.acpx`, `~/.claude`, and `~/.claude.json` persist under the mounted `/data` volume

## Files

- `Containerfile`: installs `acpx` and Claude Code in a Linux image
- `entrypoint.sh`: sets `HOME` and `CLAUDE_CONFIG_DIR` under `/data` and seeds Claude auth/config
- `run-raw-json.sh`: leaves the raw ACP JSON stream attached to your terminal
- `smoke-test.mjs`: sends a prompt on stdin and parses the ACP JSON-RPC response stream
- `smoke-test.sh`: builds the image if needed and runs the smoke test

## Build

```bash
./experiments/apple-container-acpx-claude-poc/build-image.sh
```

Optional version overrides:

```bash
ACPX_VERSION=0.5.1 CLAUDE_VERSION=2.1.92 ./experiments/apple-container-acpx-claude-poc/build-image.sh
```

## Manual Raw JSON

```bash
printf '%s\n' 'Reply with exactly CLAUDE RAW OK and nothing else.' | \
  ./experiments/apple-container-acpx-claude-poc/run-raw-json.sh
```

## Automated Smoke Test

```bash
./experiments/apple-container-acpx-claude-poc/smoke-test.sh
```

The smoke test expects a response of `CLAUDE CONTAINER POC OK`.

## Notes

- This POC uses `acpx` as the stable outer interface and Claude Code as the interchangeable backend.
- The prompt is fed through stdin with `--file -`, so the host closes stdin after writing the prompt.
