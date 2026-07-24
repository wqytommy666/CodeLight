#!/bin/zsh
set -euo pipefail
LABEL="com.local.agent-status-light"
WATCH_LABEL="com.local.agent-status-light-watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WATCH_PLIST="$HOME/Library/LaunchAgents/$WATCH_LABEL.plist"
/bin/launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
/bin/launchctl bootout "gui/$UID/$WATCH_LABEL" >/dev/null 2>&1 || true
/bin/rm -f "$PLIST" "$WATCH_PLIST"
echo "已停止并移除 BLE 与 Codex 运行时监听 LaunchAgent；配置和备份保留在 ~/.agent-status-light 及 *.before-agent-light。"
