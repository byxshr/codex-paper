# P0-A3 Code Review Findings

**Reviewer:** Claude (Opus 4.8)
**Date:** 2026-07-13
**Branch:** `codex/audit-optimizations-2026-07-10`
**Scope:** Generated-code sandbox introduced by P0-A3, per `docs/P0-A3_CODE_REVIEW_SUMMARY.md`.

## Verdict

The implementation is **strong and largely meets its stated security invariants.** The static-only validator, fail-closed capability gating, single-use approval tokens, argv-only Docker execution, and atomic no-follow report publication are all implemented correctly and well tested (13/13 sandbox tests pass locally against a fake-docker fixture). No shell interpolation, host interpreter fallback, or approval-replay path was found.

The findings below are ranked by severity. There are **no confirmed remote-exploitable defects**; the highest-severity item is a design/trust-boundary observation about how "explicit user approval" is enforced.

---

## Findings

### 1. [Design] "Explicit user approval" is prose-enforced, not code-enforced — the agent can self-consume the token

**Severity:** Medium (defense-in-depth / process integrity)
**Files:** `sandbox-code.js:326-352`, `sandbox-code.js:750-751`, `SKILL.md:509-514`

The approval token is minted inside `buildExecutionPlan` at **`sandbox-plan`** time (`issueApproval: true` default) and printed to stdout (`Approval token: ${plan.approval.token}`). `sandbox-run` then consumes any 64-hex token from the approval directory. There is **no interactive confirmation** anywhere in the run path (`grep` for `readline|prompt|stdin|isTTY` → none).

The invariant "the token is single-use and bound to code" is real, but the invariant "a human explicitly approved this exact plan" is enforced **only by the SKILL.md instruction** telling the agent to stop and ask. A misbehaving or prompt-injected agent that runs `sandbox-plan` receives the token in the same tool output and can immediately pipe it into `sandbox-run` with zero human in the loop. The token binding prevents *tampering* between plan and run; it does not prevent *unauthorized self-approval*.

This is arguably acceptable given the container is the real security boundary (offline, non-root, cap-free, read-only), so self-execution of already-approved-shape code is bounded. But it is worth stating explicitly: **the consent gate is a policy convention, not a technical control.** If the threat model includes "the agent should not run code the user didn't ask for," consider having `sandbox-plan` write the token only to the private approval file (not stdout) and requiring `sandbox-run` to read an out-of-band confirmation (e.g., a user-typed nonce), so the token cannot round-trip within a single agent turn.

**Recommendation:** Either (a) accept and document this as intended (container is the boundary; approval is UX friction), or (b) add a technical consent control if self-execution is in scope. At minimum, the summary's invariant #3 should not be read as implying human consent is enforced in code.

---

### 2. [Robustness] Approval directory is not garbage-collected; expired tokens accumulate

**Severity:** Low
**File:** `sandbox-code.js:302-324, 354-377`

`createApproval` writes `${token}.json` per plan. Expiry is checked lazily in `claimApproval` (`sandbox-code.js:375`), and files are only removed when *claimed* (renamed to `.claimed` then `rmSync`). A plan that is never run leaves its approval file behind forever. Over many `sandbox-plan` invocations the approval dir (`$TMPDIR/codex-paper-sandbox-<uid>/approvals`) grows unbounded with stale, still-parseable (but expired) token files.

No security impact — expired tokens are rejected — but it is an unbounded-growth / hygiene issue in a world-adjacent tmp location. Consider sweeping expired `*.json` in `createApproval`/`claimApproval`, or noting the dir is disposable.

---

### 3. [Trust boundary] `resourceUsage` is attacker-controlled data copied out of the container and embedded verbatim in the report

**Severity:** Low (informational-only, no injection sink found)
**Files:** `entrypoint.py:34-45`, `sandbox-code.js:470-480, 503`

`/tmp/codex-paper-resource.json` is written by `entrypoint.py` inside the container, but `/tmp` is a writable tmpfs that the **untrusted artifact can also write to**. The artifact can overwrite/replace `/tmp/codex-paper-resource.json` with arbitrary JSON before exit. The runner `docker cp`s that file and `JSON.parse`s it into `report.artifacts[].resourceUsage` with no schema validation, then serializes it into the execution report.

