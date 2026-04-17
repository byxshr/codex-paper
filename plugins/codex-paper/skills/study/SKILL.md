---
name: study
description: Use this skill when the user wants to read, study, analyze, or deeply understand a research paper from a local PDF, direct PDF URL, or arXiv link.
---

# Paper Study Workflow

Invoke this skill with a paper PDF path.

**Language Detection**: Detect the user's language from their input and generate ALL materials in that language.
- Example: User says "我们学习一下这篇论文吧" → Generate materials in Chinese
- Example: User says "Let's study this paper" → Generate materials in English

---

# Core Philosophy

Primary Objective:
Facilitate deep conceptual understanding and research-level thinking.

Secondary Objective:
Create a structured, reusable paper knowledge system.

This workflow is not just for summarizing — it builds a learning environment around the paper.

---

# Step 0: Check Local Tooling

Before processing a paper, make sure the plugin dependencies are available:

* Install Node dependencies from [package.json](../../package.json) if they are missing.
* Ensure Python can run [extract-images.py](./scripts/extract-images.py), ideally with `pymupdf` installed.
* Ensure the paper library root exists at `~/codex-papers/papers/`.

---

# Step 1: Prepare the Paper Workspace

Supports multiple input formats:

* **Local path**: `~/Downloads/paper.pdf`
* **Direct PDF URL**: `https://arxiv.org/pdf/1706.03762.pdf`
* **arXiv URL**: `https://arxiv.org/abs/1706.03762`

Use the single preparation entrypoint:

```bash
USER_INPUT="<user-input>"
node ./scripts/prepare-paper.js "$USER_INPUT"
```

The preparation script will resolve URLs when needed, parse the PDF, and write:

* title
* authors
* abstract
* sections (`abstract`, `introduction`, `conclusion`)
* parser warnings
* quality flags
* githubLinks
* codeLinks
* `paper-data.json`
* `facts.json`
* refreshed `meta.json`
* refreshed `~/codex-papers/index.json`

```
~/codex-papers/papers/{paper-slug}/paper-data.json
~/codex-papers/papers/{paper-slug}/facts.json
```

---

# Step 2: Assess Paper Before Generating Materials

Before generating any files, evaluate:

1. Difficulty Level

   * Beginner
   * Intermediate
   * Advanced
   * Highly Theoretical

2. Paper Nature

   * Theoretical
   * Architecture-based
   * Empirical-heavy
   * System design
   * Survey

3. Methodological Complexity

   * Simple pipeline
   * Multi-stage training
   * Novel architecture
   * Heavy mathematical derivation

This assessment determines:

* Whether to create method.md
* Whether to create .ipynb
* Explanation depth
* Code demo complexity

---

# Step 2.5: Generate Exactly 2 Semantic Tags (Mandatory)

Before generating files, infer exactly 2 tags from semantic understanding of the paper.

Rules:

* Generate exactly 2 tags, no more and no less
* Tags must be distinct
* Each tag should be short (1-3 words)
* Avoid generic tags: `paper`, `research`, `ai`, `ml`
* Prefer one tag for problem/domain and one for method/core idea

Examples:

* `machine translation`, `self-attention`
* `3d detection`, `bev transformer`
* `protein folding`, `structure prediction`

Persist these 2 tags in both locations:

* `~/codex-papers/papers/{paper-slug}/meta.json` as `tags`
* `~/codex-papers/index.json` entry as `tags`

---

# Step 3: Generate Core Study Materials

Create folder:

```
~/codex-papers/papers/{paper-slug}/
```

---

## Required Files

All generated explanations must be grounded in `paper-data.json` and `facts.json`.

Rules:

* Do not invent metrics, claims, or links that are not present in those files
* Any quantitative result must include a `Source:` note with the section name from `facts.json`
* If `qualityFlags` contains `abstract_missing` or `sections_partial`, explicitly mention the parser limitation in `README.md`

### README.md

* What the paper is about (one paragraph)
* Difficulty level
* How to navigate materials
* Key takeaways
* Estimated study time
* Folder structure overview

---

### summary.md

* Background context
* Problem statement
* Main contributions
* Key results
* Quantitative metrics

---

### insights.md (Most Important)

* Core idea explained plainly
* Why this works
* What conceptual shift it introduces
* Trade-offs
* Limitations
* Comparison to prior work
* Practical implications

---

### qa.md

15 questions:

* 5 basic
* 5 intermediate
* 5 advanced

Use this format:

