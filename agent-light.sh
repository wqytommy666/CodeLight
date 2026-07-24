#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h}"
exec /usr/bin/env python3 "$ROOT/agent_light.py" "$@"
