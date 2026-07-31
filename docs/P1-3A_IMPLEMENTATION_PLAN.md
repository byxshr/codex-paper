# P1-3a Implementation Plan

## Goal

Freeze the supported host, parser, Viewer, and sandbox runtimes; make dependency risk reviewable; and provide machine-readable inputs for P1-4 provenance without rewriting existing generations.

## Baseline

- Host: Node 22.23.1, npm 10.9.8, CPython 3.11.15, PyMuPDF 1.28.0.
- Viewer: Nuxt 4.5.1 and Vue 3.5.40 with SSR, DevTools, telemetry, and unused Content integration disabled.
- Sandbox: Node 20.20.2 and CPython 3.11.15 copied from digest-pinned official images.
- Python dependencies live in a private user-cache venv and are installed only from hash-locked binary wheels.

## Gates

- `runtime-status` verifies the exact supported runtime and emits path-redacted JSON.
- `dependency-audit` blocks critical and unreviewed high advisories.
- `secret-scan` scans tracked repository content without printing matched values.
- `supply-chain-test` verifies exact dependency specs, lock integrity, image/action pins, and reviewed artifact hashes.
- Repository Guard and CI prevent removal or weakening of these gates.

## Rollback

Revert the P1-3a source changes and remove the managed user-cache runtime. Existing paper generations and authoritative manifests require no rollback because P1-3a does not rewrite them.

## Handoff

P1-4 consumes the stable runtime policy and `runtime-status --json` output. P1-3b remains responsible for root workspaces, `npm ci`, strict type/lint gates, coverage, update automation, and a second runtime/OS matrix.
