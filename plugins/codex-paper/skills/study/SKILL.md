---
name: paper-study
description: Use this skill when the user wants Codex to read, study, analyze, or deeply understand a research paper from a local PDF, direct PDF URL, or arXiv link, then generate a complete paper learning workspace with Markdown, HTML, code, images, and the original PDF.
---

# Paper Study Workflow

Use this skill for deep paper study, not quick summarization. The goal is a reusable learning environment authored by Codex after reading the paper evidence.

Detect the user's language from the request and write every user-facing material in that language. For Chinese requests, use Chinese prose except for proper nouns and established technical terms such as Qwen3, MoE, RAG, DUPO, Transformer, benchmark names, dataset names, and metric names.

## Core Contract

The final deliverable is a complete study package under:

```text
~/codex-papers/papers/{paper-slug}/
```

Required user-visible files:

```text
README.md
summary.md
insights.md
qa.md
method.md
mental-model.md
reflection.md
index.html
paper.pdf
code/{concept-specific-demo}
```

Try to also create:

```text
images/
```

Internal evidence files may exist but must not be shown as study material:

```text
paper-data.json
facts.json
analysis.json
meta.json
```

Never copy JSON field names, extraction labels, or machine traces into user-facing files. Forbidden visible residues include `analysisVersion`, `evidenceRefs`, `coreClaims`, `keyResults`, `Result 1`, `See evidence`, parser object paths, raw JSON snippets, and template placeholders.

## Step 1: Prepare Evidence

Inputs supported:

* Local PDF path, for example `~/Downloads/paper.pdf`
* Direct PDF URL
* arXiv `/abs/` or `/pdf/` URL

Run the preparation entrypoint from the study skill directory:

```bash
node ./scripts/prepare-paper.js "<user-input>"
```

The script resolves URLs, parses the PDF, copies `paper.pdf`, refreshes `~/codex-papers/index.json`, and writes:

```text
~/codex-papers/papers/{paper-slug}/paper-data.json
~/codex-papers/papers/{paper-slug}/facts.json
~/codex-papers/papers/{paper-slug}/analysis.json
~/codex-papers/papers/{paper-slug}/meta.json
```

Treat these JSON files as evidence preparation only. They are not final study material.

## Step 2: Read Before Writing

Before creating or rewriting any final material, read:

* `paper-data.json`: title, authors, abstract, sections, links, parser warnings, quality flags, and `rawText`
* `facts.json`: extracted claims, results, limitations, and evidence snippets
* `analysis.json`: low-level structured hints for problem, core idea, contributions, results, limitations, and open questions

If the available sections are sparse, inspect `paper-data.rawText` in chunks and search for method, experiment, results, ablation, limitation, conclusion, appendix, dataset, and metric terms. Prefer the paper text over derived artifacts whenever they conflict.

Assess:

* Difficulty: beginner, intermediate, advanced, or highly theoretical
* Paper type: theoretical, architecture, empirical, system, survey, benchmark, or post-training recipe
* Method complexity: simple pipeline, multi-stage training, new architecture, mathematical derivation, agent system, or evaluation framework
* Evidence quality: complete enough, partial sections, missing abstract, noisy table extraction, or weak quantitative evidence

If parsing quality is limited, say so in `README.md` in natural language. Do not fill gaps with invented template content.

## Step 3: Tags

Infer exactly two semantic tags from the paper:

* exactly 2 tags
* each tag 1-3 words
* distinct and specific
* avoid generic tags such as `paper`, `research`, `ai`, `ml`
* prefer one domain/problem tag and one method/core-idea tag

Persist the same tags in:

```text
~/codex-papers/papers/{paper-slug}/meta.json
~/codex-papers/index.json
```

## Step 4: Write The Complete Study Package

Codex must author these files directly from the paper evidence. Do not use `render-from-analysis.js` as the final generator. That script is only a quick-summary fallback for the separate quick summary flow.

Ground every claim in `paper-data.json`, `facts.json`, `analysis.json`, or direct `rawText` reading. Do not invent metrics, datasets, model sizes, ablations, code links, training stages, or conclusions. When mentioning quantitative results, use a natural source note such as `来源：实验部分` or `Source: Experiments`; do not expose evidence IDs.

### README.md

Purpose: orientation and navigation.

Include:

* one-paragraph paper overview
* difficulty level and why
* recommended reading route
* estimated study time
* generated file map
* key takeaways
* parser or evidence limitations, if any

### summary.md

Purpose: complete structured review.

Include:

* background and motivation
* problem statement
* method overview
* training, data, architecture, or system details when applicable
* experiments and key results, only when evidenced
* limitations and open questions
* concise comparison with prior work if supported by the paper

### insights.md

Purpose: the most important conceptual explanation.

Include:

* core idea in plain language
* why the idea may work
* conceptual shift introduced by the paper
* trade-offs and hidden costs
* practical meaning for researchers or builders
* what to remember after one week

### method.md

Purpose: method and implementation understanding.

Include:

