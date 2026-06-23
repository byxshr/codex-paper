# Migrating v1 Packages to v2

Use the migration tool to add v2 evidence and draft reasoning files to an existing package:

```bash
bash scripts/codex-paper.sh migrate ~/codex-papers/papers/{paper-slug}
```

The migration is conservative:

- If `paper.pdf` exists, it reparses the PDF and builds a page-aware evidence ledger.
- If no PDF is available, it reconstructs a degraded ledger from retained `paper-data.json` text.
- It writes `reasoning-analysis.json` as a draft skeleton.
- It writes `.codex-paper/reasoning-review.md`.
- It updates `meta.json` with `packageVersion: "2.0.0"` and `migrationStatus: "reasoning-draft"`.
- It does not fabricate central claims, weakest assumptions, counterexamples, or follow-up ideas.

After migration, Codex or a reviewer must fill the reasoning file from the evidence ledger, set `status` to `complete`, and run:

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js "<paper-dir>" --strict
node plugins/codex-paper/skills/study/scripts/validate-study-package.js "<paper-dir>" --run-code
```

For old packages that have not been migrated, v1 compatibility remains available:

```bash
node plugins/codex-paper/skills/study/scripts/validate-study-package.js "<paper-dir>" --legacy-ok
```
