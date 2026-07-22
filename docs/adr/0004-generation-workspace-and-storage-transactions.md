# ADR 0004: Generation Workspace and Storage Transactions

- Status: Accepted
- Date: 2026-07-21

## Context

Preparation previously made a generation visible before the multi-step authoring and validation workflow completed. Process-local Web locks did not coordinate CLI writers, and several consumers implemented independent atomic-write helpers without a common CAS or lock-ownership contract.

## Decision

All new generation work is isolated in a same-filesystem private workspace. Publication is a separate C2b transaction. Managed mutations use hierarchical cross-process filesystem locks and one no-follow CAS writer. Web conflicts fail immediately; CLI operations wait for a bounded interval. Failed workspaces persist, and users may explicitly mark them abandoned.

Codex authoring uses the workspace writer rather than editing package files. Exact workspace selection is mandatory. Published generation content is read-only; mutable paper overlay data remains outside it.

## Consequences

Incomplete work is no longer Viewer-visible and cannot change `current.json` or the index. Cross-process contention is observable and bounded, and stale-lock recovery prefers safety over convenience. Workspaces consume disk until an explicit lifecycle policy is implemented. C2b is required before newly generated work can be published.
