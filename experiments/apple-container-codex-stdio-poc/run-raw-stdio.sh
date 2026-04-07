#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-acon-codex-stdio-poc:0.1}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DATA_DIR="${DATA_DIR:-${SCRIPT_DIR}/.local/data}"
CONTAINER_NAME="${CONTAINER_NAME:-acon-codex-stdio-poc}"

mkdir -p "${DATA_DIR}"

if ! container image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  "${SCRIPT_DIR}/build-image.sh"
fi

args=(
  run
  --rm
  --interactive
  --name "${CONTAINER_NAME}"
  --volume "${DATA_DIR}:/data"
  --volume "${WORKSPACE_DIR}:/workspace"
  --workdir /workspace
)

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  args+=(--env "OPENAI_API_KEY=${OPENAI_API_KEY}")
fi

if [[ -d "${HOME}/.codex" ]]; then
  args+=(--mount "type=bind,source=${HOME}/.codex,target=/seed-codex,readonly")
fi

args+=("${IMAGE_NAME}")

exec container "${args[@]}"
