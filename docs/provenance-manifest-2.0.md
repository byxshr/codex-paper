# Provenance Manifest 2.0

Generation Manifest `2.0.0` is the sole authoritative provenance record for newly published Codex Paper generations. It is stored at `.codex-paper/generation-manifest.json`; `current.json` stores the final manifest ID, canonical hash and manifest-file SHA-256 without writing those values back into the sealed package.

## Authority and compatibility

- New workspaces use Paper Identity and Generation Contract `2.0.0`, then publish Manifest `2.0.0`.
- Manifest and Identity `1.0.0` remain read-only compatible. Readers verify their original inventory/hash contract and do not rewrite them.
- Unknown or malformed versions fail closed and cannot become current or enter the managed index.
- `provenance-draft.json` is workspace-only staging state. It is not authoritative after publication.
- The Manifest 2.0 schema is frozen byte-for-byte after this contract is
  accepted. Future package, facts, evidence, reasoning, or manifest versions
  receive a new versioned schema/reader; the 2.0 schema is never edited to
  reinterpret already-published manifests.

## Captured facts

The manifest binds:

- redacted source acquisition facts, exact bytes and SHA-256;
- content-affecting runtime policy, Node, CPython, PyMuPDF and parser policy;
- generation inputs, workflow, language, context, profile and declared authoring engine;
- repository/plugin/skill/schema/validator observations and bounded diagnostics;
- a stable sealed-file inventory and acyclic artifact dependency graph;
- Validation Report path, file hash, intrinsic hash, status and validator;
- provenance-bound execution reports completed before sealing;
- declared authoring events and migration history.

Local inputs record only basename, bytes, hash and acquisition time. HTTPS locators discard credentials, query values and fragments. Unobservable model, Codex CLI or repository information becomes a non-blocking `unavailable` diagnostic; missing or nonconformant content-runtime facts block preparation or publication.

## Identity and integrity

The generation fingerprint includes only content-affecting inputs. Runtime policy, Node, CPython, PyMuPDF, parser policy, generation contract and a declared authoring engine therefore change `generationId`. Time, OS patch level, repository state, cachebuster and Codex CLI observation do not.

`manifestId` is derived before authoring from schema version, `paperKey`, `sourceRevisionId` and `generationId`. The final `manifestHash` covers the canonical intrinsic manifest payload. Signature metadata is explicitly:

```json
{
  "status": "unsigned",
  "reason": "deferred_to_p2_5"
}
```

Cryptographic signing is outside P1-4.

## Authoring WAL

Every workspace authoring write records a pending event before its CAS/no-follow atomic file replacement. The event contains a declared actor, artifact path, before/after hashes and dependency hashes, but no content, environment or absolute path. A second atomic update marks it complete. Recovery classifies a pending event as complete or aborted from the target hash; ambiguous state blocks publication.

Visible study artifacts depend on the current reasoning artifact plus the evidence layer. The quick-summary workflow, which intentionally has no full reasoning artifact, records `analysis.json` as its reasoning fallback together with ledger and facts dependencies.

Reasoning must therefore be finalized before visible authoring. If an upstream
reasoning/evidence artifact changes later, regenerate each affected downstream
artifact through the shared writer. A stale dependency is a publication block,
not a warning: the error reports the downstream path, dependency, expected
hash, and actual hash.

The public actor values are `codex`, `human` and `unknown`; `tool` is reserved for built-in writers. Actor values are audit declarations, not authenticated identities. At most 2048 events are accepted.

`--depends-on <relative-path>` adds dependencies to the defaults. The limit is
64 total dependencies after defaults and explicit values are merged and
deduplicated. README input is normalized by the writer to maintain one
provenance footer; callers must retain the returned SHA-256 for the next CAS
replacement.

An ambiguous pending event is never guessed away. The operator may run:

```bash
bash scripts/codex-paper.sh provenance-resolve <workspace> --adopt-current <event-id>
```

Use `provenance-inspect <workspace> --json` to list the pending event ID, path
and intended SHA-256 required by this command. Recovery first durably demotes a
validated workspace to `authoring`, then adopts the current artifact bytes,
aborts the interrupted intent and appends a completed event with actor
`unknown`. A crash after demotion therefore cannot publish under the previous
Validation Report. Explicit adoption emits `AUTHORING_EVENT_ADOPTED`;
unambiguous before/after-hash crash recovery emits
`AUTHORING_EVENT_RECONCILED`. If the current artifact or any recorded
dependency is missing or unreadable, the only safe remedy is to abandon the
workspace and prepare again.

Manifest 2.0 and the provenance-draft event key allowlist are frozen. Explicit
adoption is therefore represented by an adjacent recovered aborted/completed
event pair rather than a new event flag; a future versioned schema may add a
first-class resolution field.

CLI failures apply the same bounded path, credential, query, fragment and
secret redaction to both the message and structured `Details`. Empty details
are omitted; oversized details remain valid JSON with an explicit truncation
marker. Absolute Unix paths with multiple segments are redacted independently
of surrounding punctuation, and URL/non-URL chunks are sanitized without
replaceable textual placeholders. The final `safeDetail` absolute-path check
is retained as defense in depth. `PROVENANCE_DEPENDENCY_STALE` therefore exposes each downstream
artifact, changed dependency, expected SHA-256 and actual SHA-256 without
leaking local absolute paths. Missing draft files return
`PROVENANCE_DRAFT_MISSING` instead of raw filesystem diagnostics.

README contains exactly one hash-derived manifest-ID footer. `meta.json` carries only the manifest schema and ID. Any authoring change returns the workspace to `authoring` and requires validation again.

## Execution binding

Workspace execution reports use report contract `2.0.0` and bind the precomputed manifest ID plus generation ID. Complete, valid reports enter `executions.atSeal`; pending, malformed or cross-generation reports block publication.

Post-publication reports remain in the generation-scoped mutable overlay. They bind the current manifest ID, canonical manifest hash and manifest-file SHA-256, carry their own intrinsic report hash, and appear as `postSealEvents` in inspection output. They never mutate the sealed manifest.

## Commands

```bash
bash scripts/codex-paper.sh provenance-inspect <paper-or-workspace> --json
bash scripts/codex-paper.sh provenance-verify <paper-or-workspace> --json
bash scripts/codex-paper.sh provenance-resolve <workspace> --adopt-current <event-id>
bash scripts/codex-paper.sh provenance-test
```

Inspection modes are `workspace_draft`, `native_2_0`, `compatible_1_0` and `unsupported`. Verification exits `0` for valid native/compatible provenance, `1` for integrity or binding failure, `2` for argument/configuration failure and `3` when required runtime capability is unavailable.

Manifest validation re-derives authoring status and diagnostics from the
sealed event/source/software facts; diagnostics are not an independently
editable assertion.

The pure Manifest schema/sealing reader is excluded from the generation
fingerprint. The current `generation-provenance.mjs` module remains
content-affecting because it also owns writer projection and dependency
semantics. Splitting its verification-only helpers without weakening the
fingerprint is tracked for P1-3b.
