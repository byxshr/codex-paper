#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_ROOT="$PLUGIN_ROOT/src/web"
PID_FILE="${PID_FILE:-/tmp/codex-paper-webui.pid}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/codex-paper-webui.token}"
LOG_FILE="${LOG_FILE:-/tmp/codex-paper-webui.log}"
ERR_LOG_FILE="${ERR_LOG_FILE:-/tmp/codex-paper-webui.err.log}"
PORT="${PORT:-5815}"
PAPERS_DIR="${PAPERS_DIR:-$HOME/codex-papers}"
LAUNCH_LABEL="${LAUNCH_LABEL:-com.codex-paper.webui}"
LAUNCH_PLIST="${LAUNCH_PLIST:-/tmp/codex-paper-webui.plist}"
NODE_REQUIRED="22.23.1"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  NODE_BIN="/usr/local/bin/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "Error: node is not available on PATH." >&2
  exit 1
fi
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
if [ "$NODE_VERSION" != "$NODE_REQUIRED" ]; then
  echo "Error: Node $NODE_REQUIRED is required; found $NODE_VERSION." >&2
  exit 3
fi

if [ ! -f "$WEB_ROOT/.output/server/index.mjs" ]; then
  echo "Error: production build not found at $WEB_ROOT/.output/server/index.mjs" >&2
  exit 1
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Codex Paper web UI is already running at http://127.0.0.1:$PORT"
  if [ -f "$TOKEN_FILE" ]; then
    echo "Pairing token: $(cat "$TOKEN_FILE")"
  fi
  exit 0
fi

if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; then
  if command -v launchctl >/dev/null 2>&1; then
    SERVER_PID="$(launchctl print "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null | awk '/pid = / {print $3; exit}' || true)"
    if [ -n "${SERVER_PID:-}" ]; then
      echo "$SERVER_PID" > "$PID_FILE"
    fi
  fi
  echo "Codex Paper web UI is already running at http://127.0.0.1:$PORT"
  exit 0
fi

umask 077
PAIRING_TOKEN="$($NODE_BIN -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
printf '%s' "$PAIRING_TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

PLUGIN_VERSION="$("$NODE_BIN" -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$PLUGIN_ROOT/.codex-plugin/plugin.json")"
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
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>NITRO_HOST</key>
    <string>127.0.0.1</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PAPERS_DIR</key>
    <string>$PAPERS_DIR</string>
    <key>CODEX_PAPER_PAIRING_TOKEN</key>
    <string>$PAIRING_TOKEN</string>
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
  chmod 600 "$LAUNCH_PLIST"

  launchctl bootout "gui/$uid/$LAUNCH_LABEL" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "gui/$uid" "$LAUNCH_PLIST"; then
    rm -f "$LAUNCH_PLIST"
    return 1
  fi
  rm -f "$LAUNCH_PLIST"
}

start_with_nohup() {
  nohup env PORT="$PORT" HOST=127.0.0.1 NITRO_HOST=127.0.0.1 NODE_ENV=production \
    PAPERS_DIR="$PAPERS_DIR" CODEX_PAPER_PAIRING_TOKEN="$PAIRING_TOKEN" \
    "$NODE_BIN" "$WEB_ROOT/.output/server/index.mjs" > "$LOG_FILE" 2>&1 < /dev/null &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
}

if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  start_with_launchctl || start_with_nohup
else
  start_with_nohup
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null; then
    if [ -z "${SERVER_PID:-}" ] && command -v launchctl >/dev/null 2>&1; then
      SERVER_PID="$(launchctl print "gui/$(id -u)/$LAUNCH_LABEL" 2>/dev/null | awk '/pid = / {print $3; exit}' || true)"
      if [ -n "$SERVER_PID" ]; then
        echo "$SERVER_PID" > "$PID_FILE"
      fi
    fi
    echo "Codex Paper web UI is running at http://127.0.0.1:$PORT"
    echo "Pairing token: $PAIRING_TOKEN"
    echo "Token file (0600): $TOKEN_FILE"
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
rm -f "$TOKEN_FILE" "$LAUNCH_PLIST"
exit 1
