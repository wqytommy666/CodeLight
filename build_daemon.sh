#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
OUTPUT="${1:-$ROOT/.build/agent-light-daemon}"
mkdir -p "${OUTPUT:h}"

/usr/bin/swiftc -O "$ROOT/Sources/AgentLightDaemon.swift" -o "$OUTPUT"

# A stable designated requirement lets macOS keep the user's Bluetooth grant
# across backend updates. The default linker signature is tied to one CDHash,
# which makes every new build look like a different Bluetooth application.
/usr/bin/codesign --force --sign - \
  --identifier com.local.codelight.ble-helper \
  --requirements '=designated => identifier "com.local.codelight.ble-helper"' \
  "$OUTPUT"
