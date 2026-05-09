---
name: paper-chat
description: Use this skill when the user asks a follow-up question about an existing Codex Paper study package, wants to discuss a paper already saved under ~/codex-papers/papers, or asks for an evidence-grounded answer from generated paper learning materials.
---

# Paper Chat Workflow

Use this skill for follow-up questions about a paper that already has a Codex Paper study package. The goal is a grounded answer, not a new study package.

## Inputs

Accept either:

* a paper package directory, for example `~/codex-papers/papers/{paper-slug}`
* a paper slug, resolved as `~/codex-papers/papers/{paper-slug}`
* a Web UI prompt that includes the package directory, current file, and user question

If the package does not exist, tell the user to run `$paper-study` first.

## Evidence Ladder

Answer using this order. Only move to the next layer when the current layer cannot answer the question well enough.

1. User-visible study materials:
   `README.md`, `summary.md`, `insights.md`, `method.md`, `mental-model.md`, `reflection.md`, `qa.md`, `index.html`, `chat-notes.md`, and relevant files under `code/` or `images/`.
2. Hidden answering pack:
   `.codex-paper/answering-pack.md`.
3. Internal evidence:
   `facts.json`, `analysis.json`, `paper-data.json`.
4. Original paper text:
   search `paper-data.rawText` or read `paper.pdf` text if local tools make that feasible.

Never use live web search unless the user explicitly asks for external research. The default is local-only paper evidence.

## Answer Rules

* Match the user's language. For Chinese questions, answer in Chinese except for proper nouns and established technical terms.
* Be explicit about confidence. If the package or paper does not contain enough evidence, say what is missing.
* Do not invent metrics, dataset names, experimental results, equations, model sizes, ablations, code links, or paper claims.
* Cite sources naturally, such as `基于 summary.md` or `根据实验部分`, without exposing evidence IDs.
* Do not expose JSON field names, parser paths, extraction labels, raw object snippets, or machine residues such as `analysisVersion`, `evidenceRefs`, `coreClaims`, `Result 1`, or `See evidence`.
* If the user asks for speculation, clearly separate evidenced conclusions from hypotheses.

## Direct Use

When answering inside Codex, respond in the chat. Do not write to the paper package unless the user explicitly asks you to save the answer.

When the Web UI invokes this workflow, the Web UI appends the final answer to `chat-notes.md`; you should only produce the final answer text.
