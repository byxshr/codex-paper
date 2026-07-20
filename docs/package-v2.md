# Codex Paper v2 Package Contract

A completed v2 package keeps the v1 visible file set and adds internal evidence/reasoning files. v1 packages remain browseable and can still receive limited read-only validation with `--legacy-ok`. Without that flag the validator reports `LEGACY_PACKAGE_REQUIRES_LEGACY_OK`; the flag does not authorize analysis, rendering, scaffolding, or other artifact writes.

## Internal Files

```text
evidence-ledger.json
reasoning-analysis.json
meta.json
paper-data.json
facts.json
analysis.json
.codex-paper/answering-pack.md
.codex-paper/reasoning-review.md
.codex-paper/validation-report.json
.codex-paper/external-evidence.json  # only for canonical/literature mode
```

Newly prepared packages use `meta.json.packageVersion = 2.1.0`. The evidence ledger, external-evidence manifest, and reasoning-analysis schemas remain frozen at `2.0.0`; package and artifact schema versions are intentionally independent.

`facts.json` uses schema `2.1.0` and adds typed `resultClaims`. Each result binds a numeric value to a metric, location, confidence, and direct `ev-*` evidence. `keyResults` remains a compatibility projection until 3.0.

Readers accept package `2.0.0` without rewriting it and resolve historical `claim:n`, `result:n`, and `limitation:n` references in memory. Unknown package versions are safe-read-only, carry `PACKAGE_VERSION_UNSUPPORTED`, and cannot be validated or rewritten implicitly.

`meta.json.packageVersion` is the only authority that can establish writable native `2.1.0` mode. Missing metadata is never inferred as writable 2.1 from ancillary artifacts: evidence and reasoning schemas intentionally remain `2.0.0`, while unexpected `2.1.0` ancillary schema versions fail closed as `unknown_read_only`. If compatibility-only metadata is malformed, readers that can still safely serve their primary artifact return `PACKAGE_ARTIFACT_INVALID`; validators fail instead of silently inferring 2.0 compatibility.

Viewer compatibility metadata is a lightweight version/read-mode view, not an integrity or publication-health report. With a valid authoritative `meta.packageVersion`, Viewer GET endpoints do not parse the full evidence ledger solely to revalidate package integrity. The CLI validator reads all managed artifacts and can therefore fail a package that the Viewer still classifies by its declared version. Consumers must not treat Viewer `compatibility.readOnly` as `publishable`; P0-B3 Validation Report 1.0 owns that decision.

The prepare writer validates the complete generated `facts.json` against the 2.1 JSON Schema before publishing it. Ordinary analysis, rendering, and reasoning-scaffold writers reject every read-only compatibility mode. The existing explicit v1-to-v2 migration workflow retains its narrowly scoped internal scaffold write, including packages that explicitly declare a `1.x` version; before writing, it validates all existing compatibility JSON and ancillary schema versions, even under `--force`. This is not a general 2.0 write or an implicit 2.0-to-2.1 migration.

## Visible Files

The visible set remains compatible with v1:

```text
README.md
visual-assets.md
summary.md
insights.md
method.md
mental-model.md
reflection.md
qa.md
index.html
paper.pdf
images/
code/
```

Visible files must carry evidence-driven analysis through natural prose. They must not expose `evidenceRefs`, `sourceType`, `reasoning-analysis.json`, `evidence-ledger.json`, parser object paths, or `ev-*` / `ext-*` IDs.

## Required Visible Analysis

- README explains the evidence base, reading route, package version, and parser limits when present.
- Summary separates question, method, results, limitations, and evidence location.
- Mental model states the paper type/profile and how to read it.
- Insights distinguish central claims, inferences, and uncertain zones in natural language.
- Method includes reproducibility support and falsification criteria.
- Reflection includes weakest assumption, strongest counterexample, and non-incremental follow-up.
- QA has basic, intermediate, and advanced layers.
- `index.html` contains an offline interactive method/reasoning/result view.

## Context Modes

- `paper-only`: default; no live web search; external literature facts are invalid.
- `canonical`: allows explicitly collected canonical source evidence, stored only in `.codex-paper/external-evidence.json`.
- `literature`: allows broader literature facts, also stored only in `.codex-paper/external-evidence.json`.

The evidence ledger always remains paper-only.
