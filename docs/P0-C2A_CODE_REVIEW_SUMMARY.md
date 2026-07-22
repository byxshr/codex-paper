# P0-C2a Code Review Handoff

## Review focus

P0-C2a changes the mutation authority boundary. Review should concentrate on:

1. No prepare/author/render/validate path creates or changes formal `paper.json`, `current.json`, or `index.json`.
2. Workspace creation is same-filesystem, private, atomic, exact-resume only, and preserves failed work.
3. Lock ordering and partial-acquisition rollback hold across processes; unsafe/corrupt/foreign/live-owner locks are never reclaimed.
4. Every managed file replacement requires lock ownership and an absent-or-SHA CAS precondition.
5. Published and legacy generation content cannot be authored, while overlay/trash/sandbox behaviors remain functional.
6. Mandatory fixtures execute prepare through complete validation inside workspaces and assert no early publication.

## Main files

- `plugins/codex-paper/src/shared/storage-transaction.mjs`
- `plugins/codex-paper/src/shared/generation-workspace.mjs`
- `plugins/codex-paper/src/shared/workspace-writer.mjs`
- `plugins/codex-paper/skills/study/scripts/prepare-paper.js`
- `plugins/codex-paper/skills/study/scripts/workspace-cli.js`
- `plugins/codex-paper/src/web/server/utils/operationLocks.mjs`
- `scripts/tests/storage-transaction.test.mjs`
- `benchmarks/mandatory/authoring-boundary.mjs`

## Deliberate exclusions

There is no publish command, generation manifest, sealing, current/index commit protocol, reindex, or recovery command in this change. `validated` is operational workspace state only. Those features belong to P0-C2b.

## First review disposition

The findings in `docs/P0-C2A_CODE_REVIEW_FINDINGS.md` were reproduced against the implementation. The following changes were accepted:

- Dead-owner reclamation now has a per-lock reclaim claim, re-reads the current owner before rename, and verifies the moved owner token before deletion. Concurrent reclaimers cannot remove a newly acquired live lock.
- Exceptional partial acquisition rolls back every acquired lock. Release attempts every lock in reverse order before reporting one or more ownership/corruption errors.
- The prepare guard now rejects the historical publication primitives (`writeJsonAtomicNoFollow`, `writeIndexPreserveShape`, and `fs.writeFileSync`) instead of relying only on names that never appeared in the old implementation. A missing mandatory authoring boundary is collected as a repository error rather than throwing during inspection.
- The workspace registry skips only a regular `.DS_Store`; all other unexpected entries remain fail-closed. Abandoned workspaces cannot be resumed, tagged, updated, or transitioned back to a writable state.
- Workspace states now follow an explicit transition table. Every specialized package writer declares a named output policy, and authoring/build/render/scaffold writes downgrade a previously validated workspace to `authoring`; the validation-report writer alone preserves the active validation state.
- Workspace record validation is shared by exact-path and ID resolution. Published generation paths are canonicalized correctly on platforms whose temporary-directory spelling differs from `realpath`.
- Sandbox plans accept explicit managed-generation paths and write reports to the generation-scoped overlay. Storage lock conflicts retain their code, retry metadata, and unavailable exit classification instead of being mislabeled as unsafe paths.
- Ask no longer holds a cross-process paper lock during the external Codex call; it acquires the lock only for the chat-note append.
- `atomicRemoveFile` now requires an exact SHA-256 precondition.

Two recommendations were deliberately not implemented in C2a:

- Ownerless or corrupt lock directories still fail closed and are never reclaimed automatically. Inferring ownership from age would contradict the approved stale-lock boundary. A guarded doctor/recovery command remains a C2b/P1-2 concern.
- Reconciliation publication semantics, lock doctor/recovery, broader helper deduplication, and sync-I/O performance work remain outside C2a. They must be resolved with the C2b publish/recovery protocol rather than guessed here.

## Second review disposition

The findings in `docs/P0-C2A_CODE_REVIEW_FINDINGS_ROUND2.md` were reproduced individually. All confirmed correctness findings were accepted, with one scope clarification: the workspace registry now ignores a bounded list of known operating-system metadata files, but it deliberately does not ignore arbitrary editor swap files because an unexpected regular file must not become a general registry bypass.

The resulting changes are:

