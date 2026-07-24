#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
SOURCE="$ROOT/Sources/LightControl.swift"
BINARY="$ROOT/.build/light-control"
DEVICE_ID="$(<"$ROOT/device.id")"

if [[ ! -x "$BINARY" || "$SOURCE" -nt "$BINARY" ]]; then
  mkdir -p "$ROOT/.build"
  swiftc "$SOURCE" -o "$BINARY"
fi

if (( $# == 0 )); then
  echo "Usage: $0 red|yellow|green|blue|on|off|test|blink ..." >&2
  exit 64
fi

exec "$BINARY" "$DEVICE_ID" "$@"
