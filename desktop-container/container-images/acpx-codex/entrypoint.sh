#!/bin/sh
set -eu

: "${DESKTOP_DATA_ROOT:=/data}"
: "${HOME:=${DESKTOP_DATA_ROOT}/home}"
: "${CODEX_HOME:=${HOME}/.codex}"

HOME="${DESKTOP_DATA_ROOT}/home"
CODEX_HOME="${HOME}/.codex"

export HOME
export CODEX_HOME

mkdir -p "${CODEX_HOME}" "${HOME}/.acpx" /workspace

if [ -f /seed-codex/auth.json ] && [ ! -f "${CODEX_HOME}/auth.json" ]; then
  cp /seed-codex/auth.json "${CODEX_HOME}/auth.json"
fi

exec "$@"