* component breakdown
* process or algorithm flow
* pseudocode where useful
* implementation pitfalls
* reproduction risks
* hyperparameters, model variants, stages, datasets, or metrics only when present in the paper
* an ASCII diagram if it clarifies the method

### mental-model.md

Purpose: research map.

Include:

* required prior knowledge
* what type of problem the paper addresses
* where it fits in the broader research landscape
* what category this work belongs to
* how to mentally compare it with nearby methods

### reflection.md

Purpose: research thinking beyond the paper.

Include:

* fragile assumptions
* failure modes
* extension ideas
* future questions
* what would make the result stronger or weaker

### qa.md

Purpose: active recall.

Write layered Q&A items:

* Default: exactly 15 items, with 5 basic, 5 intermediate, and 5 advanced questions
* Flexible fallback: for short papers, position papers, narrow-scope papers, or papers with limited parser evidence, write 9-15 items with at least 3 questions per level
* If writing fewer than 15 items, add one natural sentence before the first level heading explaining why the set is shorter
* Every answer must be grounded in paper evidence

Use this format:

```markdown
## Basic

### 1. Question

<details>
<summary>Answer</summary>

Answer grounded in the paper.

</details>
```

## Step 5: Code Demo

Create at least one runnable code demo in:

```text
~/codex-papers/papers/{paper-slug}/code/
```

Rules:

* Name the file after a core concept, not `demo.py` or `model_demo.py` unless that is truly specific.
* Make it self-contained and runnable independently.
* Prefer a compact educational implementation or visualization of the paper's central mechanism.
* Include short comments explaining why each step matters.
* Do not claim to reproduce the paper unless the code actually does so.
* Add a short run instruction in `README.md`.

Examples of good names:

```text
code/dupo_sampling_policy_demo.py
code/moe_routing_tradeoff.py
code/retrieval_uncertainty_explorer.js
```

## Step 6: Interactive HTML Explorer

Create:

```text
~/codex-papers/papers/{paper-slug}/index.html
```

Requirements:

* single self-contained HTML file
* inline CSS and JavaScript
* no external fetch, CDN, localStorage, remote fonts, or network dependency
* works in a sandboxed iframe
* contains at least one real interactive control
* the control visibly changes a diagram, explanation, table, or comparison
* uses only real paper concepts, metrics, stages, parameters, or comparisons

If the paper lacks high-confidence quantitative results, explicitly state that the paper does not provide enough high-confidence quantitative results and build the interaction around qualitative mechanisms instead. Never invent data.

Choose an interaction that fits the paper: architecture explorer, training-stage switcher, result comparison, parameter-scale selector, formula breakdown, pipeline diagram, agent loop explorer, or benchmark dashboard.

## Step 7: Images

Try to extract figures:

```bash
mkdir -p ~/codex-papers/papers/{paper-slug}/images
python3 ./scripts/extract-images.py \
  ~/codex-papers/papers/{paper-slug}/paper.pdf \
  ~/codex-papers/papers/{paper-slug}/images
```

If useful figures are found, rename the most important ones descriptively, for example:

```text
images/architecture.png
images/training_pipeline.png
images/results_table.png
```

Do not invent or redraw figures unless the user asks for a new explanatory illustration.

## Step 8: Quality Gate

Before finishing, inspect every user-visible file:

```text
README.md
summary.md
insights.md
method.md
mental-model.md
reflection.md
qa.md
index.html
code/*
```

Verify:

* all required files exist
* `paper.pdf` exists
* `code/` contains at least one runnable demo
* `qa.md` contains Basic, Intermediate, and Advanced sections; default 15 questions, or 9-15 with an explicit reduction explanation
* Chinese requests produce primarily Chinese user-facing text
* proper nouns and technical terms are preserved
* no raw JSON, field names, evidence IDs, `Result 1`, `See evidence`, or parser labels appear
* no unsupported numeric claim appears
* `index.html` is self-contained and interactive

Run the validation script after generating the package:

```bash
node ./scripts/validate-study-package.js "{paper-slug-or-dir}" --lang zh --run-code
```

Use `--lang en` for English requests. If validation fails, fix the reported files and rerun it before responding. Warnings may be reported to the user when they reflect intentional trade-offs, such as a shorter QA set with an explanation.

Run the code demo if feasible. If it cannot be run, explain why in the final response and in `README.md` only if the limitation matters for future readers.

## Step 9: Web UI

The Web UI displays the generated files. It should not rely on facts or analysis cards as the default paper experience.

After generating or updating a paper package, use the sibling [paper-webui](../webui/SKILL.md) skill if the user asks to view it or if the local viewer needs to be restarted.

## Follow-Up Learning Loop

If the user asks deeper questions later, add new files in the same paper folder, for example:

```text
deep-dive-{topic}.md
math-derivation-breakdown.md
comparison-with-{paper-or-method}.md
extension-ideas.md
study-session-1.md
```

Keep these follow-up files grounded in the paper and clearly separate speculation from evidenced claims.