```markdown
### Question

<details>
<summary>Answer</summary>

Detailed explanation.

</details>

---
```

---

## Conditional Files

### method.md (Recommended for most papers)

Include:

* Component breakdown
* Algorithm flow
* Architecture diagram (ASCII if needed)
* Step-by-step explanation
* Pseudocode (balanced with explanation)
* Implementation pitfalls
* Hyperparameter sensitivity
* Reproduction risks

---

### mental-model.md (Recommended for most papers)

* What type of problem is this?
* What prior knowledge is assumed?
* How it fits into the broader research map
* How to mentally categorize this work

---

### reflection.md (Optional auto-generated)

* If I were to extend this paper
* What open problems remain
* What assumptions are fragile
* Where it might fail in practice

---

# Step 4: Code Demonstrations (Mandatory)

At least one runnable demo must be created.

**All code demos must be placed in:**
```
~/codex-papers/papers/{paper-slug}/code/
```

Create the code directory first:

```bash
mkdir -p ~/codex-papers/papers/{paper-slug}/code
```

Guidelines:

* Self-contained
* Runnable independently
* Educational comments (explain why)
* Focus on core contribution
* Prefer clarity over completeness

Possible types:

* Simplified conceptual implementation
* Visualization script
* Minimal architecture demo
* Interactive notebook (.ipynb)

Name descriptively:

* model_demo.py
* vectorized_planning_demo.py
* contrastive_loss_visualization.ipynb

Avoid generic names.

---

# Step 5: Generate Interactive HTML Explorer

Create a single self-contained HTML file for interactively exploring the paper's core concepts.

**Output path:**
```
~/codex-papers/papers/{paper-slug}/index.html
```

## Requirements

* Single HTML file, all CSS/JS inline, zero external dependencies
* Uses **real data from the paper** (actual metrics, hyperparameters, comparisons) — never invent numbers
* Must work in a sandboxed iframe (no external fetches, no localStorage)

## Guidelines

Choose the interaction pattern that best fits the paper — architecture diagrams, parameter explorers, result dashboards, formula breakdowns, comparison matrices, etc. Let the paper's content dictate the format rather than forcing a fixed layout, focusing on the core ideas of the paper.

Every interactive control (slider, toggle, dropdown) should visibly change the visualization. Include brief explanatory text alongside interactive elements to teach concepts.

---

# Step 6: Extract Images

```bash
mkdir -p ~/codex-papers/papers/{paper-slug}/images

python3 ./scripts/extract-images.py \
  paper.pdf \
  ~/codex-papers/papers/{paper-slug}/images
```

Rename key images descriptively:

* architecture.png
* training_pipeline.png
* results_table.png

---

# Step 7: Update Index

**CRITICAL**: Read existing index.json first, then append the new paper. Never overwrite the entire file.

If index.json does not exist, create:

```json
{"papers": []}
```

Append new entry to the papers array:

```json
{
  "id": "paper-slug",
  "title": "Paper Title",
  "slug": "paper-slug",
  "authors": ["Author 1", "Author 2"],
  "abstract": "Paper abstract...",
  "year": 2024,
  "date": "2024-01-01",
  "tags": ["tag-1", "tag-2"],
  "githubLinks": ["https://github.com/..."],
  "codeLinks": ["https://..."]
}
```
**IMPORTANT**: The index.json file must be located at:
```
~/codex-papers/index.json
```

---


# Step 8: Relaunch Web UI

After updating the library, invoke the sibling [webui](../webui/SKILL.md) skill so the local viewer is rebuilt or restarted if needed.


# Step 9: Interactive Deep Learning Loop

After all files are generated:

## Present to User:

1. Ask:

   * What part is still unclear?
   * Do you want deeper mathematical breakdown?
   * Do you want implementation-level analysis?
   * Do you want comparison with another paper?

2. Allow user to:

   * Ask deeper questions
   * Summarize their understanding
   * Propose new ideas

---

## If user asks deeper questions:

Generate a new file inside the same folder:

Examples:

* deep-dive-contrastive-loss.md
* math-derivation-breakdown.md
* comparison-with-transformers.md
* extension-ideas.md

---

## If user provides their own summary:

1. Refine it.
2. Improve structure.
3. Save as:

* user-summary-v1.md

If iterated:

* user-summary-v2.md

---

## If user wants structured consolidation:

Create:

* consolidated-notes.md
* study-session-1.md
* exam-review.md

---

This makes the paper folder a growing knowledge node.

---
