# Benchmarks

This directory stores the mandatory synthetic regression, optional external parser corpus, reasoning/package fixtures, and reporting scripts for Codex Paper P0.

## Mandatory synthetic regression

The pull-request gate always runs:

```bash
bash scripts/codex-paper.sh benchmark-mandatory
```

Two original MIT-licensed PDFs under `fixtures/pdf/` exercise front-matter noise and conflicting result values. Every PDF has an adjacent license/hash/generator manifest and is reproducible with:

```bash
python3 benchmarks/fixtures/generate-pdf-fixtures.py --check
```

The suite uses the production bounded prepare pipeline, a fixed model-free authoring boundary, and both package validators. It has no skip mode: zero or partial execution is a failure. P0-B2 result/noise defects are now positive typed ResultClaim assertions; parser contamination and the missing conflict warning remain expected findings until P0-B3 supplies Validation Report 1.0.

## Optional external PDF source

The benchmark PDFs are intentionally kept outside the repository. By default the scripts read from:

```bash
~/codex-papers/paper-examples
```

Override the location with either `BENCHMARK_DIR` or `CODEX_PAPER_BENCHMARK_DIR`.

CI can set `CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS=1` to mark missing external PDFs as skipped. This flag never affects the mandatory suite. Local external-corpus runs remain strict by default.

## Files

- `manifest.json`: the fixed benchmark set
- `gold/*.json`: paper-level expectations for titles, authors, page counts, abstract phrases, links, and forbidden title patterns
- `mandatory/manifest.json`: the non-skippable synthetic fixture set
- `mandatory/gold/*.json`: required 2.1 ResultClaim assertions, remaining expected findings, and reserved B3 targets
- `fixtures/pdf/`: redistributable PDFs and adjacent provenance manifests
- `fixtures/generate-pdf-fixtures.py`: deterministic standard-library fixture generator
- `run-mandatory-benchmark.mjs`: bounded PDF-to-validator regression executor
- `run-benchmark.mjs`: executes the parser benchmark and writes `/tmp/codex-paper-benchmark.json`
- `benchmark-report.mjs`: formats mandatory and optional reports separately

## Gold rules

- `expectedTitle` must match after normalization
- At least one `expectedPrimaryAuthors` entry must appear in parser output
- `expectedPageCount` must match exactly
- At least one `requiredAbstractPhrases` item must appear in the abstract
- Every `requiredLinks` item must appear in extracted links
- Every `forbiddenTitlePatterns` regex must fail to match the parsed title
