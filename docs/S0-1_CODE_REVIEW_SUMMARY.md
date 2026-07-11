# S0-1 Code Review Summary

## Review metadata

- Work item: `S0-1` — establish a single active tree and contract baseline
- Branch: `codex/audit-optimizations-2026-07-10`
- Date: 2026-07-10
- Development status: `Review 完成`
- Delivery status: `未推送`
- Installed plugin version: `2.0.0+codex.20260710083739`
- Authoritative plugin path: `/Users/bianyuxin/claude_code_dir/codex-paper/plugins/codex-paper`
- Authoritative marketplace: `.agents/plugins/marketplace.json`

## Outcome

S0-1 removes the repository's second executable plugin implementation and establishes `plugins/codex-paper/` as the only source, install, build, test, and release tree. It freezes the existing 2.0 schemas and future 2.1 compatibility decisions, repairs current Codex plugin ingestion metadata, and adds a dependency-free Repository Contract gate that runs before dependency installation in CI.

This work does not implement typed result claims, Validation Report 1.0 behavior, schema migration, security hardening, or dependency remediation. Those remain assigned to later P0/P1 work items.

## Change inventory

### Removed

- Entire top-level `plugin/` legacy tree, including its ignored dependency/build caches. Git history is now its only archive.
- Duplicate root `.codex-plugin/marketplace.json`.
- Unused `plugins/codex-paper/.codex-plugin/original-plugin.json`.

Before deletion, all 40 tracked legacy paths were compared with the active tree. The legacy tree had no unique tracked implementation path; the active tree was a strict superset and had already diverged in skills, scripts, schemas, tests, and Web APIs.

### Active plugin ingestion

- `plugins/codex-paper/.codex-plugin/plugin.json`
  - Removed the unsupported top-level `hooks` field. The existing hooks directory remains discoverable through default component discovery.
  - Reduced `interface.defaultPrompt` to the three core workflows: deep study, quick summary, and grounded follow-up Q&A.
  - Applied the default UTC cachebuster while preserving base version `2.0.0`.
- `plugins/codex-paper/skills/chat/agents/openai.yaml`
  - Replaced the invalid `version/interfaces` shape with the supported top-level `interface` shape.
- Node package and lockfile versions remain `2.0.0`; only the plugin manifest carries the cachebuster suffix.

### Contract baseline

Added:

- `docs/adr/0001-active-tree-and-contract-baseline.md`
- `docs/contracts/s0-contract-baseline.json`
- `docs/S0_IMPLEMENTATION_PLAN.md`

The baseline freezes:

- The exact SHA-256 of the three existing 2.0 JSON Schemas.
- Compatible package evolution from writer 2.0 to 2.1 without read-time rewrite.
- Continued v1 static browsing and limited `--legacy-ok` validation.
- Future `resultClaims` plus a `keyResults` projection retained until 3.0.
- Reader support for both legacy `claim:n`/`result:n` references and future direct `ev-*` references.
- Evidence and reasoning authority boundaries.
- The future Validation Report 1.0 interface without implementing it in S0.
- A licensed fixture policy that explicitly excludes the local Attention sample artifacts from redistribution.

The complete baseline file is itself SHA-256 pinned by the Repository Guard, in addition to the three individual schema hashes.

### Repository Guard and CI

Added `scripts/check-repository.mjs` and exposed it through:

```bash
bash scripts/codex-paper.sh repo-check
```

The guard verifies:

- The root command's effective `ACTIVE_PLUGIN_RELATIVE` is exactly `plugins/codex-paper`.
- The tracked tree contains exactly one plugin manifest, including checks for both root-level and nested second manifests.
- The top-level legacy tree is absent from the effective worktree and tracked path set.
- Dangling symlinks cannot hide legacy paths or generated artifacts; critical sentinels, marketplace, baseline, schemas, and fixture files cannot be symlinks.
- The canonical marketplace has exactly one local `codex-paper` entry pointing to `./plugins/codex-paper`.
- Folder, manifest, package, and lockfile names agree; the cachebuster-free manifest version matches the package and lockfile versions.
- Executable/config paths and both READMEs do not point to the legacy tree.
- Tracked generated artifacts are rejected, including dependency, Nuxt, output, VitePress, dist, Python cache, OS metadata, log, PID, and installation-marker files.
- The immutable baseline and three frozen schema hashes match.
- Tracked PDFs exist only below `benchmarks/fixtures/pdf/` and have a tracked `<pdf-path>.manifest.json` sidecar with strongly typed identity, origin, copyright, SPDX/license, redistribution, SHA-256, and generator fields.

