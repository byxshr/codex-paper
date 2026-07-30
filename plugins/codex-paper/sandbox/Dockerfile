ARG PYTHON_BASE_IMAGE=python:3.11.15-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba
ARG BASE_IMAGE=node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
FROM ${BASE_IMAGE} AS node-runtime
FROM ${PYTHON_BASE_IMAGE}

ARG CODEX_PAPER_POLICY_HASH

LABEL org.opencontainers.image.title="Codex Paper generated-code sandbox" \
      org.opencontainers.image.description="Offline, read-only runtime for explicitly approved Codex Paper demos" \
      io.codex-paper.sandbox.policy="1.0.0" \
      io.codex-paper.sandbox.conformance="1.0.0" \
      io.codex-paper.sandbox.policy-hash="${CODEX_PAPER_POLICY_HASH}"

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

RUN set -eux; \
    rm -rf \
      /usr/local/bin/pip \
      /usr/local/bin/pip3 \
      /usr/local/bin/pip3.11 \
      /usr/local/lib/python3.11/ensurepip \
      /usr/local/lib/python3.11/site-packages/pip \
      /usr/local/lib/python3.11/site-packages/pip-* \
      /usr/local/lib/python3.11/site-packages/setuptools \
      /usr/local/lib/python3.11/site-packages/setuptools-* \
      /usr/local/lib/python3.11/site-packages/pkg_resources \
      /usr/local/lib/python3.11/site-packages/wheel \
      /usr/local/lib/python3.11/site-packages/wheel-*; \
    python3 -I -B -c 'import bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib'; \
    python3 -I -B -c 'import importlib.util, shutil; assert all(importlib.util.find_spec(name) is None for name in ("pip", "setuptools", "wheel", "pkg_resources")); assert shutil.which("pip") is None; assert shutil.which("npm") is None'; \
    test "$(node -p 'process.versions.node')" = "20.20.2"

COPY entrypoint.py /usr/local/lib/codex-paper-sandbox/entrypoint.py

ENTRYPOINT ["python3", "/usr/local/lib/codex-paper-sandbox/entrypoint.py"]
