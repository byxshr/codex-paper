# S0-1 Code Review Conclusion

## Review metadata

- Reviewer: independent code review (Claude)
- Work item: `S0-1` — single active tree and contract baseline
- Branch: `codex/audit-optimizations-2026-07-10`
- Date: 2026-07-10
- Source summary reviewed: `docs/S0-1_CODE_REVIEW_SUMMARY.md`
- Verdict: **Approve** — no blocking findings. A small set of non-blocking observations is listed below.

## Scope of this review

Reviewed the S0-1 change set that removes the second executable plugin tree, freezes the 2.0 contract baseline, repairs plugin ingestion metadata, and adds a dependency-free repository contract gate wired into CI. Focus was on the guard logic, its tests, the frozen-hash integrity, manifest/agent metadata correctness, and documentation accuracy.

Files inspected in depth:

- `scripts/check-repository.mjs`
- `scripts/tests/check-repository.test.mjs`
- `docs/contracts/s0-contract-baseline.json`
- `docs/adr/0001-active-tree-and-contract-baseline.md`
- `plugins/codex-paper/.codex-plugin/plugin.json`
- `plugins/codex-paper/skills/chat/agents/openai.yaml`
- `scripts/codex-paper.sh`, `scripts/common.sh`
- `.github/workflows/ci.yml`, `.gitignore`
- `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, `docs/v2-baseline.md`

## Independent verification

All checks were re-run locally rather than trusted from the summary:

| Check | Command | Result |
|---|---|---|
| Repository contract gate | `bash scripts/codex-paper.sh repo-check` | Passed — 115 tracked files inspected, exit 0 |
| Guard regression tests | `node --test scripts/tests/*.test.mjs` | 28/28 passed |
| Baseline hash pin | `shasum -a 256 docs/contracts/s0-contract-baseline.json` | Matches `85bb06ac…889a142` embedded in guard |
| Frozen schema hashes (×3) | `shasum -a 256 …schemas/*.schema.json` | All three match baseline + guard constants |
| Marketplace canonicalization | manual read of `.agents/plugins/marketplace.json` | Exactly one `codex-paper` local entry → `./plugins/codex-paper` |
| Agent interface shape | compared all four `agents/openai.yaml` | `chat` now matches `study`/`summary`/`webui` `interface` shape |

The self-referential integrity is sound: the baseline file's own SHA is pinned as a constant in the guard, and the guard independently re-hashes each of the three frozen schemas and cross-checks them against both its own constants and the baseline's declared values. Editing any frozen schema or the baseline fails the gate (confirmed by tests 27 and 28).

## Strengths

- **Adversarial test coverage is genuine, not decorative.** Tests exercise the actual bypass vectors: `git add -f` on an ignored artifact, a dangling symlink masquerading as the legacy tree, a second root-level or nested manifest, a duplicate/mis-sourced marketplace entry, a PDF outside the allowlist, and null/mistyped fixture license fields. Several use a real `git init` fixture rather than a mocked file list, so `git ls-files` behavior is validated end-to-end.
- **The legacy-path regex avoids the obvious false positives.** `(^|[^A-Za-z0-9_-])plugin/` deliberately excludes `-` and `s` from the boundary, so `.codex-plugin/` and `plugins/codex-paper/` do not trip the check. This is subtle and correct.
- **Gate runs before dependency install in CI**, so contract violations fail fast without paying npm/pip cost — matching the stated design intent.
- **Documentation is honest about deferred scope.** The ADR and summary both explicitly disclaim that typed `resultClaims` and three-state validation are *not* implemented in S0, which prevents downstream reviewers from assuming behavior that does not exist.
- **`v2-baseline.md` was annotated rather than rewritten**, preserving the historical record with a dated pointer to the commit it described.

## Non-blocking observations

1. **`webui` default prompt removed while the `webui` skill remains.** `plugin.json` dropped "Launch the Codex Paper web viewer…" from `interface.defaultPrompt`, but `skills/webui/` and its `agents/openai.yaml` still ship. This is a reasonable product decision (narrow the surfaced prompts to three core workflows), but the summary frames it only as a metadata repair. Confirm the web viewer is still intended to be discoverable/usable — it is, via the skill; only the suggested prompt was pruned. No action required unless the intent was to deprecate the viewer.

2. **`hooks` manifest field removed in favor of default discovery.** `plugin.json` no longer declares `"hooks": "./hooks/hooks.json"`, relying on default component discovery of `hooks/`. `hooks/hooks.json` and `check-install.sh` still exist and are correctly formed. The summary claims validator passes both before and after; I did not re-run the external `validate_plugin.py` (outside repo). This is the one behavioral claim I could not independently reproduce — the reviewer checklist item "hooks remain discoverable" should be confirmed against a fresh install, as the summary itself notes a new Codex task is required for fresh skill/hook discovery.

3. **Config-file legacy scan does not cover `.md` docs.** `isExecutableOrConfig` intentionally excludes `.md` (READMEs are handled by a dedicated check). Other tracked docs (`SKILL.md`, files under `docs/`) could still contain a stale `plugin/` reference without failing the gate. This is a deliberate, acceptable scoping choice, not a defect — flagged only so future readers understand the boundary.

4. **`parseOption` consumes the next token unconditionally.** In `check-repository.mjs`, `--active-plugin-relative` followed by another flag would swallow that flag as its value. Harmless given the single-flag CLI surface and CI usage, but worth a guard if the CLI grows.

5. **Fixture allowlist is currently forward-looking.** No PDFs are tracked yet (`benchmarks/fixtures/pdf/` is empty), so the entire fixture-manifest branch of the guard is exercised only by synthetic test fixtures, not by real repository content. Coverage is adequate via tests; just note the policy is preventive rather than currently load-bearing.

## Checklist assessment

| Reviewer checklist item (from summary) | Status |
|---|---|
| Only canonical `plugin.json` remains installable | Confirmed — guard test rejects second/nested/root manifests |
| Marketplace unchanged, points to active tree | Confirmed |
| Plugin base version aligned with both package manifests | Confirmed — `2.0.0` base, cachebuster only on manifest |
| Hooks remain discoverable after field removal | **Not independently reproduced** — see observation 2 |
| Frozen schemas unedited, hashes match baseline | Confirmed via re-hash |
| Contract text does not imply unimplemented behavior | Confirmed — ADR is explicit about deferral |
| Guard fails CI before dependency install, names offending path | Confirmed — step ordering + error messages include path |
| Fixture enforcement cannot ingest local Attention sample | Confirmed — allowlist + origin + redistributable gate |
| No unrelated untracked files in scope | Confirmed — scope isolation section lists preserved P0/P1 docs |

## Recommendation

Approve for staging and merge. Before or immediately after merge, close the single open verification gap by confirming hook/skill discovery on a fresh (non-reinstall) plugin install, per observation 2 and the summary's own note. All other findings are informational and require no code change.