CI changes:

- Added the Repository Contract step after Node setup and before Python/dependency installation.
- Removed the merged `feat/evidence-reasoning-v2` push trigger; CI now runs for `main` pushes and pull requests.
- Root `test` now runs Repository Guard tests followed by existing study unit tests.
- No root workspace, lint/typecheck framework, or third-party guard dependency was introduced.

## Review-driven hardening

The independent review initially found several bypasses. All were fixed and converted into regression tests:

1. Root automation could point at another plugin tree while the guard checked only the canonical manifest.
2. A second root or nested plugin manifest could recreate the two-tree problem.
3. A tracked dangling symlink could bypass `existsSync`-based path checks.
4. A PDF outside the fixture allowlist could be force-added.
5. A fixture could omit its sidecar, use a wrong hash, symlink critical files, or provide `null`/incorrectly typed licensing fields.
6. Ordinary README prose could still reference the legacy path.
7. A broad `logs/` directory rule could reject legitimate source directories; it was narrowed to actual log-file suffixes while adding missing generated paths from the active Web ignore policy.

The final independent review reported no remaining blocking findings.

## External review conclusion triage

`docs/S0-1_CODE_REVIEW_CONCLUSION.md` approved the implementation and raised five non-blocking observations. They were handled as follows:

- **Accepted and implemented:** CLI parsing now rejects missing values, option-as-value input, duplicate options, and unknown options instead of allowing one flag to consume the next. A CLI regression test covers all four cases.
- **Clarified, with no plugin code change:** the viewer remains a supported `$paper-webui` skill; only its composer starter prompt was removed to keep the UI limit at three core prompts.
- **Clarified verification boundary:** the installed canonical plugin path contains `hooks/hooks.json`, `hooks/check-install.sh`, and all four skills, and official plugin validation passes. Actual hook activation in a newly created Codex task remains a manual post-install check; this document does not claim that the current task independently observed a new task's hook execution.
- **No change:** limiting automatic legacy-reference scanning to executable/config files plus the two public READMEs is intentional. Historical ADR, audit, migration, and review documents may need to mention the removed path accurately.
- **No change:** the fixture branch is intentionally preventive and remains fully exercised through synthetic temporary-repository tests until P0-B1 adds a redistributable fixture.

### Round 2 triage

`docs/S0-1_CODE_REVIEW_ROUND2.md` also approved the implementation and confirmed the round-1 fixes. Its new observations were handled as follows:

- **Accepted and implemented:** generated dependency lockfiles are excluded from legacy prose scanning. Active executable/config files remain covered, while future transitive dependency paths containing `plugin/` cannot create a misleading lockfile failure. A regression test proves the lockfile is ignored and an ordinary JSON config still fails.
- **Accepted and implemented:** `interface.defaultPrompt` must contain exactly three prompts. This is both the current plugin ingestion limit and the explicit S0 product decision; a fourth prompt now fails the Repository Guard.
- **Documented, no code change:** the guard intentionally validates the effective worktree so the requested unstaged deletion set can be checked. A clean clone becomes equivalent only after the deletions and new guard files are committed together.
- **Documented delivery constraint:** the guard script, tests, baseline, ADR, CI wiring, and legacy deletions must be staged atomically. During code review they remained intentionally unstaged; the accepted delivery step must include them in one commit.

## Verification evidence

