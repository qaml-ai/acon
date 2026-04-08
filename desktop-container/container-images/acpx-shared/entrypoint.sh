#!/bin/sh
set -eu

ACON_UID=1000
ACON_GID=1000

mkdir -p /data/providers /workspace /data/host-rpc

if [ "$(id -u)" -eq 0 ]; then
  chown "${ACON_UID}:${ACON_GID}" /data/host-rpc
  chmod 700 /data/host-rpc
fi

if [ "$(id -u)" -eq 0 ]; then
  if ! command -v setpriv >/dev/null 2>&1; then
    echo "desktop-entrypoint: setpriv is required to drop root privileges" >&2
    exit 1
  fi

  exec setpriv \
    --reuid "$ACON_UID" \
    --regid "$ACON_GID" \
    --clear-groups \
    "$@"
fi

exec "$@"
