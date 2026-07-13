ARG BASE_IMAGE=node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
FROM ${BASE_IMAGE}

ARG CODEX_PAPER_POLICY_HASH

LABEL org.opencontainers.image.title="Codex Paper generated-code sandbox" \
      org.opencontainers.image.description="Offline, read-only runtime for explicitly approved Codex Paper demos" \
      io.codex-paper.sandbox.policy="1.0.0" \
      io.codex-paper.sandbox.conformance="1.0.0" \
      io.codex-paper.sandbox.policy-hash="${CODEX_PAPER_POLICY_HASH}"

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3-minimal \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY entrypoint.py /usr/local/lib/codex-paper-sandbox/entrypoint.py

ENTRYPOINT ["python3", "/usr/local/lib/codex-paper-sandbox/entrypoint.py"]
