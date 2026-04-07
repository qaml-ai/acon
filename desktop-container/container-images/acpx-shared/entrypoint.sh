#!/bin/sh
set -eu

mkdir -p /data/providers /workspace

exec "$@"
