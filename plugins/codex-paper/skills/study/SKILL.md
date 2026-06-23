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
visual-assets.md
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
evidence-ledger.json
facts.json
analysis.json
reasoning-analysis.json
meta.json
.codex-paper/reasoning-review.md
.codex-paper/validation-report.json
.codex-paper/answering-pack.md
```

Never copy JSON field names, extraction labels, or machine traces into user-facing files. Forbidden visible residues include `analysisVersion`, `evidenceRefs`, `coreClaims`, `keyResults`, `Result 1`, `See evidence`, parser object paths, raw JSON snippets, and template placeholders.

## V2 Evidence And Reasoning Contract

New packages are v2 packages. They must include:

```text
evidence-ledger.json
reasoning-analysis.json
meta.json with packageVersion = "2.0.0"
.codex-paper/reasoning-review.md
.codex-paper/validation-report.json
```

Default context mode is `paper-only`: do not browse the web, call external model APIs, use databases, or mix external claims into the paper evidence ledger. If the user explicitly asks to check official code, errata, or nearby literature, record those external facts in `.codex-paper/external-evidence.json`; never put them in `evidence-ledger.json`.

`analysis.json` is only a low-level hint. The final research reasoning authority is `reasoning-analysis.json`, which Codex fills after reading the paper evidence. Deterministic scripts may create evidence anchors, draft skeletons, and validation reports, but must not invent central claims, author reasoning paths, weakest assumptions, strongest counterexamples, or non-incremental follow-up ideas.

Use source types precisely:

* `paper_claim`: the paper states it; cite paper evidence.
* `literature_fact`: an external source states it; only allowed outside `paper-only`.
* `inference`: Codex derives it from paper evidence; use inferential wording.
* `speculation`: a research guess or proposed direction; never high confidence.

## Step 1: Prepare Evidence

Inputs supported:

* Local PDF path, for example `~/Downloads/paper.pdf`
* Direct PDF URL
* arXiv `/abs/` or `/pdf/` URL

Run the preparation entrypoint from the study skill directory:

```bash
node ./scripts/prepare-paper.js "<user-input>" --context paper-only --profile auto
```

The script resolves URLs, parses the PDF, copies `paper.pdf`, refreshes `~/codex-papers/index.json`, and writes:

```text
~/codex-papers/papers/{paper-slug}/paper-data.json
~/codex-papers/papers/{paper-slug}/evidence-ledger.json
~/codex-papers/papers/{paper-slug}/facts.json
~/codex-papers/papers/{paper-slug}/analysis.json
~/codex-papers/papers/{paper-slug}/meta.json
```

Treat these JSON files as evidence preparation only. They are not final study material.

## Step 2: Read Before Reasoning

Before creating or rewriting any final material, read:

* `paper-data.json`: title, authors, abstract, sections, links, parser warnings, quality flags, and `rawText`
* `evidence-ledger.json`: page text, section tree, evidence units, locations, roles, and quality downgrade markers
* `facts.json`: extracted claims, results, limitations, and evidence snippets
* `analysis.json`: low-level structured hints for problem, core idea, contributions, results, limitations, and open questions

If the available sections are sparse, inspect `paper-data.rawText` in chunks and search for method, experiment, results, ablation, limitation, conclusion, appendix, dataset, and metric terms. Prefer the paper text over derived artifacts whenever they conflict.

Assess:

* Difficulty: beginner, intermediate, advanced, or highly theoretical
* Paper type: theoretical, architecture, empirical, system, survey, benchmark, post-training, position, or other
* Method complexity: simple pipeline, multi-stage training, new architecture, mathematical derivation, agent system, or evaluation framework
* Evidence quality: complete enough, partial sections, missing abstract, noisy table extraction, or weak quantitative evidence

If parsing quality is limited, say so in `README.md` in natural language. Do not fill gaps with invented template content.

## Step 3: Select Profile And Scaffold Reasoning

Create the reasoning draft:

```bash
node ./scripts/scaffold-reasoning-analysis.js "~/codex-papers/papers/{paper-slug}" --context paper-only --profile auto
```

Then read the matching profile before filling any high-level analysis:

```text
profiles/empirical.md
profiles/theoretical.md
profiles/architecture.md
profiles/system.md
profiles/benchmark.md
profiles/survey.md
profiles/post-training.md
profiles/position.md
profiles/other.md
```

Use the profile to decide the appropriate validation kinds and reproduction artifact. Do not force experiments onto theoretical, survey, or position papers.

## Step 4: Fill And Validate Reasoning

Fill `reasoning-analysis.json` yourself after reading the evidence. Set `status` to `complete` only after all required analysis is real and evidence-grounded.

Required reasoning contents:

* 1-3 scoped central claims
* research question and importance
* prior-work gap and novelty boundary
* author reasoning path as a DAG, not a chapter outline
* core intuition and method model
* validations with question, design, observation, and conclusion
* weakest assumption, minimal reproduction, strongest counterexample, non-incremental follow-up idea, and uncertainty zones

Rules:

* Every `paper_claim` cites `ev-*` evidence.
* Every important `inference` cites evidence and uses inferential wording.
* Every numeric paper claim cites evidence containing the same number.
* Evidence gaps go into `uncertaintyZones`; never smooth them over with plausible text.
* `weakestAssumption` is one object, not a list.
* `minimalReproduction` includes both support and falsification criteria.
* `followUpIdea` must not be just more data, bigger models, or hyperparameter tuning.

Run:

```bash
node ./scripts/validate-reasoning.js "~/codex-papers/papers/{paper-slug}" --strict
```

Fix every error before writing user-facing materials. Review warnings and either fix them or explicitly reflect the limitation in the visible package. Complete `.codex-paper/reasoning-review.md` before authoring final Markdown and HTML.

## Step 5: Tags

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

## Step 6: Write The Complete Study Package

Codex must author these files directly from `reasoning-analysis.json` and the cited paper evidence. Do not use `render-from-analysis.js` as the final generator. That script is only a quick-summary fallback for the separate quick summary flow.

Ground every claim in `reasoning-analysis.json`, `evidence-ledger.json`, `paper-data.json`, `facts.json`, `analysis.json`, or direct `rawText` reading. Do not invent metrics, datasets, model sizes, ablations, code links, training stages, or conclusions. When mentioning quantitative results, use a natural source note such as `论文 p.8，Table 3` or `paper p.8, Table 3`; do not expose evidence IDs.

### Rich Media Policy

Use figures, tables, and diagrams to reduce reading effort, not to increase asset volume.

Allowed visual sources:

* original figures or tables extracted from the paper PDF
* structured Markdown/HTML tables rebuilt from evidenced paper values
* deterministic Mermaid, SVG, HTML, or CSS diagrams created from paper evidence
* high-resolution local crops produced from PDF vector content when the crop is readable and semantically correct

Do not use Codex image generation, imagegen, generated posters, generated covers, or AI-created bitmap pipeline figures in the default study workflow.

Insert visuals adaptively:

* architecture, system, and multi-stage training papers may need more visuals
* theoretical, short empirical, or position papers should stay more text-led
* no more than two visuals should appear back-to-back without explanatory prose
* every embedded visual must be next to the paragraph it clarifies
* every embedded visual needs a short caption or note explaining the source and what it helps readers understand
* original figure/table crops should include the target figure's own caption when it remains readable and does not pull in unrelated content
* before embedding or renaming a crop, check that it does not include neighboring prose, another figure/table caption, page headers, or unrelated page content
* page previews are navigation aids only; do not embed `*_page_preview.*`, `*preview.*`, or `navigation_only_*` assets in `README.md`, `summary.md`, or `method.md`
* when a PDF figure is vector-only and no reliable local crop is available, use a Mermaid/SVG/HTML teaching redraw in the body and list the page preview only in `visual-assets.md`

Prefer structured tables over screenshots when the paper values can be recovered safely. Use screenshots only when layout matters or table extraction is unreliable.

### README.md

Purpose: orientation and navigation.

Include:

* one-paragraph paper overview
* difficulty level and why
* recommended reading route
* estimated study time
* generated file map
* key takeaways
* a short note pointing to `visual-assets.md` when figures or tables are used
* parser or evidence limitations, if any

### visual-assets.md

Purpose: curated visual navigation and visual-quality record.

Include only high-value visual assets, not every extracted image.

For each selected asset, include:

* asset type: original figure/table crop, original figure/table crop with caption, structured table, Mermaid/SVG/HTML teaching redraw, or navigation-only page preview
* path or section where it appears
* source location: figure/table number, page, section, appendix, or natural paper location
* recommended reading location, such as README, summary, method, or index.html
* one short explanation of how it helps understanding

For navigation-only page previews, explicitly mark them as navigation-only and explain that they should not be inserted into body prose. Do not recommend navigation-only previews for `README.md`, `summary.md`, or `method.md`.

If no useful figure or table is available, explain why and mention whether a small evidence-grounded teaching diagram is used instead.

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
* a compact evidence-grounded Mermaid/SVG/HTML diagram if it clarifies the method

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

## Step 7: Code Demo

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

## Step 8: Interactive HTML Explorer

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
* includes a method overview, mechanism map, formula breakdown, or result dashboard
* includes source-type controls for paper claims, inferences, and speculations
* includes an author reasoning path view
* includes a reviewer view for weakest assumption, strongest counterexample, and falsification criteria
* the control visibly changes a diagram, explanation, table, or comparison
* uses only real paper concepts, metrics, stages, parameters, or comparisons

If the paper lacks high-confidence quantitative results, explicitly state that the paper does not provide enough high-confidence quantitative results and build the interaction around qualitative mechanisms instead. Never invent data.

Choose an interaction that fits the paper: architecture explorer, training-stage switcher, result comparison, parameter-scale selector, formula breakdown, pipeline diagram, agent loop explorer, or benchmark dashboard.

## Step 9: Visual Assets

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

After extraction:

* discard or ignore tiny fragments, decorative icons, duplicate crops, low-resolution previews, and low-information page previews
* keep only visuals that help explain the method, main results, architecture, formula, data construction, or evaluation
* write `visual-assets.md` as the curated index
* embed only readable local crops, structured tables, or deterministic teaching redraws near the relevant prose in `README.md`, `summary.md`, or `method.md`
* prefer local figure/table crops that include the target caption, but reject crops that include another figure's caption, page headers, or unrelated body prose
* avoid image dumps; if several visuals are useful, spread them across the reading path with explanatory text
* label deterministic redraws as `教学重绘` or `Explanatory redraw`
* keep full-page previews only as navigation-only entries in `visual-assets.md`

Do not invent paper figures. Do not use Codex image generation or bitmap image generation for pipeline figures in this workflow. If a new explanatory diagram is useful, create it as Mermaid, SVG, or self-contained HTML/CSS from evidenced paper concepts.

## Step 10: Answering Pack For Follow-Up Questions

Create a hidden local-only answering pack:

```text
~/codex-papers/papers/{paper-slug}/.codex-paper/answering-pack.md
```

This file is not a user-facing study material and should not appear in the Web UI file tree. It is a question-answering navigation layer for `$paper-chat`, so keep it concise, structured, and evidence-oriented. Do not copy raw JSON, machine field names, evidence IDs, or extraction labels.

Include:

* answering rules and the evidence priority: visible study files, answering pack, internal evidence JSON, then `paper-data.rawText` or original paper text
* sourceType rules: distinguish paper claims, external facts, analysis inferences, and research speculations
* core claim mapping and natural evidence locations
* paper problem map: problem, assumptions, method modules, experiment modules, limitations
* evidence index: key conclusions mapped to natural paper locations such as abstract, method section, experiment section, table, appendix, or conclusion
* weakest assumption, support criteria, falsification criteria, strongest counterexample, and uncertainty zones
* common follow-up hooks: why the method works, differences from related work, metric meanings, practical boundaries, implementation risks
* low-confidence zones: claims the paper does not provide, parser gaps, missing quantitative evidence, or questions that require rereading raw paper text

If parser quality is weak, record the weak areas naturally so `$paper-chat` knows when to read `paper-data.rawText` before answering.

## Step 11: Quality Gate

Before finishing, inspect every user-visible file:

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
code/*
```

