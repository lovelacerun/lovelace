#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
LABEL="com.lentfort.lovelace.server"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
NODE_PATH=$(command -v node)
RUNNER_PATH="$SCRIPT_DIR/run-macos-launch-agent.sh"
LOG_DIR="${LOVELACE_ROOT:-$HOME/projects}/.lovelace/logs"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>ProgramArguments</key>
    <array>
      <string>$RUNNER_PATH</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${NODE_PATH:h}:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>LOVELACE_NODE_PATH</key>
      <string>$NODE_PATH</string>
    </dict>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/launchd-error.log</string>
  </dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"
echo "Installed $LABEL at $PLIST_PATH"
