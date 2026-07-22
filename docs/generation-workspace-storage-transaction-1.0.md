# Generation Workspace and Storage Transaction Contract 1.0

## Workspace authority

A workspace is private authoring state at:

```text
PAPERS_DIR/.codex-paper/workspaces-v1/<workspaceId>/
├── workspace.json
└── package/
```

`workspace.json` records only bounded operational state and publish intent. It never contains absolute paths or claims to be an authoritative generation manifest. States are `authoring`, `validating`, `validated`, `failed`, and `abandoned`. `validated` means that workspace validation completed; it is not a publication promise.

State changes use an explicit transition table. Any authoring, analysis, rendering, or scaffold write changes a non-authoring workspace back to `authoring` before replacing content. Validation-report writes are the only specialized package writes allowed to preserve `validating`. `abandoned` is terminal and read-only.

Validation holds one workspace lock from `validating` through report replacement and final state. If report replacement fails while the workspace record remains writable, validation records `failed`, `validation_report_write_failed`, and one bounded path-redacted diagnostic before rethrowing the original error. If report replacement succeeds but the final workspace-state update fails, the equivalent marker is `validation_state_update_failed`. Workspace diagnostics share one 600-character sanitizer. A storage-wide failure may also prevent best-effort compensation; the primary persistence error remains authoritative and the secondary failure is attached as `preservationError` for operators, while a later authoring or validation run can recover the state.

Workspace references are exact IDs or paths. The system never guesses the newest workspace. The same generation cannot have two active workspaces. `authoring`, `validating`, and `validated` are active; `failed` is retained for diagnosis but does not permanently block a fresh prepare retry. `--resume-workspace` must identify the exact existing workspace.

Initialization is written under a private `.init-*` sibling and atomically renamed only after core artifacts and the record are durable. Valid workspaces, including failed workspaces, are retained. A `.init-*` directory with a valid `workspace.json` is an initialization crash residue: it remains discoverable by exact ID/path for diagnosis or explicit abandon, but is read-only, never counts as an active generation/route reservation, and cannot be resumed or authored. A fresh prepare may therefore retry the generation safely. Only incomplete `.init-*` entries without a workspace record and older than one hour are eligible for bounded cleanup; that cleanup inspects at most 32 entries and runs while holding the registry lock. Abandon marks a workspace read-only without deleting it.

## Lock contract

Locks live under `PAPERS_DIR/.codex-paper/locks-v1/`. Each lock is an atomically-created private directory containing a `0600` owner record with a 256-bit token, PID, hostname, acquired time, and heartbeat time.

The global order is:

```text
registry → paper → source → generation → workspace/trash → index
```

Callers may provide keys in any order; the transaction module normalizes them. A partial acquisition is completely released before retry. Web callers use timeout `0`; CLI callers default to 10 seconds and may request at most 30 seconds.

A lock is reclaimed automatically only when its owner record is valid, its hostname is the current host, and its PID is no longer alive. Reclaim first acquires an exclusive sibling claim, re-reads the owner, and verifies the moved owner token before deletion. Active PIDs, foreign hosts, missing/corrupt records, and symlinked lock paths fail closed. An ownerless directory is not reclaimed from age alone; guarded diagnosis/recovery is deferred to the recovery phase. Release requires the original owner token, and a release error for one key does not prevent attempts to release the remaining keys.

## Writer contract

Every managed write requires a matching live lock handle. The shared writer:

- validates root and every existing path component without following symlinks;
- rejects absolute paths, traversal, backslashes, NULs, and non-regular targets;
- requires `expectAbsent` for creation or `expectedSha256` for replacement;
- enforces caller-specific byte budgets and modes;
- writes an `O_EXCL | O_NOFOLLOW` temporary file in the target directory;
- fsyncs the file, renames atomically, and fsyncs the parent directory;
- removes temporary residue on ordinary failures.

Generic workspace authoring is limited to approved Markdown/HTML, `reasoning-analysis.json`, managed review/answering documents, `code/**`, and `images/**`. Core evidence, identity, validation report, PDF, and workspace record use dedicated writers.

Dedicated writers must declare an output policy. The policy is enforced in the shared writer rather than inferred from caller intent. Deletion also requires an exact SHA-256 precondition.

Published managed generations and legacy flat packages are generation-content read-only. Viewer overlay mutations remain permitted under paper/index locks. Sandbox reports for a published generation go to its generation-scoped mutable overlay; workspace reports remain inside the workspace.

## Publication boundary

P0-C2a never creates or mutates the formal paper record, current pointer, or index for a new workspace. Viewer resolution remains based on published records only. P0-C2b must re-read the workspace, verify its Validation Report gate, build and seal a manifest, and commit formal record/current/index state as a recoverable transaction.