Verify:

* all required files exist
* `paper.pdf` exists
* `visual-assets.md` exists and explains selected visuals or why no useful visuals were available
* `.codex-paper/answering-pack.md` exists for follow-up questions
* `code/` contains at least one runnable demo
* `qa.md` contains Basic, Intermediate, and Advanced sections; default 15 questions, or 9-15 with an explicit reduction explanation
* Chinese requests produce primarily Chinese user-facing text
* proper nouns and technical terms are preserved
* no raw JSON, field names, evidence IDs, `Result 1`, `See evidence`, or parser labels appear
* no unsupported numeric claim appears
* embedded visuals use existing local paths and have source/explanation text
* no Codex image generation, imagegen prompt, generated bitmap pipeline, cover, or poster appears in the package
* `index.html` is self-contained, interactive, and contains a paper-grounded method overview

Run the validation script after generating the package:

```bash
node ./scripts/validate-reasoning.js "{paper-slug-or-dir}" --strict
node ./scripts/validate-study-package.js "{paper-slug-or-dir}" --lang zh --run-code
```

Use `--lang en` for English requests. If validation fails, fix the reported files and rerun it before responding. Warnings may be reported to the user when they reflect intentional trade-offs, such as a shorter QA set with an explanation.

Run the code demo if feasible. If it cannot be run, explain why in the final response and in `README.md` only if the limitation matters for future readers.

## Step 12: Web UI

The Web UI displays the generated files. It should not rely on facts or analysis cards as the default paper experience.

After generating or updating a paper package, use the sibling [paper-webui](../webui/SKILL.md) skill if the user asks to view it or if the local viewer needs to be restarted.

The Web UI can ask follow-up questions through [paper-chat](../chat/SKILL.md). New study packages should include `.codex-paper/answering-pack.md` so those answers can recover the paper context quickly and remain grounded in evidence.

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
