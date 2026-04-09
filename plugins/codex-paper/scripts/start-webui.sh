#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_ROOT="$PLUGIN_ROOT/src/web"
PID_FILE="${PID_FILE:-/tmp/codex-paper-webui.pid}"
LOG_FILE="${LOG_FILE:-/tmp/codex-paper-webui.log}"
PORT="${PORT:-5815}"

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

PLUGIN_VERSION="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN_ROOT/.codex-plugin/plugin.json")"
printf '%s' "$PLUGIN_VERSION" > "$WEB_ROOT/.output/.build-version"

nohup env PORT="$PORT" "$NODE_BIN" "$WEB_ROOT/.output/server/index.mjs" > "$LOG_FILE" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://localhost:$PORT/api/papers" > /dev/null; then
    echo "Codex Paper web UI is running at http://localhost:$PORT"
    echo "PID: $SERVER_PID"
    exit 0
  fi
  sleep 1
done

echo "Error: Codex Paper web UI failed to become healthy." >&2
if kill -0 "$SERVER_PID" 2>/dev/null; then
  kill "$SERVER_PID" 2>/dev/null || true
fi
rm -f "$PID_FILE"
exit 1
