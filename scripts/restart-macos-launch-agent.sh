#!/bin/zsh
set -euo pipefail

LABEL="com.lentfort.lovelace.server"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! -f "$PLIST_PATH" ]]; then
  echo "LaunchAgent not installed, skipping restart: $PLIST_PATH"
  exit 0
fi

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"
echo "Restarted $LABEL"
