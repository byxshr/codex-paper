#!/usr/bin/env python3
"""Trusted container entrypoint for one generated-code artifact."""

import json
import os
import resource
import subprocess
import sys
import time
from pathlib import Path

WORKSPACE = Path("/workspace")
RESULT_PATH = Path("/tmp/codex-paper-resource.json")
SAFE_ENV = {
    "HOME": "/tmp/home",
    "LANG": "C.UTF-8",
    "PATH": "/usr/local/bin:/usr/bin:/bin",
}


def fail(message: str, code: int = 126) -> int:
    print(f"codex-paper sandbox: {message}", file=sys.stderr)
    return code


def child_limits() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (67_108_864, 67_108_864))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    if hasattr(resource, "RLIMIT_NPROC"):
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))


def write_result(started: float, completed: float, status: int) -> None:
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    payload = {
        "wallTimeMs": round((completed - started) * 1000, 3),
        "userCpuMs": round(usage.ru_utime * 1000, 3),
        "systemCpuMs": round(usage.ru_stime * 1000, 3),
        "maxRssKiB": usage.ru_maxrss,
        "status": status,
    }
    temporary = RESULT_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, RESULT_PATH)


def main() -> int:
    if len(sys.argv) != 3:
        return fail("expected exactly <python|node> <workspace-relative-file>")

    runtime, filename = sys.argv[1:]
    if Path(filename).name != filename or filename.startswith("-"):
        return fail("artifact must be a plain top-level filename")

    suffix = Path(filename).suffix.lower()
    if runtime == "python" and suffix == ".py":
        command = ["python3", "-I", "-B", f"/workspace/{filename}"]
    elif runtime == "node" and suffix in {".js", ".mjs"}:
        command = ["node", "--disable-proto=delete", "--no-addons", f"/workspace/{filename}"]
    else:
        return fail("runtime and extension are not allowed")

    artifact = WORKSPACE / filename
    if artifact.is_symlink() or not artifact.is_file():
        return fail("artifact is not a regular file")

    os.makedirs(SAFE_ENV["HOME"], mode=0o700, exist_ok=True)
    started = time.monotonic()
    try:
        completed_process = subprocess.run(
            command,
            cwd=WORKSPACE,
            env=SAFE_ENV,
            stdin=subprocess.DEVNULL,
            check=False,
            preexec_fn=child_limits,
        )
        status = completed_process.returncode
    except Exception as error:  # pragma: no cover - defensive container boundary
        print(f"codex-paper sandbox: launch failed: {error}", file=sys.stderr)
        status = 126
    completed = time.monotonic()
    write_result(started, completed, status)
    return status if status >= 0 else 128 + abs(status)


if __name__ == "__main__":
    raise SystemExit(main())
