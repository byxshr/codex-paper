# Changelog

## 2.0.0 - Evidence and Reasoning v2

- Added page-aware `evidence-ledger.json` with stable evidence IDs and parser quality flags.
- Added `reasoning-analysis.json`, reasoning scaffolding, paper profiles, self-review checklist, and semantic validation.
- Integrated v2 reasoning validation into study-package validation while preserving v1 `--legacy-ok` compatibility.
- Added reasoning and package benchmark suites alongside the existing parser benchmark.
- Added Web UI reasoning path, reviewer view, and evidence audit APIs with v1 fallback behavior.
- Added `paper-only`, `canonical`, and `literature` context modes with external evidence isolated in `.codex-paper/external-evidence.json`.
- Added v1 migration tooling, CI coverage, and v2 contract documentation.
