# Benchmarks

This directory stores the parser benchmark manifest, gold expectations, and reporting scripts for Codex Paper P0.

## PDF source

The benchmark PDFs are intentionally kept outside the repository. By default the scripts read from:

```bash
~/codex-papers/paper-examples
```

Override the location with either `BENCHMARK_DIR` or `CODEX_PAPER_BENCHMARK_DIR`.

## Files

- `manifest.json`: the fixed benchmark set
- `gold/*.json`: paper-level expectations for titles, authors, page counts, abstract phrases, links, and forbidden title patterns
- `run-benchmark.mjs`: executes the parser benchmark and writes `/tmp/codex-paper-benchmark.json`
- `benchmark-report.mjs`: formats the latest benchmark report

## Gold rules

- `expectedTitle` must match after normalization
- At least one `expectedPrimaryAuthors` entry must appear in parser output
- `expectedPageCount` must match exactly
- At least one `requiredAbstractPhrases` item must appear in the abstract
- Every `requiredLinks` item must appear in extracted links
- Every `forbiddenTitlePatterns` regex must fail to match the parsed title
