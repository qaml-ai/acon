#!/bin/sh
set -eu

: "${DESKTOP_DATA_ROOT:=/data}"
: "${HOME:=${DESKTOP_DATA_ROOT}/home}"
: "${CLAUDE_CONFIG_DIR:=${HOME}/.claude}"

HOME="${DESKTOP_DATA_ROOT}/home"
CLAUDE_CONFIG_DIR="${HOME}/.claude"

export HOME
export CLAUDE_CONFIG_DIR

mkdir -p "${CLAUDE_CONFIG_DIR}" "${HOME}/.acpx" /workspace

if [ -f /seed-claude/.credentials.json ] && [ ! -f "${CLAUDE_CONFIG_DIR}/.credentials.json" ]; then
  cp /seed-claude/.credentials.json "${CLAUDE_CONFIG_DIR}/.credentials.json"
fi

if [ -f /seed-claude-json/.claude.json ] && [ ! -f "${HOME}/.claude.json" ]; then
  cp /seed-claude-json/.claude.json "${HOME}/.claude.json"
fi

exec "$@"
