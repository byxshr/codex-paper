#!/bin/bash
set -euo pipefail

RUNTIME_ROOT="${CODEX_PAPER_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/codex-paper/runtime-v1}"
MANAGED_PYTHON="$RUNTIME_ROOT/python-3.11.15/bin/python"
PYTHON_BIN="$MANAGED_PYTHON"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Error: managed CPython 3.11.15 runtime is unavailable. Run: bash scripts/codex-paper.sh runtime-setup" >&2
  exit 3
fi

if [ -L "$PYTHON_BIN" ]; then
  echo "Error: managed Python executable must be an ordinary file contained in the runtime." >&2
  exit 3
fi

if ! "$PYTHON_BIN" -I -B -c 'import bz2,ctypes,fitz,hashlib,lzma,os,platform,readline,sqlite3,ssl,sys,sysconfig,uuid,zlib; root=os.path.realpath(sys.argv[1]); contained=lambda value: os.path.commonpath((root,os.path.realpath(value)))==root; assert platform.python_implementation()=="CPython"; assert platform.python_version()=="3.11.15"; assert fitz.__version__=="1.28.0"; assert contained(sys.base_prefix) and contained(sysconfig.get_path("stdlib")) and contained(os.__file__)' "$RUNTIME_ROOT/python-3.11.15" >/dev/null 2>&1; then
  echo "Error: managed Python runtime must be CPython 3.11.15 with PyMuPDF 1.28.0." >&2
  exit 3
fi

exec "$PYTHON_BIN" -I -B "$@"