- Workspace initialization failures now CAS-update an existing `workspace.json`, preserve populated packages as `failed`, retry the final rename when safe, and never age-delete an initialization residue that already contains a workspace record.
- Ask serializes Codex calls per paper in process and waits up to three seconds for the short chat-note append lock, without restoring the external-call-long cross-process lock.
- Reclaim claims have their own owner token and can recover a dead same-host reclaim owner. Initializing/revalidation races remain retryable, and a failed moved-owner verification is restored fail-closed instead of leaked or deleted.
- Sandbox report storage is selected by an explicit descriptor-mode policy. Unsupported explicit paths receive no approval; managed overlays are created through the shared locked storage boundary; generation report directories reuse the portable `gen-sha256-*` name.
- Legacy migration holds the same `legacy:<slug>` lock as Viewer lifecycle operations for the complete migration, and it preserves an existing reasoning review unless `--force` is explicit.
- Active non-abandoned workspaces participate in route allocation, and workspace creation rechecks the route reservation while holding the registry lock.
- Workspace record mutation now evaluates functional updates after lock acquisition. State downgrade is centralized, abandoned ID/path errors agree, `~` expansion uses `os.homedir()`, and write/remove CAS conflicts share `WRITE_PRECONDITION_FAILED`.
- Repository Guard now rejects named `writeFileSync` imports, formal record/index filename literals in prepare, migration lock drift, and removal of the existing-review guard.

The review's performance observations, broader descriptor/allowlist consolidation, lock doctor command, and publish/recovery semantics remain deliberately deferred to C2b or P1-3. They do not weaken the C2a workspace-only authority boundary.

## Third review disposition

The findings in `docs/P0-C2A_CODE_REVIEW_FINDINGS_ROUND3.md` were reproduced against the second-round implementation. Seven confirmed findings and three bounded plausible findings were accepted; the proposed stale-lock reclaim TOCTOU issue was rejected because the moved owner is revalidated under the reclaim claim and the alleged directory overwrite is not a valid transition in this implementation.

The accepted corrections are:

- A failed initialization remains discoverable even when both `.init-*` to final-workspace rename attempts fail. Exact ID/path resolution and workspace listing recognize only `.init-*` residues that contain a valid workspace record; incomplete recordless residues retain the bounded one-hour cleanup policy.
- `failed` is retained for diagnosis but is not active for generation or route reservation. Fresh prepare retries can create a new workspace, while active conflicts and initialization errors include the exact workspace ID and recovery guidance.
- Ask queues and threads are keyed by the shared paper lock, and thread reuse also checks the package path. A request-level MCP error, empty response, or timeout rejects only that request; actual worker process failure remains the only global rejection event.
- A three-second chat-note lock conflict no longer discards an already generated answer. The API returns `saved:false`, nullable note identifiers, and a bounded warning; the Viewer displays the answer and its unsaved state.
- Prepare and legacy migration now derive the default library root from `os.homedir()`. Migration also rejects nested in-library inputs, guaranteeing documented legacy packages use the same `legacy:<slug>` lock as Viewer lifecycle operations.
- Abandoned workspace paths resolve to read-only descriptors, so sandbox planning returns a structured `nonconformant` result without an approval token instead of throwing an inconsistent policy error.
- The unused `generationReadOnly` projections, unreachable `reconciled` preparation branch, and redundant reclaim catch branch were removed. Repository Guard now also catches asynchronous direct `writeFile(...)` use in prepare.

The review's helper-deduplication and synchronous-I/O performance observations remain non-blocking refactoring candidates for P1-3. They are not expanded into C2a because they do not change the approved authority or recovery contract.

## Fourth review disposition

The findings in `docs/P0-C2A_CODE_REVIEW_FINDINGS_ROUND4.md` were reproduced against the third-round implementation. All eight correctness findings were accepted:

- Legacy migration now resolves through the shared library descriptor, rejects managed workspaces/published generations, rejects symlink and nested in-library inputs independently of `--external-path`, and derives its lock from the same canonical descriptor used for the boundary decision.
- Once Ask has generated an answer, every chat-note persistence or lock-release failure returns that answer with bounded save diagnostics. A reference-counted in-process paper lease makes Web deletion return a retryable conflict while an Ask is active without holding the cross-process lock during the external call.
- A `.init-*` directory containing a valid workspace record is classified as an initialization crash residue: exact inspect/abandon remain possible, but it is read-only, non-active, cannot resume, and does not block a fresh prepare retry.
- Reasoning and complete-package validators now perform `validating → report replacement → final state` under one workspace lock. Repository Guard prevents either CLI from returning to split state/report writes.
- Prepare and migration are both required by Repository Guard to retain the shared paper-library resolver, with a mutation test for the previously missing sentinel.

The code-quality recommendations were also accepted where they materially reduce future boundary drift: CAS precondition discovery is shared, storage lock keys use common constructors, prepare uses the shared active-workspace predicate, exact init lookup filters by its encoded ID before parsing, and prepare/workspace CLI error mapping is aligned. Full workspace-list descriptor optimization, broader `.init-*` traversal consolidation, wording deduplication, and synchronous-I/O performance work remain bounded P1-3 follow-ups.

## Fifth review disposition

The findings in `docs/P0-C2A_CODE_REVIEW_FINDINGS_ROUND5.md` confirmed that the fourth-round authority fixes hold. Both new medium correctness findings were accepted:

- A failed `codex-reply` invalidates only the matching paper/thread/path entry. A behavioral regression proves the next request uses a fresh `codex` call while another paper's cached thread remains intact.
- Validation-report replacement failure now attempts, under the same lock, to transition the workspace to `failed` with `validation_report_write_failed` and one bounded path-redacted diagnostic, then rethrows the original persistence error. If the storage failure also prevents record compensation, the original error remains visible and later authoring/validation can recover.

