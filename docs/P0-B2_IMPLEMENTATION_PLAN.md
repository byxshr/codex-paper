# P0-B2 Implementation: Typed ResultClaim and Direct Evidence References

## Objective

P0-B2 implements the S0-frozen minimum 2.1 package contract. New packages expose typed quantitative results, deterministic front-matter filtering, and direct evidence references without changing the frozen evidence, external-evidence, or reasoning 2.0 schemas.

## Implemented Boundary

- New writers set `meta.packageVersion` and `facts.schemaVersion` to `2.1.0`.
- `facts.resultClaims` records metric/value/context tuples with page/table location, confidence, and non-empty `ev-*` references.
- `facts.keyResults` remains a compatibility projection through 3.0.
- New facts and analysis outputs use direct `ev-*` references. Readers still resolve historical `claim:n`, `result:n`, and `limitation:n` references in memory.
- Evidence-ledger, external-evidence, and reasoning-analysis schemas remain exactly `2.0.0`.
- Package contract, frozen schema versions, and plugin/package versions are independent version axes.

## Extraction Policy

Result candidates must bind a numeric token to an explicit metric in the same evidence clause. The P0 registry covers BLEU, Accuracy, F1, ROUGE, Perplexity, AUC/AUROC, mAP, Precision, Recall, and Exact Match. Years, page/table labels, citations, versions, hardware counts, parameter counts, and training duration are excluded from primary metric values.

Copyright, conference boilerplate, arXiv/version text, author footnotes, references, and repeated heading-like noise are excluded from core facts and downstream analysis. Missing dataset, split, language pair, model, or comparator fields remain `null`; the writer does not guess.

Compatible claims with the same metric and numeric value merge their evidence. Different values remain separate even when they share the same task/dataset/metric. Therefore 41.8 and 41.0 are both retained; P0-B3 owns conflict findings and publication gates.

## Compatibility Contract

The shared reader reports one of:

- `native_2_1`: native ResultClaim package.
- `compatible_2_0`: readable 2.0 package; legacy fact refs resolve in memory without writing.
- `legacy_v1`: static legacy browsing and existing `--legacy-ok` behavior.
- `unknown_read_only`: safe GET/read behavior with `PACKAGE_VERSION_UNSUPPORTED`; validators and artifact writers fail closed.

Viewer facts, analysis, and reasoning responses include the compatibility object. Compatibility reads must not change package hashes or mtimes. Explicit 2.0-to-2.1 migration remains P1-2 work.

## Acceptance and Rollback

The mandatory fixtures require:

- front-matter fixture: 28.4 BLEU only; 2017/2026 and front-matter phrases cannot enter facts/analysis;
- conflict fixture: 28.4, 41.8, and 41.0 remain evidence-backed; 2014 is a dataset year, not a result; 41.8 includes Table 2 evidence;
- every new analysis reference resolves to the generated evidence ledger;
- both study and strict reasoning validators pass.

The remaining expected findings are intentionally limited to parser-level front-matter contamination and the missing conflict warning, both owned by P0-B3. Rollback is a normal Git revert of the P0-B2 change set; no user package migration is performed in this phase.

## Remaining Risks

- Complex table grids, multi-column reading order, and general header/footer classification remain P1-1.
- Facts and analysis remain hints/projections until P0-B3 adds cross-artifact validation and three-state health.
- Existing title-slug overwrite behavior and transactional publication remain P0-C1/C2.