This is currently safe because the report is a JSON file rendered as source (the Viewer does not execute it), and a parse failure falls back to `null`. But the field should be understood as **untrusted container output, not a trusted measurement**. If any downstream consumer ever treats `resourceUsage` as authoritative (e.g., billing, limits, display-as-fact), it becomes a spoofing vector. Recommend: validate the shape/types on read, or label the field as self-reported.

Note the entrypoint itself runs as a separate PID from the artifact and `getrusage(RUSAGE_CHILDREN)` is accurate; the weakness is only that the *file* is co-located in writable `/tmp` and could be clobbered.

---

### 4. [Minor] `spawnCaptured` byte accounting can push a slightly-oversized chunk before `onLimit` fires

**Severity:** Informational
**File:** `sandbox-code.js:410-421`

`capture` pushes up to `remaining` bytes, then increments the counter, then checks `current + chunk.length > limit`. The truncation math is correct (never stores more than `limit` bytes; `stdoutTruncated` correctly reflects overflow). `onLimit` (which kills the container) fires on the first chunk that crosses the limit — correct. No defect; just noting the ordering is subtle and the tests cover it (`output_limit` case passes). No change needed.

---

## Verified invariants (spot-checked, no defects found)

- **Static validator cannot spawn:** `--run-code`/`--run-artifacts` throw and exit `2` before any FS/exec (`validate-study-package.js:95-97`); `check-repository.mjs:311` bans `child_process` import in the validator. Test confirms no execution marker is written.
- **No shell / no host fallback:** `dockerCreateArgs` and `spawnCaptured` pass argv arrays; `check-repository.mjs:323` rejects `shell:true` or `exec*` imports in the runner. Argv test asserts no `sh`/`-c`.
- **Fail-closed capability:** missing Docker → `unavailable`, exit `3`, no token (`getSandboxCapability:206-210`, CLI test). Stale image/policy hash → `nonconformant` (test passes).
- **Token binding:** `planBinding` hashes code tree + limits + policyHash + imageId; run rebuilds the plan and rejects on mismatch (`sandbox-code.js:581`). Tests cover code-change, different-paper, expiry, and concurrent double-use (exactly one succeeds via atomic `renameSync` claim).
- **Path safety:** `resolvePaperDir`/`scanCodeTree` reject symlinks, NUL, out-of-tree `code/`, and mount-hostile chars (`:,\r\n`); `snapshotApprovedCode` re-verifies size+sha under `O_NOFOLLOW` before mounting a read-only copy (not the original) — so TOCTOU between scan and run is closed by executing the snapshot, and the mount test confirms the paper path never reaches Docker.
- **Report publication:** `prepareReport` creates `O_EXCL|O_NOFOLLOW` temp, `commitReport` fsyncs then atomic-renames; symlinked `execution-reports` is rejected (test). Reports exclude approval/host credentials.
- **Container hardening:** `--network none`, `--ipc none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, memory==memory-swap, cpu/fsize/nofile/nproc ulimits, `--tmpfs /tmp:noexec,nosuid,nodev`, `--user 65532:65532`, forced `rm --force` with fail-closed on cleanup failure.
- **Conformance depth:** `runConformance` exercises env-scrubbing (with a `CODEX_PAPER_SECRET_CANARY` that must not leak in), no-network, read-only workspace/etc, and positively verifies output-limit, wall-timeout, file-size, PID, and memory limits actually trip before stamping.

## CI conformance gate

The reviewer focus "can CI skip or falsely pass real conformance" checks out: `.github/workflows/ci.yml:37-41` runs `sandbox-setup` → `sandbox-test` → `sandbox-status` unconditionally on `ubuntu-latest` with no `continue-on-error` and no platform skip. `setup`/`test` build a real image and run `runConformance`, which throws (exit `3`) on any missed limit, failing the job. The stamp is keyed to `{conformanceVersion, policyHash, imageId, docker version, platform}`, so a stamp from a different engine/image/policy will not satisfy `getSandboxCapability`. **CI cannot falsely pass without a real Docker run.** The local Mac has no Docker, so real-container conformance is correctly deferred to this gate — the summary's instruction not to mark the work complete until CI green is sound.

## Recommendation

Merge-ready from a security standpoint **pending the real-Docker CI conformance gate going green.** Finding #1 (consent is prose-enforced) should be an explicit, acknowledged design decision before sign-off; findings #2–#4 are non-blocking polish.
