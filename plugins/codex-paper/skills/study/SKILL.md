---
name: paper-study
description: Use this skill when the user wants Codex to read, study, analyze, or deeply understand a research paper from a local PDF, direct PDF URL, or arXiv link, then generate a complete paper learning workspace with Markdown, HTML, code, images, and the original PDF.
---

# Paper Study Workflow

Use this skill for deep paper study, not quick summarization. The goal is a reusable learning environment authored by Codex after reading the paper evidence.

Detect the user's language from the request and write every user-facing material in that language. For Chinese requests, use Chinese prose except for proper nouns and established technical terms such as Qwen3, MoE, RAG, DUPO, Transformer, benchmark names, dataset names, and metric names.

## Core Contract

Author the complete study package inside a private generation workspace, then publish that exact validated workspace through the C2b publication gate. Treat the exact `workspaceId`, `workspaceDir`, and `paperDir` returned by `prepare-paper.js` as authoritative; never construct a path from the title slug and never select a "latest" workspace:

```text
{prepare-output.workspaceDir}/package/
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

Never copy JSON field names, extraction labels, or machine traces into user-facing files. Forbidden visible residues include `analysisVersion`, `evidenceRefs`, `coreClaims`, `keyResults`, parser object paths, raw JSON snippets, machine evidence IDs, and template placeholders.

## Existing Packages And Migration

Do not run or recreate the retired in-place migration flow. Explicit migration requires a verified paper-scoped backup and a private reviewable workspace:

```bash
bash ../../../../scripts/codex-paper.sh library-doctor --json
bash ../../../../scripts/codex-paper.sh backup-create "<paper-ref>" --json
bash ../../../../scripts/codex-paper.sh backup-verify "<backup-id>" --json
bash ../../../../scripts/codex-paper.sh migration-dry-run "<paper-ref>" --backup-id "<backup-id>" --json
bash ../../../../scripts/codex-paper.sh migration-start "<paper-ref>" --backup-id "<backup-id>" --json
```

The deprecated `migrate` command is only a `--dry-run` alias. Never pass or recommend `--force`, `--external-path`, or a package filesystem path. `migration-start` does not publish: use the exact returned workspace, author only through `workspace-write --actor codex`, run reasoning and complete standard validation, then call `migration-commit <migration-id-or-workspace> --json`. Only one migration may be active per paper; migrated `code/**` files are limited to 1 MiB each and other approved authoring files to 16 MiB. If start reports `MIGRATION_START_INCOMPLETE`, inspect and explicitly abandon the exact returned workspace before retrying. Never edit a sealed generation or bypass Evidence Alias validation. Use `migration-recover` after interruption. Rollback requires `migration-rollback <migration-id> --expected-current-manifest-hash <sha256>`; never guess a current or “latest” workspace.

## V2 Evidence And Reasoning Contract

New packages are v2 packages. They must include:

```text
evidence-ledger.json
reasoning-analysis.json
meta.json with packageVersion = "2.1.0"
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

Before preparation, verify the repository-managed runtime:

```bash
bash ../../scripts/runtime-python.sh -c 'import fitz, platform; assert platform.python_version() == "3.11.15"; assert fitz.__version__ == "1.28.0"'
```

If it is unavailable, stop and ask the user to provide CPython 3.11.15 for the explicit `runtime-setup` command. Never install a system Python, use global PyMuPDF, or run an unpinned `pip install`.

Inputs supported:

* Local PDF path, for example `~/Downloads/paper.pdf`
* Direct HTTPS PDF URL
* arXiv `/abs/` or `/pdf/` URL

Run the preparation entrypoint from the study skill directory. In a repository
checkout, use the root wrapper so the exact Node and managed Python gates run:

```bash
OUTPUT_LANG="zh"   # use en for an English request
bash ../../../../scripts/codex-paper.sh prepare "<user-input>" --workflow study --language "$OUTPUT_LANG" --context paper-only --profile auto \
  --authoring-provider unavailable --authoring-model unavailable
```

If the skill is running from an installed plugin cache where the repository
wrapper is absent, run `node ./scripts/prepare-paper.js ...` with the same
arguments. It still fails closed on runtime drift; do not invent a path to a
nonexistent root script.

The command requires the exact content runtime. If it reports
`PROVENANCE_RUNTIME_NONCONFORMANT`, do not bypass the gate. From this skill
directory in a repository checkout, inspect and provision with:

```bash
bash ../../../../scripts/codex-paper.sh runtime-status
bash ../../../../scripts/codex-paper.sh runtime-setup
```

If `../../../../scripts/codex-paper.sh` is absent in an installed plugin cache,
stop and ask the user to open the codex-paper repository checkout and run those
root commands there.

Preparation is identity-aware and workspace-only. A new generation is initialized under `PAPERS_DIR/.codex-paper/workspaces-v1/`; preparation itself does not create or change `paper.json`, `current.json`, the formal store, or `index.json`, and it is not visible in the Viewer. If the same generation already has an active workspace, preparation fails with `WORKSPACE_EXISTS` and names the exact workspace ID; resume it with `--resume-workspace <workspaceId>` or explicitly abandon it before retrying. A retained `failed` workspace remains inspectable but does not block a fresh prepare retry. `--resume` remains reserved for exact reuse of an already published generation. A changed fingerprint creates a distinct workspace and a changed source creates a new source revision proposal. Use `--new-revision` and `--reconcile-identity <route-slug>` only with their explicit identity intent. `--replace` remains rejected; publication switches the authoritative current generation only after validation.

The script resolves URLs, parses the PDF, copies `paper.pdf` into a private initialization directory, and atomically establishes the workspace. It returns the exact workspace and package paths and writes only inside that workspace:

```text
{prepare-output.paperDir}/paper-data.json
{prepare-output.paperDir}/evidence-ledger.json
{prepare-output.paperDir}/facts.json
{prepare-output.paperDir}/analysis.json
{prepare-output.paperDir}/meta.json
{prepare-output.paperDir}/.codex-paper/paper-identity.json
```

Treat these JSON files as evidence preparation only. They are not final study material.

For new packages, `facts.json` contains typed `resultClaims` plus a compatibility `keyResults` projection. Use the ResultClaim metric/value/location and its direct `ev-*` references when checking quantitative statements. Years, page/table labels, citations, versions, hardware counts, and training duration are not primary result values. Existing 2.0 packages may still contain `claim:n`, `result:n`, or `limitation:n`; readers resolve those in memory and must never rewrite a package merely because it was read.

PDF ingestion is fail-closed. Never replace the preparation entrypoint with `curl`, `wget`, a browser download, or direct in-process parser calls. Remote inputs must be HTTPS; the downloader revalidates every redirect, pins DNS to a public address, verifies the connected peer, enforces a 128 MiB stream budget, and requires `%PDF-` magic. Local inputs are copied through a private no-follow staging snapshot. The parser runs only through its bounded supervisor with wall/CPU/RSS/output and 2000-page limits. Encrypted, malformed, oversized, over-page, or resource-exhausting inputs fail and may be retained only in the private bounded `~/codex-papers/.quarantine/`; do not open or reuse quarantined files as trusted evidence.

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
node ./scripts/scaffold-reasoning-analysis.js "{prepare-output.paperDir}" --context paper-only --profile auto
```

The scaffold uses the shared workspace writer and returns SHA-256 values for both managed drafts. Retain those hashes for the next CAS update. Never edit a workspace file directly.

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

Use the profile to decide the appropriate validation kinds and reproduction artifact. Do not force experiments onto theoretical, survey, or position papers. For non-empirical profiles, interpret failure and falsification fields in the paper's own modality: proof-boundary checks for theory, taxonomy/coverage checks for surveys, argument-map or decision-consequence checks for position papers, and the smallest relevant artifact for mixed papers.

## Step 4: Fill And Validate Reasoning

Fill `reasoning-analysis.json` yourself after reading the evidence. Send the complete replacement through `workspace-cli.js write` using the scaffold's current SHA-256; do not use direct filesystem editing. Set `status` to `complete` only after all required analysis is real and evidence-grounded.

```bash
node ./scripts/workspace-cli.js write "{prepare-output.workspaceId}" reasoning-analysis.json \
  --stdin --expected-sha256 "{scaffold-output.reasoningSha256}" --actor codex
```

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
* `minimalReproduction` includes both support and falsification criteria; for non-empirical papers these may be formal, taxonomic, argumentative, or decision-oriented criteria rather than experiments.
* `strongestCounterexample.predictedObservation` means the most concrete thing that would be observed if the counterexample held; it can be a proof failure, misclassification, omitted cluster, or wrong decision, not only a metric change.
* `followUpIdea` must not be just more data, bigger models, or hyperparameter tuning.

Run:

```bash
node ./scripts/validate-reasoning.js "{prepare-output.paperDir}"
```

The reasoning gate writes a draft-phase Validation Report and must return `allow_authoring` before visible authoring begins. Fix every error before writing user-facing materials. Review warnings and either fix them or explicitly reflect the limitation in the visible package. Complete `.codex-paper/reasoning-review.md` before authoring final Markdown and HTML. `--strict` is an optional warning-blocking policy; it does not change the intrinsic report status or findings.

Finalize reasoning before Step 6. If reasoning changes after visible artifacts
have been written, regenerate every affected downstream Markdown, HTML, code,
and answering artifact through `workspace-cli.js write` so each event records
the new dependency hashes. Publication intentionally blocks stale downstream
dependencies and reports the affected artifact/dependency pairs.
The blocking diagnostic code is `PROVENANCE_DEPENDENCY_STALE`.

## Step 5: Tags

Infer exactly two semantic tags from the paper:

* exactly 2 tags
* each tag 1-3 words
* distinct and specific
* avoid generic tags such as `paper`, `research`, `ai`, `ml`
* prefer one domain/problem tag and one method/core-idea tag

Persist the proposed tags in the exact workspace publish intent. C2a must not touch the formal overlay or index:

```bash
node ./scripts/workspace-cli.js tags "{prepare-output.workspaceId}" --tag "<domain-tag>" --tag "<method-tag>"
```

## Step 6: Write The Complete Study Package

Codex must author these files from `reasoning-analysis.json` and the cited paper evidence, but every file creation or replacement must go through the shared workspace writer. Use `workspace-cli.js write <exact-workspace> <relative-path> --stdin --expect-absent --actor codex` for a first write and `--expected-sha256 ... --actor codex` for replacement. Never edit `paperDir` directly. Do not use `render-from-analysis.js` as the final generator; it is only a workspace-scoped quick-summary fallback.

`--depends-on <relative-path>` adds an artifact dependency; it never removes
the default dependencies. The total dependency limit is 64 after merging and
deduplicating defaults plus explicit values. For
`README.md`, the writer adds or refreshes the single provenance footer, so use
the SHA-256 returned by the writer—not a hash computed from the input bytes—for
the next CAS replacement.

If an interrupted write becomes ambiguous because the target was edited
outside the writer, normal authoring and publication stop with
`PROVENANCE_EVENT_UNRESOLVED`. Inspect the named event and either explicitly
adopt the current bytes with
`bash ../../../../scripts/codex-paper.sh provenance-resolve <workspace> --adopt-current <event-id>`
or abandon the workspace and prepare again. Adoption is permanently recorded
with an unknown actor and an `AUTHORING_EVENT_ADOPTED` diagnostic; it does not
silently certify who made the edit. Use `provenance-inspect <workspace> --json`
to obtain pending event IDs. If the root script is absent in an installed
plugin cache, stop and ask the user to perform recovery from the repository
checkout; do not edit the provenance draft directly. A missing target artifact
or recorded dependency cannot be adopted safely and requires abandoning and
preparing again.

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
{prepare-output.paperDir}/code/
```

Rules:

* Name the file after a core concept, not `demo.py` or `model_demo.py` unless that is truly specific.
* Make it self-contained and runnable independently.
* Use only Python/Node standard-library capabilities. Do not add `pip install`, `npm install`, package-manager bootstrap, or network-dependent setup instructions.
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
{prepare-output.paperDir}/index.html
```

Requirements:

* single self-contained HTML file
* inline CSS and JavaScript
* no external fetch, CDN, localStorage, remote fonts, or network dependency
* remains a self-contained interactive export for a future dedicated execution environment or direct user-controlled export workflow
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

Extract figures into a private external temporary directory, inspect them, then import only selected files through `workspace-cli.js write ... --from-file ... --expect-absent`. Never point `extract-images.py` at the workspace `images/` directory directly.

```bash
bash ../../scripts/runtime-python.sh ./scripts/extract-images.py \
  "{prepare-output.paperDir}/paper.pdf" \
  "<private-temporary-output>"
node ./scripts/workspace-cli.js write "{prepare-output.workspaceId}" "images/<selected-name>" \
  --from-file "<private-temporary-output>/<selected-file>" --expect-absent --actor codex
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
{prepare-output.paperDir}/.codex-paper/answering-pack.md
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
* no raw JSON, field names, evidence IDs, or parser labels appear
* no unsupported numeric claim appears
* embedded visuals use existing local paths and have source/explanation text
* no Codex image generation, imagegen prompt, generated bitmap pipeline, cover, or poster appears in the package
* `index.html` is self-contained, interactive, and contains a paper-grounded method overview

Run the validation scripts against the exact workspace package after generating the package:

```bash
node ./scripts/validate-reasoning.js "{paper-slug-or-dir}"
node ./scripts/validate-study-package.js "{paper-slug-or-dir}" --lang zh
```

Use `--lang en` for English requests. The final standard gate permits a complete `pass_with_warnings` package to publish when there are no errors; use `--strict` only when the user explicitly wants warnings to block. If validation fails, fix the reported files and rerun it before responding. Warnings must be visible to the user when they reflect parser limits, result conflicts, or intentional trade-offs.

Package validation is static and must never execute generated code. Do not invoke a demo merely because it was generated or because Docker happens to be available.

Only when the user explicitly asks to execute generated code:

1. Run `bash scripts/codex-paper.sh sandbox-plan "{paper-slug-or-dir}"` from the repository root.
2. Show the user every file, SHA-256, fixed command, mount/network/environment boundary, and resource limit printed by the plan.
3. Ask for explicit approval for that exact plan. Do not treat the original paper-study request as execution consent.
4. Only after approval, immediately run `bash scripts/codex-paper.sh sandbox-run "{paper-slug-or-dir}" --approval-token "<one-time-token>"`.

The CLI token proves plan integrity and single-use authorization; it does not authenticate a human. Human consent is a workflow boundary: stop after showing the plan and require a new, explicit user reply before running it. Never issue and consume a token in one uninterrupted turn. The token expires after five minutes and is single-use. If the plan does not issue a token, the supported Docker sandbox is unavailable or nonconformant; report that generated code was not executed. Never use Python, Node, a shell, `sandbox-exec`, bubblewrap, Podman, or another fallback directly on the host.

After a successful standard complete validation, publish the exact workspace. Publication rechecks the report hash, content runtime, authoring WAL, execution bindings and standard `allow_publish` gate while holding the full storage lock hierarchy, seals a Generation Manifest 2.0, commits `current.json`, and rebuilds the index:

```bash
bash ../../../../scripts/codex-paper.sh publish-workspace "{prepare-output.workspaceId}" --json
```

Do not publish a strict-blocked, draft, failed, abandoned, implicit, or different workspace. A successful command returns the manifest binding and route; only then describe the package as published or Viewer-visible. If publication is interrupted, preserve the workspace journal and run `publication-recover`; use `reindex` only to rebuild the non-authoritative index cache.

## Step 12: Web UI

The Web UI displays only generations selected by an authoritative `current.json`. An unpublished workspace is intentionally absent from Viewer routes and must not be described as available there.

`index.html` remains an interactive self-contained package artifact, but the current local Viewer deliberately does not execute its JavaScript or package CSS. The Viewer shows source by default and offers only an explicit scriptless static safe preview. Do not weaken that boundary or assume the Viewer is the execution environment for the interactive export.

After generating or updating a paper package, use the sibling [paper-webui](../webui/SKILL.md) skill if the user asks to view it or if the local viewer needs to be restarted.

The Web UI can ask follow-up questions through [paper-chat](../chat/SKILL.md). New study packages should include `.codex-paper/answering-pack.md` so those answers can recover the paper context quickly and remain grounded in evidence.

## Follow-Up Learning Loop

If the user asks deeper questions later, create or resume an exact generation workspace and add files through `workspace-cli.js write`; never mutate a published generation folder directly. Example authoring paths include:

```text
deep-dive-{topic}.md
math-derivation-breakdown.md
comparison-with-{paper-or-method}.md
extension-ideas.md
study-session-1.md
```

Keep these follow-up files grounded in the paper and clearly separate speculation from evidenced claims.
