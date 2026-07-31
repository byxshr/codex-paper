# Generated-code Docker sandbox security

Codex Paper treats every generated Python/JavaScript file as untrusted. Package validation is static; code runs only through the separate Docker workflow after the user approves one exact execution plan.

## Trust boundary

Trusted:

- the local user, repository source, pinned build input, Docker daemon and host kernel;
- the sandbox policy, container entrypoint and host runner.

Untrusted:

- paper packages, generated code, imported local resources and all stdout/stderr.

Docker access is effectively host-privileged, so the daemon itself is not exposed to generated code. The Docker socket, host HOME, paper files outside `code/`, SSH material, cloud credentials and host environment are never mounted or inherited.

## Capability states

- `ready`: Docker, the expected image labels/ID and a conformance stamp all match the current policy fingerprint.
- `unavailable`: the platform, Docker CLI/daemon or expected image is absent.
- `nonconformant`: the engine/image exists, but conformance has not passed for this exact engine, image and policy.

`sandbox-setup` is the only command that builds the pinned image. `sandbox-plan` and `sandbox-run` never install, pull or build and never fall back to host execution.

## Runtime policy

Each approved top-level `.py`, `.js` or `.mjs` artifact runs sequentially in a fresh container. The host supplies a fixed argv; user arguments and shell interpolation are unsupported. Python uses isolated mode; Node disables native addons and prototype mutation through `__proto__`. The initial interpreter allowlist is not a claim that code inside the container is benign—the container boundary remains mandatory.

The container has:

- `--network none`, no inherited credentials, and no Docker socket;
- read-only root plus read-only `/workspace` containing only `code/`;
- a bounded `/tmp` as the only writable filesystem;
- UID/GID `65532`, all capabilities dropped, `no-new-privileges` and Docker's default seccomp policy;
- wall, CPU, memory/swap, PID, file-size, open-file and output limits.

The first failed artifact stops further execution. Timeout or output overflow triggers an explicit container kill followed by forced removal.

## Approval and reports

Plans include all code-tree hashes, exact commands, image ID, policy fingerprint, mounts and limits. A ready plan creates a random 256-bit token valid for five minutes. The token file is current-user-only, atomically claimed, consumed before validation and bound to the exact paper/code/image/policy state. Reuse and changed inputs fail.

The token protects plan integrity, freshness and single consumption; it does not authenticate that a human supplied consent. Explicit human approval is a workflow boundary enforced by the study skill: the agent must stop after displaying the plan and wait for a new user reply before invoking `sandbox-run`. The container remains the technical execution-security boundary. Expired, unused token files are swept whenever a new approval is created.

Execution reserves a no-follow report destination before running. The final atomic JSON report includes bounded output and wall/CPU/max-RSS data when the entrypoint completes. The host accepts this resource object only when it is a small regular file with finite non-negative numeric fields and a status matching the container exit. Because the channel originates in the container's writable tmpfs, reports label it `authoritative: false`; it must not be used for billing or policy enforcement. Tokens and host secrets are never written to reports.

## Known limitations

- The current Mac has no Docker, so only fail-closed and mock-engine paths run locally; real isolation remains a mandatory CI gate after push/PR.
- Docker daemon and kernel compromise are outside this threat model.
- The image includes only Python/Node standard libraries. Missing dependencies fail; the runner never performs `pip` or `npm` installation.
- GPU, network allowlists, interactive stdin, parallel execution and additional sandbox backends are out of scope.
