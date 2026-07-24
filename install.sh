#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
INSTALL_ROOT="$HOME/.agent-status-light"
BIN_DIR="$INSTALL_ROOT/bin"
LOG_DIR="$INSTALL_ROOT/logs"
PLIST="$HOME/Library/LaunchAgents/com.local.agent-status-light.plist"
WATCH_PLIST="$HOME/Library/LaunchAgents/com.local.agent-status-light-watch.plist"
DEVICE_ID="$(<"$ROOT/device.id")"

mkdir -p "$ROOT/.build" "$BIN_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"

echo "[1/5] 编译常驻 BLE 控制器"
"$ROOT/build_daemon.sh" "$ROOT/.build/agent-light-daemon"
DAEMON_HASH="$(/usr/bin/shasum -a 256 "$ROOT/.build/agent-light-daemon" | /usr/bin/awk '{print substr($1,1,12)}')"
DAEMON_TARGET="$BIN_DIR/agent-light-daemon-$DAEMON_HASH"

echo "[2/5] 安装客户端和设备配置"
if [[ ! -e "$DAEMON_TARGET" ]]; then
  /bin/cp "$ROOT/.build/agent-light-daemon" "$DAEMON_TARGET"
fi
/bin/cp "$ROOT/agent_light.py" "$BIN_DIR/agent-light-hook"
/bin/cp "$ROOT/status_watch.py" "$BIN_DIR/agent-light-watch"
/bin/chmod 755 "$DAEMON_TARGET" "$BIN_DIR/agent-light-hook" "$BIN_DIR/agent-light-watch"
print -r -- "$DEVICE_ID" > "$INSTALL_ROOT/device.id"

echo "[3/5] 安装 macOS LaunchAgent"
/bin/cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.agent-status-light</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DAEMON_TARGET</string>
    <string>$DEVICE_ID</string>
    <string>48733</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/daemon-error.log</string>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$PLIST" >/dev/null

/bin/cat > "$WATCH_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.agent-status-light-watch</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$BIN_DIR/agent-light-watch</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/watch.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/watch-error.log</string>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$WATCH_PLIST" >/dev/null

echo "[4/5] 接入已安装的 Ping Island / Coffee 生命周期 hooks"
/usr/bin/env python3 "$ROOT/integrate_hooks.py"

echo "[5/5] 启动后台服务"
/bin/launchctl bootout "gui/$UID/com.local.agent-status-light" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$UID" "$PLIST"
/bin/launchctl kickstart "gui/$UID/com.local.agent-status-light"
/bin/launchctl bootout "gui/$UID/com.local.agent-status-light-watch" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$UID" "$WATCH_PLIST"
/bin/launchctl kickstart "gui/$UID/com.local.agent-status-light-watch"

for _ in {1..30}; do
  if "$BIN_DIR/agent-light-hook" ping >/dev/null 2>&1; then
    echo "安装完成：后台服务已响应。"
    "$BIN_DIR/agent-light-hook" status
    exit 0
  fi
  /bin/sleep 0.1
done

echo "后台服务尚未响应，请查看 $LOG_DIR/daemon-error.log" >&2
exit 1
