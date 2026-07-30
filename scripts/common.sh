#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ACTIVE_PLUGIN_RELATIVE="plugins/codex-paper"
PLUGIN_ROOT="$REPO_ROOT/$ACTIVE_PLUGIN_RELATIVE"
WEB_ROOT="$PLUGIN_ROOT/src/web"
SANDBOX_RUNNER="$PLUGIN_ROOT/skills/study/scripts/sandbox-code.js"
WORKSPACE_CLI="$PLUGIN_ROOT/skills/study/scripts/workspace-cli.js"
PUBLICATION_CLI="$PLUGIN_ROOT/skills/study/scripts/publication-cli.js"
PROVENANCE_CLI="$PLUGIN_ROOT/skills/study/scripts/provenance-cli.js"
PAPERS_DIR="${PAPERS_DIR:-$HOME/codex-papers}"
BENCHMARK_DIR="${BENCHMARK_DIR:-${CODEX_PAPER_BENCHMARK_DIR:-$PAPERS_DIR/paper-examples}}"
BENCHMARK_REPORT_FILE="${BENCHMARK_REPORT_FILE:-/tmp/codex-paper-benchmark.json}"
MANDATORY_BENCHMARK_REPORT_FILE="${MANDATORY_BENCHMARK_REPORT_FILE:-/tmp/codex-paper-mandatory-benchmark.json}"
PID_FILE="${PID_FILE:-/tmp/codex-paper-webui.pid}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/codex-paper-webui.token}"
LOG_FILE="${LOG_FILE:-/tmp/codex-paper-webui.log}"
PORT="${PORT:-5815}"
RUNTIME_ROOT="${CODEX_PAPER_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-paper/runtime-v1}"
MANAGED_PYTHON="$RUNTIME_ROOT/python-3.11.15/bin/python"
NODE_REQUIRED="22.23.1"
NPM_REQUIRED="10.9.8"

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
  if [ -x "$MANAGED_PYTHON" ]; then
    echo "$MANAGED_PYTHON"
    return 0
  fi

  echo "$MANAGED_PYTHON"
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
export CODEX_PAPER_PYTHON_BIN="$PYTHON_BIN"

ensure_node() {
  if [ -z "${NODE_BIN:-}" ]; then
    echo "Error: node is not available on PATH." >&2
    exit 3
  fi
  local actual
  actual="$("$NODE_BIN" -p 'process.versions.node')"
  if [ "$actual" != "$NODE_REQUIRED" ]; then
    echo "Error: Node $NODE_REQUIRED is required; found $actual." >&2
    exit 3
  fi
}

ensure_npm() {
  if [ -z "${NPM_BIN:-}" ]; then
    echo "Error: npm is not available on PATH." >&2
    exit 3
  fi
  local actual
  actual="$("$NPM_BIN" --version)"
  if [ "$actual" != "$NPM_REQUIRED" ]; then
    echo "Error: npm $NPM_REQUIRED is required; found $actual." >&2
    exit 3
  fi
}

ensure_python() {
  if [ ! -x "${PYTHON_BIN:-}" ]; then
    echo "Error: managed CPython 3.11.15 is unavailable. Run: bash scripts/codex-paper.sh runtime-setup" >&2
    exit 3
  fi
  if [ -L "$PYTHON_BIN" ] || [ "$PYTHON_BIN" != "$MANAGED_PYTHON" ]; then
    echo "Error: production parser commands require the ordinary managed Python executable." >&2
    exit 3
  fi
}

ensure_pymupdf() {
  ensure_python
  if ! "$PYTHON_BIN" -I -B -c 'import bz2,ctypes,fitz,hashlib,lzma,os,platform,readline,sqlite3,ssl,sys,sysconfig,uuid,zlib; root=os.path.realpath(sys.argv[1]); contained=lambda value: os.path.commonpath((root,os.path.realpath(value)))==root; assert platform.python_implementation()=="CPython"; assert platform.python_version()=="3.11.15"; assert fitz.__version__=="1.28.0"; assert contained(sys.base_prefix) and contained(sysconfig.get_path("stdlib")) and contained(os.__file__)' "$RUNTIME_ROOT/python-3.11.15" >/dev/null 2>&1; then
    echo "Error: managed Python runtime does not match CPython 3.11.15 / PyMuPDF 1.28.0." >&2
    exit 3
  fi
}

plugin_version() {
  ensure_node
  "$NODE_BIN" -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$PLUGIN_ROOT/.codex-plugin/plugin.json"
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
