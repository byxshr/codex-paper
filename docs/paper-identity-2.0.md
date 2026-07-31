# Paper Identity and Generation Contract 2.0

Paper Identity `2.0.0` extends the immutable identity contract used by new
generation workspaces. Identity `1.0.0` remains readable without writeback;
existing generation IDs are never recomputed.

## Fingerprint boundary

`generationId` is the SHA-256 of canonical generation inputs. Content-affecting
inputs include:

- source SHA-256, workflow, language, context mode and paper profile;
- package/evidence/facts/reasoning contract versions;
- parser backend, parser contract and Generation Contract `2.0.0` hash;
- runtime policy, Node, CPython, PyMuPDF and parser-policy versions/hashes;
- a declared authoring provider/model, or stable `unavailable` values.

Time, OS patch level, repository commit/tree state, Codex CLI version, plugin
cachebuster and authoring event history are provenance-only and do not alter
the generation identity.

Generation Contract 2.0 excludes the pure Manifest schema/sealing reader.
`generation-provenance.mjs` remains content-affecting because it also owns
authoring projection and dependency semantics; a future P1-3b split will
separate its verification-only helpers. Until then, changes to that mixed
module intentionally change the content contract rather than claiming a
verification-only exemption.

## Authoring observation

Provider and model values are declarations, not authenticated observations.
When the workflow cannot observe either value, both are recorded as
`unavailable`; fabricated provider defaults are forbidden. Declared values
participate in the fingerprint, while their observation source remains visible
in provenance.

## Compatibility

- Identity 2.0 is native for new Generation Manifest 2.0 publications.
- Identity 1.0 retains its original reader and fingerprint semantics.
- Unknown versions fail closed.
- P1-2 owns explicit migration, backup and rollback; P1-4 performs no
  in-place upgrade.
