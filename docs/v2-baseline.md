# Codex Paper v2 Baseline

Baseline captured before implementing the v2 evidence and reasoning upgrade.

- Date: 2026-06-23
- Branch: `feat/evidence-reasoning-v2`
- Baseline commit: `623570005fe4645bf9749ed7179b92dccb825a39`
- Baseline plugin version: `1.3.0`
- Target version: `2.0.0`

## Commands

| Command | Result | Notes |
|---|---|---|
| `bash scripts/codex-paper.sh install` | PASS | Plugin and Web dependencies installed. Web dependency audit reports 34 vulnerabilities already present in the baseline. |
| `bash scripts/codex-paper.sh benchmark` | PASS | Parser benchmark passed 5/5 against `/Users/bianyuxin/codex-papers/paper-examples`; report written to `/tmp/codex-paper-benchmark.json`. |
| `bash scripts/codex-paper.sh smoke-test` | PASS | Built Web UI, created `/tmp/codex-paper-smoke.pdf`, parsed it, extracted images, started a temporary viewer, and verified `/api/papers` plus the home page. |
| `cd plugins/codex-paper/src/web && npm run build` | PASS | Nuxt production build completed. |

## Parser Compatibility Baseline

The public parser benchmark currently validates the following paper set without failures:

- `group-sequence-policy-optimization`
- `how-to-allocate-how-to-learn-dynamic-rollout-allocation-and-advantage-modulation-for-policy-optimization`
- `qwen3-technical-report`
- `websailor-navigating-super-human-reasoning-for-web-agent`
- `olmo-accelerating-the-science-of-language-models`

The v2 parser changes must keep `parsePdf()` and the CLI JSON compatible with this gold set.

## Baseline Risks

- `plugin/src/web/node_modules` and `plugins/codex-paper/node_modules/pdf-parse` are tracked in Git at baseline. The v2 cleanup phase should remove tracked dependency directories and add ignore rules, as required by the implementation plan.
- Running `npm install` touches `plugins/codex-paper/node_modules/.package-lock.json` because the dependency directory is tracked. This generated change should not be preserved as a feature change.
- Web dependencies report 34 audit findings in the baseline. This is recorded for visibility but is not part of the v2 behavioral contract.
