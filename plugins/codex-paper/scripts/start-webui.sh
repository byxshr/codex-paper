#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_ROOT="$PLUGIN_ROOT/src/web"
PID_FILE="${PID_FILE:-/tmp/codex-paper-webui.pid}"
LOG_FILE="${LOG_FILE:-/tmp/codex-paper-webui.log}"
ERR_LOG_FILE="${ERR_LOG_FILE:-/tmp/codex-paper-webui.err.log}"
PORT="${PORT:-5815}"
LAUNCH_LABEL="${LAUNCH_LABEL:-com.codex-paper.webui}"
LAUNCH_PLIST="${LAUNCH_PLIST:-/tmp/codex-paper-webui.plist}"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "Error: node is not available on PATH." >&2
  exit 1
fi

if [ ! -f "$WEB_ROOT/.output/server/index.mjs" ]; then
  echo "Error: production build not found at $WEB_ROOT/.output/server/index.mjs" >&2
  exit 1
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Codex Paper web UI is already running at http://localhost:$PORT"
  exit 0
fi

if curl -sf "http://127.0.0.1:$PORT/api/papers" > /dev/null; then
  if command -v launchctl >/dev/null 2>&1; then
    SERVER_PID="$(launchctl print "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null | awk '/pid = / {print $3; exit}' || true)"
    if [ -n "${SERVER_PID:-}" ]; then
      echo "$SERVER_PID" > "$PID_FILE"
    fi
  fi
  echo "Codex Paper web UI is already running at http://localhost:$PORT"
  exit 0
fi

PLUGIN_VERSION="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN_ROOT/.codex-plugin/plugin.json")"
printf '%s' "$PLUGIN_VERSION" > "$WEB_ROOT/.output/.build-version"

start_with_launchctl() {
  local uid
  uid="$(id -u)"

  cat > "$LAUNCH_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$WEB_ROOT/.output/server/index.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$WEB_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>$PORT</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$ERR_LOG_FILE</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$uid/$LAUNCH_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$LAUNCH_PLIST"
}

start_with_nohup() {
  nohup env PORT="$PORT" "$NODE_BIN" "$WEB_ROOT/.output/server/index.mjs" > "$LOG_FILE" 2>&1 < /dev/null &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
}

if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  start_with_launchctl || start_with_nohup
else
  start_with_nohup
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:$PORT/api/papers" > /dev/null; then
    if [ -z "${SERVER_PID:-}" ] && command -v launchctl >/dev/null 2>&1; then
      SERVER_PID="$(launchctl print "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null | awk '/pid = / {print $3; exit}' || true)"
      if [ -n "$SERVER_PID" ]; then
        echo "$SERVER_PID" > "$PID_FILE"
      fi
    fi
    echo "Codex Paper web UI is running at http://localhost:$PORT"
    if [ -n "${SERVER_PID:-}" ]; then
      echo "PID: $SERVER_PID"
    fi
    exit 0
  fi
  sleep 1
done

echo "Error: Codex Paper web UI failed to become healthy." >&2
if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
  kill "$SERVER_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"
exit 1
