#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="${IMAGE_NAME:-acon-acpx-claude-poc:0.1}"
ACPX_VERSION="${ACPX_VERSION:-0.5.1}"
CLAUDE_VERSION="${CLAUDE_VERSION:-2.1.92}"

container build \
  --progress plain \
  --build-arg "ACPX_VERSION=${ACPX_VERSION}" \
  --build-arg "CLAUDE_VERSION=${CLAUDE_VERSION}" \
  --file "${SCRIPT_DIR}/Containerfile" \
  --tag "${IMAGE_NAME}" \
  "${SCRIPT_DIR}"