| Check | Result |
|---|---|
| Repository Guard tests | 31/31 passed |
| Existing study unit tests | 23/23 passed |
| Reasoning benchmark | 12/12 passed |
| Package benchmark | 10/10 passed |
| Parser benchmark | 5/5 passed |
| Production Web build | Passed |
| End-to-end smoke test | Passed |
| Official plugin validation before cachebuster | Passed |
| Official plugin validation after cachebuster | Passed |
| Plugin reinstall | Passed |
| Installed path/version check | Canonical path; `2.0.0+codex.20260710083739` |
| `git diff --check` | Passed |
| Independent review | Passed; no blocking findings |

Primary reproduction commands:

```bash
bash scripts/codex-paper.sh repo-check
bash scripts/codex-paper.sh test
bash scripts/codex-paper.sh reasoning-test
bash scripts/codex-paper.sh package-test
bash scripts/codex-paper.sh benchmark
bash scripts/codex-paper.sh build
bash scripts/codex-paper.sh smoke-test
python3 /Users/bianyuxin/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/codex-paper
codex plugin list
```

## Suggested review order

1. Read the ADR and machine baseline to confirm the decision boundary and deferred work.
2. Review `scripts/check-repository.mjs` together with `scripts/tests/check-repository.test.mjs`; the tests document the intended adversarial behavior.
3. Review the plugin manifest and chat agent YAML against the current plugin validator.
4. Review root command/CI wiring and `.gitignore` fixture allowlist behavior.
5. Confirm the legacy tree has no active-only implementation before accepting the bulk deletion.
6. Check README/CHANGELOG/audit tracker changes for migration guidance and status accuracy.

## Reviewer checklist

- [ ] Only `plugins/codex-paper/.codex-plugin/plugin.json` remains installable.
- [ ] `.agents/plugins/marketplace.json` remains unchanged and points to the active tree.
- [ ] Plugin base version remains aligned with both package manifests.
- [ ] Hook files are packaged and validator-compatible; verify actual hook activation in a newly created Codex task.
- [ ] Frozen schemas were not edited and their hashes match the baseline.
- [ ] Contract text does not imply that typed results or three-state validation are already implemented.
- [ ] Repository Guard failures identify the offending path and fail CI before dependency installation.
- [ ] Fixture enforcement matches the ADR and cannot ingest the local Attention sample.
- [ ] No unrelated pre-existing untracked files are included in the S0 review/commit.
- [ ] CI wiring, guard script/tests, contract docs, and legacy deletions are staged in the same change.
- [ ] No stage, commit, or push is assumed by this document.

## Known non-blocking considerations

- Web dependency installation continues to report the 34 audit findings already recorded in `docs/v2-baseline.md`. Dependency upgrades are outside S0.
- The local Attention audit sample is `/Users/bianyuxin/codex-papers/papers/attention-is-all-you-need`; none of its PDF, images, tables, or long excerpts were copied into the repository.
- During code review the change set was intentionally unstaged. Before the deletions were staged, a raw `git ls-files plugin` read the old Git index and still listed paths deleted from the working tree; the filesystem check and Repository Guard confirmed the intended effective tree. Delivery must stage the deletions and the guard/CI additions atomically.
- The plugin was reinstalled from the existing local marketplace. A new Codex task is required to verify fresh skill and hook discovery.

## Scope isolation

The following pre-existing untracked work was preserved and is not part of S0-1 unless separately selected by the reviewer:

- `docs/P0_IMPLEMENTATION.md`
- `docs/P1_IMPLEMENTATION_PLAN.md`
- `docs/SKILL_OPTIMIZATION_HANDOFF.md`
- `docs/STUDY_REWORK_IMPLEMENTATION_SUMMARY.md`
- `docs/v2-code-review-findings*.md`
- `docs/v2-code-review-summary.md`
- `docs/codex-paper-audit-2026-07-10_origin.md`
- `plugins/codex-paper/src/web/components/PaperAnalysisHero.vue`

The active audit file `docs/codex-paper-audit-2026-07-10.md` is in scope because it records S0-1 progress, evidence, and delivery status.

## Rollback

Revert the complete S0-1 change set. If the removed legacy implementation must be inspected, restore it from Git history into a temporary, non-installable location. Do not restore it as a second manifest-bearing plugin tree.
