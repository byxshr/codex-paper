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
    rm -f "$PID_FILE" "$TOKEN_FILE"
    echo "Stopped Codex Paper web UI."
  else
    rm -f "$PID_FILE" "$TOKEN_FILE"
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

  if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
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

cmd_benchmark_mandatory() {
  ensure_node
  ensure_python
  ensure_pymupdf

  if [ ! -d "$PLUGIN_ROOT/node_modules/pdf-parse" ]; then
    print_section "Dependencies Missing"
    cmd_install
  fi

  print_section "Mandatory Deterministic PDF Regression"
  CODEX_PAPER_PYTHON_BIN="$PYTHON_BIN" \
  MANDATORY_BENCHMARK_REPORT_FILE="$MANDATORY_BENCHMARK_REPORT_FILE" \
  "$NODE_BIN" "$REPO_ROOT/benchmarks/run-mandatory-benchmark.mjs"
}

cmd_test() {
  ensure_node

  print_section "Repository Guard Tests"
  "$NODE_BIN" --test "$REPO_ROOT"/scripts/tests/*.test.mjs

  print_section "Unit Tests"
  "$NODE_BIN" --test "$PLUGIN_ROOT"/skills/study/scripts/tests/*.mjs
}

cmd_repo_check() {
  ensure_node

  print_section "Repository Contract"
  "$NODE_BIN" "$REPO_ROOT/scripts/check-repository.mjs" \
    --active-plugin-relative "$ACTIVE_PLUGIN_RELATIVE"
}

cmd_reasoning_test() {
  ensure_node

  print_section "Reasoning Benchmark"
  "$NODE_BIN" "$REPO_ROOT/benchmarks/run-reasoning-benchmark.mjs"
}

cmd_validation_test() {
  ensure_node

  print_section "Validation Report 1.0"
  "$NODE_BIN" --test \
    "$PLUGIN_ROOT/skills/study/scripts/tests/validation-report.test.mjs" \
    "$PLUGIN_ROOT/skills/study/scripts/tests/validate-reasoning.test.mjs"
}

cmd_package_test() {
  ensure_node

  print_section "Package Benchmark"
  "$NODE_BIN" "$REPO_ROOT/benchmarks/run-package-benchmark.mjs"
}

cmd_benchmark_all() {
  cmd_benchmark_mandatory
  cmd_benchmark
  cmd_reasoning_test
  cmd_package_test
}

cmd_migrate() {
  ensure_node

  if [ "$#" -lt 1 ]; then
    echo "Usage: bash scripts/codex-paper.sh migrate <paper-dir-or-slug> [--force] [--external-path] [--context paper-only|canonical|literature] [--profile ...]" >&2
    exit 1
  fi

  print_section "Migrate Package"
  "$NODE_BIN" "$PLUGIN_ROOT/skills/study/scripts/migrate-package.js" "$@"
}

cmd_benchmark_report() {
  ensure_node

  print_section "Benchmark Report"
  BENCHMARK_REPORT_FILE="$BENCHMARK_REPORT_FILE" \
  MANDATORY_BENCHMARK_REPORT_FILE="$MANDATORY_BENCHMARK_REPORT_FILE" \
  "$NODE_BIN" "$REPO_ROOT/benchmarks/benchmark-report.mjs"
}

cmd_smoke_test() {
  local smoke_pdf="${SMOKE_PDF:-/tmp/codex-paper-smoke.pdf}"
  local smoke_outdir
  local smoke_port="${SMOKE_PORT:-5816}"
  local smoke_pid=""
  local smoke_library
  local pairing_token
  local csrf_token
  local cookie_jar

  smoke_outdir="$(mktemp -d /tmp/codex-paper-images.XXXXXX)"
  smoke_library="$(mktemp -d /tmp/codex-paper-library.XXXXXX)"
  cookie_jar="$(mktemp /tmp/codex-paper-cookie.XXXXXX)"
  pairing_token="$($NODE_BIN -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  mkdir -p "$smoke_library/papers"
  printf '[]\n' > "$smoke_library/index.json"

  cleanup() {
    local pid="${smoke_pid:-}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -rf "$smoke_library" "$cookie_jar"
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
  PAPERS_DIR="$smoke_library" "$NODE_BIN" "$PLUGIN_ROOT/skills/study/scripts/parse-pdf.js" "$smoke_pdf"

  print_section "Extract Images"
  "$PYTHON_BIN" "$PLUGIN_ROOT/skills/study/scripts/extract-images.py" "$smoke_pdf" "$smoke_outdir"

  print_section "Start Temporary Viewer"
  ensure_build_version
  PORT="$smoke_port" HOST=127.0.0.1 NITRO_HOST=127.0.0.1 NODE_ENV=production \
    PAPERS_DIR="$smoke_library" CODEX_PAPER_PAIRING_TOKEN="$pairing_token" \
    "$NODE_BIN" "$WEB_ROOT/.output/server/index.mjs" > "$LOG_FILE" 2>&1 &
  smoke_pid=$!

  if ! wait_for_http "http://127.0.0.1:$smoke_port/api/health" 10; then
    echo "Error: smoke-test viewer failed to become healthy." >&2
    exit 1
  fi

  print_section "Verify Viewer"
  csrf_token="$(curl -sf -c "$cookie_jar" -H "Origin: http://127.0.0.1:$smoke_port" \
    -H 'Content-Type: application/json' --data "{\"token\":\"$pairing_token\"}" \
    "http://127.0.0.1:$smoke_port/api/session/pair" | \
    "$NODE_BIN" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).csrfToken))")"
  test -n "$csrf_token"
  curl -sf -b "$cookie_jar" "http://127.0.0.1:$smoke_port/api/papers"
  printf '\n---HOME---\n'
  curl -sf "http://127.0.0.1:$smoke_port/" | head -5

  print_section "Done"
  echo "Smoke test passed."
  echo "Smoke PDF: $smoke_pdf"
  echo "Extracted images: $smoke_outdir"
  trap - EXIT
  cleanup
}

cmd_security_test() {
  ensure_node
  if [ ! -f "$WEB_ROOT/.output/server/index.mjs" ]; then
    cmd_build
  fi
  print_section "Viewer HTTP Security"
  "$NODE_BIN" "$REPO_ROOT/scripts/tests/viewer-security.integration.mjs"
}

cmd_pdf_security_test() {
  ensure_node
  ensure_python
  ensure_pymupdf
  print_section "PDF Ingestion Security"
  "$NODE_BIN" --test "$REPO_ROOT/scripts/tests/pdf-ingestion-security.test.mjs"
}

cmd_sandbox_status() {
  ensure_node
  "$NODE_BIN" "$SANDBOX_RUNNER" status "$@"
}

cmd_sandbox_setup() {
  ensure_node
  print_section "Generated-code Sandbox Setup"
  "$NODE_BIN" "$SANDBOX_RUNNER" setup "$@"
}

cmd_sandbox_test() {
  ensure_node
  print_section "Generated-code Sandbox Conformance"
  "$NODE_BIN" "$SANDBOX_RUNNER" test "$@"
}

cmd_sandbox_plan() {
  ensure_node
  "$NODE_BIN" "$SANDBOX_RUNNER" plan "$@"
}

cmd_sandbox_run() {
  ensure_node
  "$NODE_BIN" "$SANDBOX_RUNNER" run "$@"
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
  repo-check   Verify the active plugin, contract baseline, and repository hygiene
  benchmark    Run the optional parser benchmark against local paper examples
  benchmark-mandatory Run the non-skippable deterministic PDF regression
  test         Run deterministic unit tests
  reasoning-test Run reasoning validation fixtures
  validation-test Run Validation Report 1.0 and cross-artifact gate tests
  package-test Run package quality fixtures
  benchmark-all  Run mandatory PDF, optional parser, reasoning, and package benchmarks
  migrate      Migrate a v1 package to v2 evidence/reasoning draft files
  benchmark-report  Print the latest benchmark report
  smoke-test   Run an end-to-end local smoke test
  security-test Run the real HTTP Viewer security integration test
  pdf-security-test Run downloader, parser-limit, and quarantine security tests
  sandbox-status Show whether the Docker sandbox is ready, unavailable, or nonconformant
  sandbox-setup Build the pinned sandbox image and run conformance tests
  sandbox-test Re-run real Docker sandbox conformance tests
  sandbox-plan <paper> [--json] Show the exact execution plan and issue a short-lived token only when ready
  sandbox-run <paper> --approval-token <token> [--json] Consume one approval token and run demos in Docker
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
  repo-check)
    cmd_repo_check
    ;;
  benchmark)
    cmd_benchmark
    ;;
  benchmark-mandatory)
    cmd_benchmark_mandatory
    ;;
  test)
    cmd_test
    ;;
  reasoning-test)
    cmd_reasoning_test
    ;;
  validation-test)
    cmd_validation_test
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
  security-test)
    cmd_security_test
    ;;
  pdf-security-test)
    cmd_pdf_security_test
    ;;
  sandbox-status)
    shift
    cmd_sandbox_status "$@"
    ;;
  sandbox-setup)
    shift
    cmd_sandbox_setup "$@"
    ;;
  sandbox-test)
    shift
    cmd_sandbox_test "$@"
    ;;
  sandbox-plan)
    shift
    cmd_sandbox_plan "$@"
    ;;
  sandbox-run)
    shift
    cmd_sandbox_run "$@"
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
