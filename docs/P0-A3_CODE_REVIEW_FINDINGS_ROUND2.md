# P0-A3 Code Review Findings — Round 2

**Reviewer:** Claude (Opus 4.8)
**Date:** 2026-07-13
**Branch:** `codex/audit-optimizations-2026-07-10`
**Scope:** Re-review after fixes to the four round-1 findings (`docs/P0-A3_CODE_REVIEW_FINDINGS.md`), per the updated `docs/P0-A3_CODE_REVIEW_SUMMARY.md`.

## Verdict

**All four round-1 findings are resolved.** The fixes are correct, minimal, and — notably — each behavioral fix is now locked in by an automated test, and the consent-boundary decision is now enforced as a repository contract rather than left as prose. Test counts increased accordingly: sandbox suite **13 → 15**, repository guard **31 → 36**, both green locally. `repo-check` passes. **No regressions and no new defects found.**

Round-2 status is **merge-ready pending the real-Docker CI conformance gate** (unchanged from round 1 — this Mac still has no container engine, so real-container conformance remains correctly deferred to CI).

---

## Round-1 findings — resolution review

### 1. Consent is prose-enforced, not code-enforced → **Accepted & hardened (correct)**

The team accepted this as an intended design decision (container is the security boundary; consent is a workflow gate) and hardened it in three complementary ways:

- **Machine-readable declaration** — `buildExecutionPlan` now emits a `consent` object (`sandbox-code.js:368-372`): `{ enforcement: 'workflow', humanIdentityAuthenticated: false, requirement: '...' }`. This makes the trust boundary explicit in the plan JSON that a caller inspects.
- **Human-facing disclosure** — `printPlan` prints `Consent: workflow-enforced; the token binds this plan but does not authenticate a human` (`sandbox-code.js:796`), and `SKILL.md:516` now states plainly: *"the CLI token … does not authenticate a human … Never issue and consume a token in one uninterrupted turn."*
- **Contract enforcement (the strong part)** — `check-repository.mjs:319-324` now **fails the build** if `SKILL.md` loses either the phrase `does not authenticate a human` or `Never issue and consume a token in one uninterrupted turn`. A regression that silently drops the consent instruction is now caught by CI (test at `check-repository.test.mjs:281-285`).

This is the right resolution. The residual reality is unchanged and honestly documented: an agent *can* still round-trip a token within one turn because the CLI cannot authenticate a human. Invariant #3 in the summary now correctly says the token "proves plan integrity, not human identity." **No further action required.**

### 2. Approval directory not garbage-collected → **Fixed (correct)**

`sweepExpiredApprovals` (`sandbox-code.js:329-345`) is invoked inside `createApproval` (`:308`), after `assertSafeDirectory`. It iterates `${64-hex}.json` files, and for each safe, own-uid, 0600, non-symlink file whose parsed `expiresAt` is missing/unparseable/past, unlinks it. Concurrent-claim races and unsafe entries are swallowed by try/catch and left untouched — correct (a file being claimed elsewhere must not be forcibly removed). Test `creating a plan removes expired private approval files` (`generated-code-sandbox.test.mjs:126-141`) confirms an expired file is swept while the fresh one survives.

Minor note (non-blocking): the sweep does a full read+`JSON.parse` of every pending token file on each `sandbox-plan`, so cost is O(pending approvals). These are the tool's own 0600 files bounded by real usage; acceptable. If ever a concern, the `size <= N` pre-check pattern used for resource files could be applied here too.

### 3. `resourceUsage` trust ambiguity → **Fixed (correct, and well-scoped)**

Three layers now defend the field:

- **Size bound before read** — `runArtifactDocker` lstat-checks the copied file is a real non-symlink ≤ 4096 bytes before parsing (`sandbox-code.js:520-523`), bounding parse cost and rejecting a clobbered oversized file.
- **Schema/type/consistency validation** — `normalizeResourceUsage` (`:426-442`) rejects non-objects/arrays, non-finite or negative numerics, out-of-range `status`, and — importantly — a `status` that (after signal normalization) does not match the container's real `state.ExitCode`. It returns a **whitelisted** object, so injected extra keys are dropped.
- **Explicit labeling** — accepted measurements carry `measurementSource: 'container-wrapper'` and `authoritative: false`, so no downstream consumer can mistake attacker-influenced numbers for a trusted measurement.

Test `runner rejects malformed or exit-mismatched resource measurements` (`:249-263`) covers both a spoofed non-numeric field (with an injected extra key) and an exit-code mismatch; both correctly yield `resourceUsage: null`. This closes the round-1 concern precisely — the artifact can still write timing/RSS numbers into `/tmp`, but they are now bounded, validated, and labeled non-authoritative.

### 4. `spawnCaptured` byte accounting → **No change (correct call)**

Confirmed unchanged (`sandbox-code.js:454-465`): storage stays bounded to `limit` bytes, `stdoutTruncated`/`stderrTruncated` reflect overflow, and `onLimit` fires on the first crossing chunk. This was informational in round 1; leaving it as-is is right.

---

## New-code regression check

I re-audited the diffs for defects introduced by the fixes:

- `unlinkSync` is properly imported (`sandbox-code.js:21`) and used only in the sweep — no accidental use elsewhere.
- The `consent` object is added to the plan **before** `createApproval` runs and is included in `planBinding`'s hashed shape? — No: `planBinding` (`:289-301`) hashes `paperDir, codeDir, files, artifacts, limits, policyVersion, policyHash, imageId` only. `consent` and `boundary` are **not** in the binding. This is correct and intentional: they are constant descriptors, not attack surface, and excluding them keeps the plan/run binding stable. Verified the run-side rebuild still matches (all binding tests green).
- New repo-guard checks are guarded by `existsSync` and only add `errors` (never throw), so they degrade safely on partial trees.
- The consent-text guard uses exact-substring `includes()`. Brittle to rewording — but that brittleness *is* the contract (any reword must consciously update both the skill and the guard). Acceptable and intentional.
- Sandbox sentinels (`sandbox-code.js`, `Dockerfile`, `policy.json`) added to `SENTINELS` in both the runner and its test fixture list — keeps them from being silently deleted.

## CI conformance gate (re-confirmed)

Unchanged and still sound: `.github/workflows/ci.yml:37-41` runs `sandbox-setup → sandbox-test → sandbox-status` unconditionally on `ubuntu-latest`, no `continue-on-error`, no platform skip. `runConformance` positively exercises env-scrub (+ secret canary), no-network, read-only FS, and output/timeout/file/PID/memory limits, throwing exit `3` on any miss. The conformance stamp is keyed to `{conformanceVersion, policyHash, imageId, docker version, platform}`, so a foreign stamp cannot satisfy `getSandboxCapability`. **CI cannot falsely pass without a real container run.**

## Recommendation

Round-1 findings are fully addressed with correctness-locking tests and a new enforced consent contract. **Approve, pending the real-Docker CI conformance gate going green.** No blocking issues; the O(n) sweep read and substring-based consent guard are acknowledged, intentional trade-offs, not defects.
