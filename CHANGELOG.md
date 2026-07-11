# Changelog

## Unreleased

- Made `plugins/codex-paper/` the only executable source tree and `.agents/plugins/marketplace.json` the only repository marketplace.
- Added an immutable 2.0 contract baseline, compatible 2.1 evolution ADR, and a dependency-free repository/CI contract gate.
- Updated plugin ingestion metadata to current Codex manifest and agent interface requirements.
- Removed the divergent legacy tree; it remains available through Git history.

## 2.0.0 - Evidence and Reasoning v2

- Added page-aware `evidence-ledger.json` with stable evidence IDs and parser quality flags.
- Added `reasoning-analysis.json`, reasoning scaffolding, paper profiles, self-review checklist, and semantic validation.
- Integrated v2 reasoning validation into study-package validation while preserving v1 `--legacy-ok` compatibility.
- Added reasoning and package benchmark suites alongside the existing parser benchmark.
- Added Web UI reasoning path, reviewer view, and evidence audit APIs with v1 fallback behavior.
- Added `paper-only`, `canonical`, and `literature` context modes with external evidence isolated in `.codex-paper/external-evidence.json`.
- Added v1 migration tooling, CI coverage, and v2 contract documentation.
