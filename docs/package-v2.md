# Codex Paper v2 Package Contract

A completed v2 package keeps the v1 visible file set and adds internal evidence/reasoning files. v1 packages remain browseable and can still be checked with `--legacy-ok`.

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

`meta.json.packageVersion` is `2.0.0` for completed v2 packages.

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
