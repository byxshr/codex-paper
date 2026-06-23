# Codex Paper v2 Evidence Ledger

`evidence-ledger.json` is the paper-only evidence record for a v2 study package. It is generated deterministically by the parser/preparation layer and must not include external facts, model guesses, or literature context.

## Location

```text
~/codex-papers/papers/{paper-slug}/evidence-ledger.json
```

## Contract

- `schemaVersion` is `2.0.0`.
- Evidence IDs are stable `ev-p{page}-{kind}-{hash}` identifiers produced from page, kind, text, and character offset.
- `pages` contains page-aware text and offsets.
- `sections` contains a best-effort section tree with canonical roles such as `abstract`, `method`, `results`, `limitations`, and `references`.
- `evidence` contains paragraph, heading, figure/table/caption, equation, footnote, abstract, and reference units.
- `quality` records parser, reading-order, section-coverage, table-extraction, and warning degradations.

## Boundaries

The ledger is only for evidence found inside the paper PDF or retained paper text. Context modes `canonical` and `literature` write external facts to `.codex-paper/external-evidence.json`; those external items use `ext-*` IDs and are validated separately.

## Validation

The ledger is consumed by:

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js "<paper-dir>" --strict
node plugins/codex-paper/skills/study/scripts/validate-study-package.js "<paper-dir>" --run-code
```

Visible Markdown and HTML must cite evidence by natural location, such as page, section, figure, table, or appendix. They must not expose `ev-*` IDs or internal JSON field names.
