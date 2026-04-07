# Apple Container ACPX Codex POC

This proof of concept runs `acpx` inside an Apple `container` VM and uses `acpx` as the compatibility layer in front of Codex.

The container command is:

```bash
acpx --format json --approve-all --cwd /workspace codex exec --file -
```

That means:

- stdin carries the prompt text
- stdout emits ACP JSON-RPC messages from `acpx`
- Codex is the underlying agent
- `~/.acpx` and `~/.codex` persist under the mounted `/data` volume

## Files

- `Containerfile`: installs `acpx` and the Codex CLI in a Linux image
- `entrypoint.sh`: sets `HOME` and `CODEX_HOME` under `/data` and seeds auth
- `run-raw-json.sh`: leaves the raw ACP JSON stream attached to your terminal
- `smoke-test.mjs`: sends a prompt on stdin and parses the ACP JSON-RPC response stream
- `smoke-test.sh`: builds the image if needed and runs the smoke test

## Build

```bash
./experiments/apple-container-acpx-codex-poc/build-image.sh
```

Optional version overrides:

```bash
ACPX_VERSION=0.5.1 CODEX_VERSION=0.116.0 ./experiments/apple-container-acpx-codex-poc/build-image.sh
```

## Manual Raw JSON

```bash
./experiments/apple-container-acpx-codex-poc/run-raw-json.sh
```

Then type a prompt and close stdin, for example:

```bash
printf '%s\n' 'Reply with exactly ACPX RAW OK and nothing else.' | \
  ./experiments/apple-container-acpx-codex-poc/run-raw-json.sh
```

## Automated Smoke Test

```bash
./experiments/apple-container-acpx-codex-poc/smoke-test.sh
```

The smoke test expects a response of `ACPX CONTAINER POC OK`.

## Notes

- This POC does not expose the Codex app-server directly.
- The stable outer interface is `acpx`.
- For other agents later, you would keep the same `acpx` surface and swap the underlying agent install and subcommand.
