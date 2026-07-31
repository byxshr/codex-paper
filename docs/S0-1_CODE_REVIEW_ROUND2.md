# S0-1 Code Review — Round 2

## Review metadata

- Reviewer: independent code review (Claude), second round
- Work item: `S0-1` — single active tree and contract baseline
- Branch: `codex/audit-optimizations-2026-07-10`
- Date: 2026-07-11
- Sources reviewed: `docs/S0-1_CODE_REVIEW_SUMMARY.md`, `docs/S0-1_CODE_REVIEW_CONCLUSION.md`
- Verdict: **Approve** — no blocking findings. Round-1 fixes confirmed; a small set of new non-blocking observations follows.

## Scope of this round

This round verifies that the round-1 conclusion's recommendations were correctly implemented and that no regression was introduced, then looks for anything the first round did not surface. Files re-inspected:

- `scripts/check-repository.mjs` (CLI parser changes)
- `scripts/tests/check-repository.test.mjs`
- `scripts/codex-paper.sh`, `scripts/common.sh`
- `.github/workflows/ci.yml`, `.gitignore`
- `plugins/codex-paper/.codex-plugin/plugin.json`
- `plugins/codex-paper/skills/*/agents/openai.yaml` (all four)
- `docs/contracts/s0-contract-baseline.json`

## Verification of round-1 fixes

All checks were re-run locally rather than trusted from the summary.

| Round-1 item | Status this round | Evidence |
|---|---|---|
| Obs 4 — CLI consumed next token unconditionally | **Fixed** | `parseCliArgs` (lines 327–353) now rejects missing values, option-as-value, duplicate options, and unknown options. Manually reproduced all four rejections. |
| CLI regression test added | **Confirmed** | `check-repository.test.mjs` test at line 66 spawns the real CLI and asserts non-zero exit for each malformed invocation. |
| Guard regression suite | **28 → 29 passing** | `node --test scripts/tests/*.test.mjs` → `29 pass, 0 fail`. The added test is the CLI case. |
| Repository contract gate | **Passing** | `node scripts/check-repository.mjs` → `passed (115 tracked files inspected)`, exit 0. |
| Obs 1 — `webui` prompt pruned, skill retained | **Confirmed as intended** | `defaultPrompt` holds exactly the three core workflows; `skills/webui/` and its `agents/openai.yaml` still ship. |
| Agent interface shape repair | **Confirmed** | All four `agents/openai.yaml` now use the top-level `interface:` shape; the old `version/interfaces` shape is gone. |
| CI step ordering | **Confirmed** | `Repository Contract` runs after Node setup (line 23) and before `Set up Python`/`Install dependencies` (lines 26, 31), so violations fail before dependency cost. |
| Guard tests also run under `test` | **Confirmed** | `cmd_test` prints a `Repository Guard Tests` section and runs `scripts/tests/*.test.mjs` before the study unit tests. |
| Frozen schema + baseline hashes | **Confirmed** | Guard re-hashes all three schemas and the baseline; tests 27–29 fail the gate on any edit. |

The round-1 fixes are complete and correct. The `parseCliArgs` value-boundary check (`value.startsWith('--')`) also correctly rejects a value that itself begins with `--`, and the `--opt=value` form is reported as an unknown option — both acceptable for a two-flag internal CLI.

## New non-blocking observations

1. **Legacy-reference regex scans `package-lock.json` and other `.json` config files.** `isExecutableOrConfig` treats `.json` as config, so `plugins/codex-paper/package-lock.json` is read and matched against `(^|[^A-Za-z0-9_-])plugin/`. Today there are zero matches, but a future transitive dependency whose name or resolved path contains `plugin/` (e.g. a `.../node_modules/some-plugin/...` path string, or a package literally named `plugin`) would trip a false positive and fail CI. Low probability, but the failure would be confusing because it points at a lockfile the author did not write. Consider excluding lockfiles from the prose scan, or tightening the pattern to word-boundary the segment `plugin` rather than any `plugin/` substring.

2. **`defaultPrompt` count is a documented invariant but is not guard-enforced.** The ADR/summary state the surfaced prompts are intentionally limited to three core workflows, yet nothing in `check-repository.mjs` asserts the count. A later manifest edit could silently reintroduce a fourth prompt (including the removed `webui` starter) without failing the gate. If the three-prompt limit is a real contract, add a one-line assertion; if it is only a product preference, note it as non-load-bearing so future readers do not assume enforcement.

3. **The guard validates the worktree, not the git index.** `gitTrackedFiles` filters tracked paths through `lexicallyExists`, so an *unstaged* deletion of the legacy tree passes even though `git ls-files` still reports the old paths from the index. The summary acknowledges this deliberately (to allow validating before staging), and it is the right call — flagged only so a future reader understands the gate green-lights a state that a fresh `git clone` would not reproduce until the deletions are committed. The corresponding risk is the inverse: staging must actually include the deletions and the new `scripts/check-repository.mjs` + test file before merge, or CI will fail on a clean checkout because the guard script is absent.

4. **New files are still untracked.** `scripts/check-repository.mjs`, `scripts/tests/check-repository.test.mjs`, `docs/contracts/`, `docs/adr/`, and the two review docs are untracked (`??`). This is expected given the summary's "intentionally unstaged" note, but it is a real merge-time hazard: the CI `Repository Contract` step invokes the guard script, so the commit that wires CI must land the script in the same change or CI breaks on the first clean run. No code change; a staging checklist item.

## Checklist re-assessment

| Item | Round 1 | Round 2 |
|---|---|---|
| CLI value parsing hardened | Recommended | **Done + tested** |
| Guard tests pass | 28/28 | **29/29** |
| Repository contract passes | 115 files | **115 files** |
| Agent interface shapes uniform | Confirmed | **Confirmed (all 4)** |
| CI gate before dependency install | Confirmed | **Confirmed** |
| Hooks discovery on fresh install | Not reproduced | **Still not reproduced** — remains the single open verification gap; requires a fresh (non-reinstall) Codex install. Unchanged from round 1 observation 2. |

## Recommendation

Approve for staging and merge. The round-1 code recommendation (CLI hardening) is implemented and covered by a regression test; all other round-1 findings were correctly triaged. The new observations are informational and require no code change before merge, with two caveats to carry into the merge step:

1. Stage the guard script and its test alongside the CI change, or CI will fail on a clean checkout (observations 3–4).
2. Close the one still-open verification gap by confirming hook/skill discovery on a fresh plugin install (carried over from round 1).
