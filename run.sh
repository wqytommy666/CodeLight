#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
SOURCE="$ROOT/Sources/BLEProbe.swift"
BINARY="$ROOT/.build/ble-probe"
DEVICE_ID_FILE="$ROOT/device.id"

if [[ ! -x "$BINARY" || "$SOURCE" -nt "$BINARY" ]]; then
  mkdir -p "$ROOT/.build"
  swiftc "$SOURCE" -o "$BINARY"
fi

command_name="${1:-probe}"
case "$command_name" in
  scan)
    exec "$BINARY" scan "${2:-12}"
    ;;
  probe)
    target="${2:-$(<"$DEVICE_ID_FILE")}"
    exec "$BINARY" probe "$target" "${3:-2}"
    ;;
  *)
    echo "Usage: $0 scan [seconds] | probe [target] [hold-seconds]" >&2
    exit 64
    ;;
esac
