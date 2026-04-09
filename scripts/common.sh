#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_ROOT="$REPO_ROOT/plugins/codex-paper"
WEB_ROOT="$PLUGIN_ROOT/src/web"
PAPERS_DIR="${PAPERS_DIR:-$HOME/codex-papers}"
PID_FILE="${PID_FILE:-/tmp/codex-paper-webui.pid}"
LOG_FILE="${LOG_FILE:-/tmp/codex-paper-webui.log}"
PORT="${PORT:-5815}"

find_node_bin() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  if [ -x /usr/local/bin/node ]; then
    echo /usr/local/bin/node
    return 0
  fi

  if [ -x /opt/homebrew/bin/node ]; then
    echo /opt/homebrew/bin/node
    return 0
  fi

  return 1
}

find_npm_bin() {
  if command -v npm >/dev/null 2>&1; then
    command -v npm
    return 0
  fi

  if [ -x /usr/local/bin/npm ]; then
    echo /usr/local/bin/npm
    return 0
  fi

  if [ -x /opt/homebrew/bin/npm ]; then
    echo /opt/homebrew/bin/npm
    return 0
  fi

  return 1
}

find_python_bin() {
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi

  if [ -x /usr/bin/python3 ]; then
    echo /usr/bin/python3
    return 0
  fi

  return 1
}

NODE_BIN="${NODE_BIN:-$(find_node_bin || true)}"
NPM_BIN="${NPM_BIN:-$(find_npm_bin || true)}"
PYTHON_BIN="${PYTHON_BIN:-$(find_python_bin || true)}"

if [ -n "${NODE_BIN:-}" ]; then
  export PATH="$(dirname "$NODE_BIN"):$PATH"
fi

if [ -n "${NPM_BIN:-}" ]; then
  export PATH="$(dirname "$NPM_BIN"):$PATH"
fi

ensure_node() {
  if [ -z "${NODE_BIN:-}" ]; then
    echo "Error: node is not available on PATH." >&2
    exit 1
  fi
}

ensure_npm() {
  if [ -z "${NPM_BIN:-}" ]; then
    echo "Error: npm is not available on PATH." >&2
    exit 1
  fi
}

ensure_python() {
  if [ -z "${PYTHON_BIN:-}" ]; then
    echo "Error: python3 is not available on PATH." >&2
    exit 1
  fi
}

plugin_version() {
  ensure_python
  "$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN_ROOT/.codex-plugin/plugin.json"
}

ensure_build_version() {
  mkdir -p "$WEB_ROOT/.output"
  printf '%s' "$(plugin_version)" > "$WEB_ROOT/.output/.build-version"
}

print_section() {
  printf '\n== %s ==\n' "$1"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-10}"

  for _ in $(seq 1 "$attempts"); do
    if curl -sf "$url" > /dev/null; then
      return 0
    fi
    sleep 1
  done

  return 1
}
