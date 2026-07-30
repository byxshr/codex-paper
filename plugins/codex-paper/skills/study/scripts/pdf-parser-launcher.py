#!/usr/bin/env python3
"""Apply hard POSIX limits before replacing this process with the PDF worker."""

import os
import resource
import sys


def main() -> int:
    if len(sys.argv) < 6:
        print("codex-paper parser launcher: invalid arguments", file=sys.stderr)
        return 126
    cpu_seconds = int(sys.argv[1])
    file_bytes = int(sys.argv[2])
    open_files = int(sys.argv[3])
    executable = sys.argv[4]
    argv = sys.argv[4:]
    managed_python = os.environ.get("CODEX_PAPER_PYTHON_BIN")
    runtime_root = os.environ.get("CODEX_PAPER_RUNTIME_DIR")
    if not managed_python or not runtime_root:
        print("codex-paper parser launcher: managed runtime identity is missing", file=sys.stderr)
        return 126
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_bytes, file_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (open_files, open_files))
    safe_env = {
        "HOME": os.environ["HOME"],
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "CODEX_PAPER_PARSER_WORKER": "1",
        "CODEX_PAPER_PYTHON_BIN": managed_python,
        "CODEX_PAPER_RUNTIME_DIR": runtime_root,
    }
    os.execve(executable, argv, safe_env)
    return 126


if __name__ == "__main__":
    raise SystemExit(main())
