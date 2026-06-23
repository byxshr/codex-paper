#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cmd_install() {
  ensure_node
  ensure_npm
  ensure_python

  print_section "Plugin Dependencies"
  (cd "$PLUGIN_ROOT" && "$NPM_BIN" install)

  print_section "Web Dependencies"
  (cd "$WEB_ROOT" && "$NPM_BIN" install)

  print_section "Paper Library"
  bash "$PLUGIN_ROOT/hooks/check-install.sh"

  print_section "PyMuPDF"
  ensure_pymupdf
  echo "PyMuPDF is available."

  print_section "Done"
  echo "Codex Paper dependencies are installed."
}

cmd_build() {
  cmd_install

  print_section "Build Web Viewer"
  (cd "$WEB_ROOT" && "$NPM_BIN" run build)
  ensure_build_version

  print_section "Done"
  echo "Build output: $WEB_ROOT/.output/server/index.mjs"
}

cmd_start() {
  if [ ! -f "$WEB_ROOT/.output/server/index.mjs" ]; then
    print_section "Build Missing"
    cmd_build
  fi

  print_section "Start Viewer"
  bash "$PLUGIN_ROOT/scripts/start-webui.sh"
}

cmd_stop() {
  print_section "Stop Viewer"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    kill "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    echo "Stopped Codex Paper web UI."
  else
    rm -f "$PID_FILE"
    echo "Codex Paper web UI is not running."
  fi
}

cmd_status() {
  print_section "Status"
  echo "Repo: $REPO_ROOT"
  echo "Plugin: $PLUGIN_ROOT"
  echo "Papers: $PAPERS_DIR"
  echo "Benchmark Dir: $BENCHMARK_DIR"
  echo "Port: $PORT"

  if [ -f "$WEB_ROOT/.output/server/index.mjs" ]; then
    echo "Build: present"
  else
    echo "Build: missing"
  fi

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Viewer: running (PID $(cat "$PID_FILE"))"
  else
    echo "Viewer: stopped"
  fi

  if curl -sf "http://localhost:$PORT/api/papers" > /dev/null 2>&1; then
    echo "Health: API reachable"
  else
    echo "Health: API not reachable"
  fi
}

cmd_benchmark() {
  ensure_node
  ensure_python
  ensure_pymupdf

  if [ ! -d "$PLUGIN_ROOT/node_modules/pdf-parse" ]; then
    print_section "Dependencies Missing"
    cmd_install
  fi

  print_section "Benchmark"
  BENCHMARK_DIR="$BENCHMARK_DIR" \
  BENCHMARK_REPORT_FILE="$BENCHMARK_REPORT_FILE" \
  "$NODE_BIN" "$REPO_ROOT/benchmarks/run-benchmark.mjs"
}

