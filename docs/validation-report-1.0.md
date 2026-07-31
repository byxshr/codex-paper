# Validation Report 1.0 Contract

Validation Report 1.0 is the authoritative machine-readable quality view for a Codex Paper package. Both reasoning and complete-package validation update the single file:

```text
.codex-paper/validation-report.json
```

No parallel report is defined.

## Intrinsic result

`status` describes the artifacts, independently of the caller's policy:

- `pass`: no error or warning findings.
- `pass_with_warnings`: warnings exist, but no errors.
- `fail`: at least one error exists.

`phase` is `draft` for the reasoning gate and `complete` for the full package gate. `publishable` is true only for a complete report whose intrinsic status is not `fail`.

`findings` is authoritative. Every finding has a stable ID, severity, code, category, artifact-relative path, bounded message, evidence references, and locations. `errors` and `warnings` are compatibility projections of the same findings.

The report caps findings at 500. If validation would exceed that budget, it retains a deterministic subset and adds the blocking `VALIDATION_FINDINGS_TRUNCATED` finding.

## Gate policy

The standard reasoning gate returns `allow_authoring` when no errors block the draft phase. The standard complete gate returns `allow_publish` for `pass` and `pass_with_warnings`.

`--strict` changes only `gate.policy`, `gate.outcome`, `gate.blockingFindingCodes`, and the CLI exit code. A warning blocks the strict gate, but it does not change `status`, `publishable`, findings, or `reportHash`.

CLI exit codes are:

- `0`: `allow_authoring` or `allow_publish`.
- `1`: gate outcome `block`.
- `2`: invalid arguments, unsafe paths, unsupported package versions, or validator runtime failure.

## Scope and boundaries

A draft report includes the source metadata, paper data, evidence ledger, facts, low-level analysis, and reasoning artifacts. A complete report additionally includes all user-visible Markdown and `index.html`.

The validator checks schema/version integrity, evidence-reference existence, ResultClaim projection and numeric consistency, result conflicts and disclosure, visible metric-bound results, and explicit parser-risk signals. Reference coverage means only that references are syntactically valid and resolve; it does not claim semantic or scientific correctness.

The report explicitly excludes generated-code execution, external scientific truth, complex table-grid reconstruction, and the execution semantics of opening exported HTML directly. Viewer rendering remains protected by the P0-A2 static sandbox boundary.

Numeric disclosure matching currently recognizes plain integer and decimal forms, including a trailing percent sign. Thousands-separated forms such as `41,800` are not normalized; large-magnitude metric support should add one shared parser for disclosure, visible-claim extraction, and projection checks rather than changing one detector in isolation.

## Compatibility

- Package `2.1.0`: full native validation.
- Package `2.0.0`: in-memory legacy-reference compatibility plus `PACKAGE_COMPATIBILITY_LIMITED`; only the report may be written.
- v1: limited read-only validation requires `--legacy-ok`; no 1.0 report is written.
- Unknown versions or corrupt authoritative metadata: fail closed without package writes.

Validation never migrates or rewrites other package artifacts.

## Integrity and write safety

`reportHash` is SHA-256 over the canonical intrinsic payload: status, phase, publishable, scope, findings, reference coverage, and validator policy version. It excludes timestamps, gate policy/outcome, compatibility projections, and the hash object itself.

The writer rejects symlinked paper directories, `.codex-paper` directories, and report targets. It writes with a no-follow temporary file, fsyncs it, and atomically renames it into place. Paths and diagnostics remain package-relative.

## Commands

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js <paper> [--json] [--strict] [--allow-draft]
node plugins/codex-paper/skills/study/scripts/validate-study-package.js <paper> [--lang zh|en] [--legacy-ok] [--json] [--strict]
bash scripts/codex-paper.sh validation-test
```

The recommended authoring flow is standard reasoning gate, visible authoring, then standard complete gate. Use strict mode only when warnings should explicitly block the current invocation.
