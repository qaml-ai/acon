#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-acon-acpx-claude-poc:0.1}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
DATA_DIR="${DATA_DIR:-${SCRIPT_DIR}/.local/data}"
CONTAINER_NAME="${CONTAINER_NAME:-acon-acpx-claude-poc}"

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
)

if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  args+=(--env "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
fi

if [[ -d "${HOME}/.claude" ]]; then
  args+=(--mount "type=bind,source=${HOME}/.claude,target=/seed-claude,readonly")
fi

if [[ -f "${HOME}/.claude.json" ]]; then
  mkdir -p "${SCRIPT_DIR}/.local/seed-claude-json"
  cp "${HOME}/.claude.json" "${SCRIPT_DIR}/.local/seed-claude-json/.claude.json"
  args+=(--mount "type=bind,source=${SCRIPT_DIR}/.local/seed-claude-json,target=/seed-claude-json,readonly")
fi

args+=("${IMAGE_NAME}")

exec container "${args[@]}"
