#!/bin/zsh
set -u

SCRIPT_DIR=${0:A:h}
REPO_ROOT=${SCRIPT_DIR:h}
NODE_PATH=${LOVELACE_NODE_PATH:-$(command -v node)}
SERVER_PATH="$REPO_ROOT/packages/server/dist/index.js"
SYSTEM_PROXY_RESOLVER="$REPO_ROOT/packages/server/dist/macos-system-proxy.js"
PROXY_TARGET_URL=${LOVELACE_SYSTEM_PROXY_TARGET_URL:-https://api.atlassian.com/}
POLL_INTERVAL=${LOVELACE_NETWORK_POLL_INTERVAL_SECONDS:-30}
child_pid=

resolve_network_config() {
  local resolved
  resolved="$("$NODE_PATH" "$SYSTEM_PROXY_RESOLVER" "$PROXY_TARGET_URL" 2>/dev/null)"
  if [[ "$resolved" == http://* || "$resolved" == https://* ]]; then
    print -r -- "$resolved"
  else
    print -r -- DIRECT
  fi
}

stop_server() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  child_pid=
}

trap 'stop_server; exit 0' INT TERM HUP

while true; do
  network_config="$(resolve_network_config)"
  if [[ "$network_config" != DIRECT ]]; then
    echo "Starting Lovelace with the macOS system proxy"
    /usr/bin/env \
      HTTP_PROXY="$network_config" \
      HTTPS_PROXY="$network_config" \
      NODE_USE_ENV_PROXY=1 \
      "$NODE_PATH" "$SERVER_PATH" &
  else
    echo "Starting Lovelace with direct network access"
    /usr/bin/env \
      -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      -u http_proxy -u https_proxy -u all_proxy \
      -u NODE_USE_ENV_PROXY \
      "$NODE_PATH" "$SERVER_PATH" &
  fi
  child_pid=$!

  while kill -0 "$child_pid" 2>/dev/null; do
    sleep "$POLL_INTERVAL" &
    wait $! 2>/dev/null || true

    next_network_config="$(resolve_network_config)"
    if [[ "$next_network_config" != "$network_config" ]]; then
      echo "macOS system proxy changed; restarting Lovelace"
      stop_server
      break
    fi
  done

  if [[ -n "$child_pid" ]]; then
    wait "$child_pid" 2>/dev/null || true
    child_pid=
  fi
  sleep 1
done
