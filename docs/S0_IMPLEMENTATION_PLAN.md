# S0-1 Implementation Record

- Work item: `S0-1` — single active tree and contract baseline
- Branch: `codex/audit-optimizations-2026-07-10`
- Date: 2026-07-10
- Delivery status: `未推送`
- Code review summary: `docs/S0-1_CODE_REVIEW_SUMMARY.md`

## Scope and decisions

This change removes the executable legacy tree, makes `plugins/codex-paper/` and `.agents/plugins/marketplace.json` authoritative, fixes plugin ingestion metadata, freezes the existing 2.0 schemas, and adds a dependency-free repository gate. Contract evolution is documented for a compatible 2.1 writer; typed result claims and Validation Report 1.0 behavior are explicitly deferred to P0-B2/P0-B3.

The audit sample artifacts are the files under `/Users/bianyuxin/codex-papers/papers/attention-is-all-you-need`. They are evidence for the audit only and are not copied into this repository.

## Implementation checklist

- [x] Confirm the active tree and compare all tracked legacy files.
- [x] Remove `plugin/`, the duplicate root marketplace, and unused `original-plugin.json`.
- [x] Normalize the active plugin manifest and chat agent interface.
- [x] Add the machine-readable contract baseline and ADR.
- [x] Add repository guard tests and a fail-fast CI gate.
- [x] Update English/Chinese repository guidance and historical baseline notes.
- [x] Run plugin validation before and after the UTC cachebuster.
- [x] Run repository, unit, benchmark, build, and smoke validation.
- [x] Reinstall from the existing local marketplace and verify the active path/version.
- [x] Complete independent review and update the audit tracker.

## Acceptance commands

```bash
bash scripts/codex-paper.sh repo-check
bash scripts/codex-paper.sh test
bash scripts/codex-paper.sh reasoning-test
bash scripts/codex-paper.sh package-test
bash scripts/codex-paper.sh benchmark
bash scripts/codex-paper.sh build
bash scripts/codex-paper.sh smoke-test
python3 /Users/bianyuxin/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-paper
codex plugin add codex-paper@codex-paper
codex plugin list
```

## Results

- Repository contract: passed; 31 guard tests passed, including CLI parsing, prompt-count enforcement, lockfile false-positive isolation, active-tree, root/nested second-manifest, symlink, generated-artifact, immutable-baseline, README, and licensed-fixture adversarial cases.
- Existing study unit tests: 23/23 passed.
- Reasoning benchmark: 12/12 passed.
- Package benchmark: 10/10 passed.
- Parser benchmark: 5/5 passed against the configured local examples.
- Production build: passed.
- End-to-end smoke test: passed.
- Official plugin validation: passed before and after cachebusting.
- Installed plugin: `codex-paper@codex-paper`, version `2.0.0+codex.20260710083739`.
- Verified source path: `/Users/bianyuxin/claude_code_dir/codex-paper/plugins/codex-paper`.
- Independent review: passed after two adversarial hardening rounds; no remaining blocking findings.
- Dependency note: the Web install continues to report the 34 audit findings already recorded in the v2 baseline; dependency remediation is outside S0.

## Rollback

Revert the S0 change set. Git history remains the archive for the deleted legacy tree. If contract work must be rolled back independently, restore this baseline file and ADR together with the guard so the recorded hashes and enforcement never diverge.