cmd_test() {
  ensure_node

  print_section "Unit Tests"
  "$NODE_BIN" --test "$PLUGIN_ROOT"/skills/study/scripts/tests/*.mjs
}

cmd_reasoning_test() {
  ensure_node

  print_section "Reasoning Benchmark"
  "$NODE_BIN" "$REPO_ROOT/benchmarks/run-reasoning-benchmark.mjs"
}

cmd_package_test() {
  ensure_node

  print_section "Package Benchmark"
  "$NODE_BIN" "$REPO_ROOT/benchmarks/run-package-benchmark.mjs"
}

cmd_benchmark_all() {
  cmd_benchmark
  cmd_reasoning_test
  cmd_package_test
}

cmd_migrate() {
  ensure_node

  if [ "$#" -lt 1 ]; then
    echo "Usage: bash scripts/codex-paper.sh migrate <paper-dir-or-slug> [--force] [--context paper-only|canonical|literature] [--profile ...]" >&2
    exit 1
  fi

  print_section "Migrate Package"
  "$NODE_BIN" "$PLUGIN_ROOT/skills/study/scripts/migrate-package.js" "$@"
}

cmd_benchmark_report() {
  ensure_node

  print_section "Benchmark Report"
  BENCHMARK_REPORT_FILE="$BENCHMARK_REPORT_FILE" \
  "$NODE_BIN" "$REPO_ROOT/benchmarks/benchmark-report.mjs"
}

cmd_smoke_test() {
  local smoke_pdf="${SMOKE_PDF:-/tmp/codex-paper-smoke.pdf}"
  local smoke_outdir
  local smoke_port="${SMOKE_PORT:-5816}"
  local smoke_pid=""

  smoke_outdir="$(mktemp -d /tmp/codex-paper-images.XXXXXX)"

  cleanup() {
    local pid="${smoke_pid:-}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  }

  trap cleanup EXIT

  cmd_build

  print_section "Create Smoke PDF"
  "$PYTHON_BIN" - <<'PY'
import fitz
pdf_path = '/tmp/codex-paper-smoke.pdf'
doc = fitz.open()
page = doc.new_page()
page.insert_text(
    (72, 72),
    'Codex Paper Smoke Test\n'
    'Abstract A minimal test PDF for Codex Paper.\n'
    'Introduction\n'
    'This is a smoke test.'
)
doc.save(pdf_path)
doc.close()
print(pdf_path)
PY

  print_section "Parse PDF"
  "$NODE_BIN" "$PLUGIN_ROOT/skills/study/scripts/parse-pdf.js" "$smoke_pdf"

  print_section "Extract Images"
  "$PYTHON_BIN" "$PLUGIN_ROOT/skills/study/scripts/extract-images.py" "$smoke_pdf" "$smoke_outdir"

  print_section "Start Temporary Viewer"
  ensure_build_version
  PORT="$smoke_port" "$NODE_BIN" "$WEB_ROOT/.output/server/index.mjs" > "$LOG_FILE" 2>&1 &
  smoke_pid=$!

  if ! wait_for_http "http://localhost:$smoke_port/api/papers" 10; then
    echo "Error: smoke-test viewer failed to become healthy." >&2
    exit 1
  fi

  print_section "Verify Viewer"
  curl -sf "http://localhost:$smoke_port/api/papers"
  printf '\n---HOME---\n'
  curl -sf "http://localhost:$smoke_port/" | head -5

  print_section "Done"
  echo "Smoke test passed."
  echo "Smoke PDF: $smoke_pdf"
  echo "Extracted images: $smoke_outdir"
  trap - EXIT
  cleanup
}

cmd_help() {
  cat <<'EOF'
Usage:
  bash scripts/codex-paper.sh <command>

Commands:
  install      Install plugin, web, and Python dependencies
  build        Build the production web viewer
  start        Start the local web viewer
  stop         Stop the local web viewer
  status       Show build and viewer status
  benchmark    Run the parser benchmark against the local paper examples
  test         Run deterministic unit tests
  reasoning-test Run reasoning validation fixtures
  package-test Run package quality fixtures
  benchmark-all  Run parser, reasoning, and package benchmarks
  migrate      Migrate a v1 package to v2 evidence/reasoning draft files
  benchmark-report  Print the latest benchmark report
  smoke-test   Run an end-to-end local smoke test
  help         Show this help message
EOF
}

command_name="${1:-help}"

case "$command_name" in
  install)
    cmd_install
    ;;
  build)
    cmd_build
    ;;
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  status)
    cmd_status
    ;;
  benchmark)
    cmd_benchmark
    ;;
  test)
    cmd_test
    ;;
  reasoning-test)
    cmd_reasoning_test
    ;;
  package-test)
    cmd_package_test
    ;;
  benchmark-all)
    cmd_benchmark_all
    ;;
  migrate)
    shift
    cmd_migrate "$@"
    ;;
  benchmark-report)
    cmd_benchmark_report
    ;;
  smoke-test)
    cmd_smoke_test
    ;;
  help|-h|--help)
    cmd_help
    ;;
  *)
    echo "Unknown command: $command_name" >&2
    echo >&2
    cmd_help >&2
    exit 1
    ;;
esac