Three bounded engineering recommendations were also adopted: in-process Ask lease registration no longer performs filesystem locking, `librarySecurity.mjs` uses the shared CAS precondition helper, and prepare/workspace CLI exit mapping uses one shared function. Guard mutation coverage now exercises every declared paper-library/workspace-writer consumer plus these new shared boundaries.

The two rejected candidates remain rejected for the review's stated reasons: delete confirmations are freshly prepared on every attempt, and the two workspace descriptor builders are currently behaviorally equivalent. Descriptor-builder consolidation, minor duplicate realpath work, full workspace-list optimization, and broader synchronous-I/O refactoring remain P1-3 work rather than C2a correctness changes.

## Sixth review disposition

Both correctness findings in `docs/P0-C2A_CODE_REVIEW_FINDINGS_ROUND6.md` were reproduced and accepted:

- Per-paper thread invalidation now covers both a rejected `codex-reply` and a successful RPC whose extracted answer is empty. The validation step is behaviorally tested and retains unrelated paper threads.
- Validation persistence now compensates failures in the final workspace-state transition as well as report replacement. It writes `validation_state_update_failed` when possible; if compensation also fails, the primary error is preserved and the secondary error is attached as `preservationError`.

The shared workspace diagnostic sanitizer and exported `MAX_LOCK_TIMEOUT_MS` recommendations were also adopted. Re-reading and hashing `workspace.json` inside the held lock remains deliberate CAS/no-follow defense rather than a C2a performance shortcut. Automatic Guard consumer discovery was not adopted: an import scan cannot infer write authority and would not detect a new bypass that avoids importing the shared module. The current explicit inventory remains fully mutation-tested; broader static-analysis engineering stays in P1-3. The review's cross-process Ask/CLI lease candidate remains correctly refuted because those operations address disjoint physical package trees.

## Seventh review disposition

The single confirmed correctness finding in `docs/P0-C2A_CODE_REVIEW_FINDINGS_ROUND7.md` was accepted. Ask delivery now wraps rich Markdown rendering, falls back to an HTML-escaped plain-text `<pre>` on renderer failure, preserves the raw answer and saved metadata, and appends a visible warning. A behavior test injects a renderer failure and proves active markup remains escaped.

The low-reachability cleanup observation was also adopted as inexpensive defense in depth: bounded deletion of old record-free `.init-*` residues moved under the registry lock, with a Repository Guard mutation preventing it from drifting outside. The `--force` migration candidate remains rejected because explicit replacement is the documented destructive override. Separate finding/workspace diagnostic limits and the explicit Guard consumer inventory remain intentional contract boundaries rather than seventh-round defects.

## Eighth review disposition

The eighth independent review returned a clean finding set and confirmed that both seventh-round fixes are complete, safe, and regression-tested. No product code change was required.

The two recorded defense-in-depth observations were evaluated but not adopted. `renderSafePlainText` already calls `escapeHtml`, which normalizes every value through `String(value ?? '')`, and the Ask contract supplies a non-empty string, so the suggested extra conversion would be redundant. The intermediate-directory `existsSync`/`mkdirSync` race is excluded for same-workspace authoring by the workspace lock; if an unexpected external creator wins that race, the write fails closed without weakening CAS or containment. Broader asynchronous I/O and directory-creation refactoring remains a P1-3 engineering concern.

## Verification record

- Repository Contract passed; repository/security tests: 158/158; Guard mutations: 64/64; study/unit tests: 83/83.
- Storage transactions: 16/16; Paper Identity: 17/17; Library Layout: 7/7; Validation Report: 24/24; PDF ingestion security: 12/12.
- Targeted fourth- through seventh-round regressions passed for managed-workspace/symlink/nested migration refusal, locked pre-rename residue cleanup and retry, Ask lease/reference counting plus save/render answer preservation, rejected and empty per-paper Codex replies, replay-safe deletion confirmation, both validation persistence compensation stages plus secondary-error retention, shared resolver/consumer Guard mutations, and consolidated CAS/lock-key/CLI-exit/timeout predicates. The eighth review independently revalidated these paths and reported no new finding.
- Mandatory deterministic regression: 2/2; external parser corpus: 5/5; reasoning/package benchmarks: 12/12 each.
- Production build, real HTTP security integration, smoke test, prior Browser QA, and official plugin validator passed. HTTP integration caught and closed a transient confirmation-replay ordering regression before final verification.
- Attention sample was prepared only into a temporary workspace; its source directory content+mtime fingerprint remained unchanged, and no formal store/current/index was created.
- Active plugin path: `plugins/codex-paper/`; installed version: `2.0.0+codex.20260722090218`.
- Local Docker conformance was not rerun in this stage; generated-code sandbox unit/policy regressions passed, while full Docker conformance remains an unchanged CI gate.
