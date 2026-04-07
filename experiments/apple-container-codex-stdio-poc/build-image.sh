#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-acon-codex-stdio-poc:0.1}"
CODEX_VERSION="${CODEX_VERSION:-0.116.0}"

container build \
  --progress plain \
  --build-arg "CODEX_VERSION=${CODEX_VERSION}" \
  --file "${SCRIPT_DIR}/Containerfile" \
  --tag "${IMAGE_NAME}" \
  "${SCRIPT_DIR}"
