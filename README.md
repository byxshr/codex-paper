<div align="center">

# Codex Paper

**Transform research papers into comprehensive learning environments**

[English](README.md) | [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Codex Plugin](https://img.shields.io/badge/Codex-Plugin-blue)](https://openai.com)

Codex Paper is a Codex plugin that turns research papers into local study workspaces. It first builds a paper-only evidence record and a structured reasoning analysis, then has Codex write grounded notes, explanations, code demos, visuals, an interactive page, and follow-up Q&A context from that evidence instead of templating raw parser output into study materials.

<table>
  <tr>
    <td align="center">
      <img src="assets/library.png" alt="Codex Paper library with search, tags, and collection index" width="100%"/>
      <br/>
      <sub>Library - Search, filter, and open saved paper study packages</sub>
    </td>
    <td align="center">
      <img src="assets/paper.png" alt="Paper study page with generated notes, reasoning analysis, and evidence audit" width="100%"/>
      <br/>
      <sub>Paper View - Read grounded notes, reasoning analysis, evidence audit, and follow-up context</sub>
    </td>
  </tr>
</table>

</div>

## Features

- **Automatic PDF parsing** - Extract title, authors, abstract, sections, and code links with a layered parser
- **Long-paper handling** - Parses large papers with quality flags and graceful fallbacks when extraction is incomplete
- **Code repository detection** - Automatically finds GitHub, arXiv, CodeOcean links
- **Evidence-first paper prep** - Generates internal evidence files such as `paper-data.json`, `facts.json`, and `analysis.json`
- **Evidence ledger** - Writes `evidence-ledger.json` with stable evidence IDs, page text, section trees, evidence units, natural locations, and parser quality degradations
- **Research reasoning analysis** - Adds `reasoning-analysis.json` for central claims, research question, author reasoning path, validations, weakest assumption, minimal reproduction, strongest counterexample, follow-up idea, and uncertainty zones
- **Semantic validation** - Checks schema, evidence references, source types, numeric grounding, reasoning graph cycles, critical-analysis coverage, and template residue
- **Context modes** - Defaults to offline `paper-only`; `canonical` and `literature` keep external evidence in `.codex-paper/external-evidence.json` instead of mixing it into the paper ledger
- **Parser benchmark suite** - Regressions are checked against a fixed 5-paper gold set
- **Reasoning and package benchmarks** - Adds deterministic fixtures for reasoning quality and visible study-package regressions
- **Codex-authored study package** - Produces `README.md`, `summary.md`, `insights.md`, `method.md`, `mental-model.md`, `reflection.md`, and `qa.md` from the paper and evidence
- **Curated visual learning path** - Adds `visual-assets.md` and embeds only high-value, source-labeled figures, tables, and deterministic diagrams where they support the prose
- **Code demonstrations** - Generates at least one independently runnable code example tied to the paper's core idea
- **Interactive web viewer** - Nuxt.js interface that shows user-facing materials by default, hides internal JSON, and renders each paper's `index.html` in an iframe
- **Ask Codex follow-ups** - Paper pages can send grounded follow-up questions to Codex and save answers in `chat-notes.md`
- **Intelligent assessment** - Difficulty levels and paper type detection for adaptive content generation

---

## Codex Plugin Layout

This repository is organized as a standard Codex plugin with the active implementation in `plugins/codex-paper/`:

- Codex plugin root: `plugins/codex-paper/`
- Codex manifest: `plugins/codex-paper/.codex-plugin/plugin.json`
- Repo-local marketplace entry: `.agents/plugins/marketplace.json`
- Historical source copy retained for reference: `plugin/`

Normal installation should use the marketplace entry that points at `plugins/codex-paper/`. The top-level `plugin/` directory is kept only as a reference copy and does not need to be selected during regular use.

Public names are intentionally explicit:

- Plugin name: `codex-paper`
- Deep study skill: `$paper-study`
- Quick summary skill: `$paper-summary`
- Web viewer skill: `$paper-webui`
- Follow-up Q&A skill: `$paper-chat`

---

## Quick Start

### Installation

Install by registering this repository as a Codex marketplace:

```bash
git clone https://github.com/byxshr/codex-paper.git ~/codex-paper
```

Add the marketplace and enable the plugin in `~/.codex/config.toml`:

```toml
[marketplaces.codex-paper]
source_type = "local"
source = "/Users/YOUR_USER/codex-paper"

[plugins."codex-paper@codex-paper"]
enabled = true
```

Replace `/Users/YOUR_USER/codex-paper` with the absolute path to your clone, then restart Codex. Open `/plugins`, search for `codex-paper`, and install or enable it from the plugin browser if prompted.

If you already installed an older Codex Paper plugin, update or reinstall it from `/plugins` after pulling this repository. Prefer the local marketplace entry that points at this checkout. If both an old `codex-paper@codex-paper` entry and a local `codex-paper@codex-paper-local` entry are enabled, disable the stale one so Codex loads the intended version.

After restart, use:

```text
Use $paper-study to read ~/Downloads/attention-is-all-you-need.pdf and generate a complete study package.
```

For a quick summary:

```text
Use $paper-summary to summarize https://arxiv.org/abs/1706.03762
```

**That's it!** The plugin will automatically:
- Install all dependencies (Node.js packages plus `PyMuPDF` for PDF processing)
- Create the papers directory at `~/codex-papers/`
- Initialize the search index
- Install web viewer dependencies

### System Requirements

- **Node.js**: 18.0.0 or higher
- **npm**: Comes with Node.js
- **Codex**: Latest version with plugin support
- **poppler-utils**: For PDF image extraction (install via system package manager)
  - **macOS**: `brew install poppler`
  - **Ubuntu/Debian**: `sudo apt-get install poppler-utils`
  - **Arch Linux**: `sudo pacman -S poppler`

---

## Usage

### Study a Research Paper

Simply talk to Codex to study a paper:

```
Use $paper-study to read ~/Downloads/attention-is-all-you-need.pdf and generate a complete study package.
```

You can also use URLs:

```
# Direct PDF URL
Use $paper-study to read https://arxiv.org/pdf/1706.03762.pdf

# arXiv abstract URL (automatically converted to PDF)
Use $paper-study to read https://arxiv.org/abs/1706.03762
```

For a quick summary only:

```
Use $paper-summary to summarize https://arxiv.org/abs/1706.03762
```

For follow-up questions about a saved study package:

```
Use $paper-chat to answer a question about ~/codex-papers/papers/attention-is-all-you-need:
What is the key difference between self-attention and recurrent sequence modeling?
```

Codex will automatically trigger the study workflow and:
1. Parse the PDF and prepare metadata, text, facts, analysis, and the evidence ledger
2. Infer the paper profile, scaffold `reasoning-analysis.json`, and read the relevant profile contract
3. Fill research reasoning from paper evidence, then run strict semantic validation before authoring visible materials
4. Author complete study materials from evidence instead of directly rendering machine JSON
5. Generate a self-contained interactive `index.html`
6. Create at least one independently runnable code demonstration
7. Copy the original `paper.pdf`, curate useful visual assets, and avoid dumping low-value extracted fragments into the reading flow
8. Create a hidden answering pack for future grounded follow-up questions
9. Update the global search index
10. Refresh the library index so the web viewer can show the package; start it with `$paper-webui` when needed

### Launch Web Viewer

```text
Use $paper-webui to start the Codex Paper web viewer.
```

Opens the interactive web interface at **http://localhost:5815** where you can:
- Browse all studied papers
- View generated Markdown, HTML, PDF, image, and code materials
- Explore each paper's `index.html` interactively in an iframe
- Access code demonstrations
- Ask Codex follow-up questions from a paper page and save answers to `chat-notes.md`
- Search through your paper library

Ask Codex lazily starts one long-running `codex mcp-server` worker the first time a web question is asked. The web viewer keeps a separate Codex thread per paper, so follow-up questions for the same paper reuse conversation context without starting a new `codex exec` process each time. Answers still run with a read-only sandbox and use `.codex-paper/answering-pack.md` when available, falling back to visible Markdown materials and local evidence files for older packages.

---

## Paper Storage Structure

Papers are organized in `~/codex-papers/papers/{paper-slug}/`:

```
~/codex-papers/
├── papers/
│   └── {paper-slug}/
│       ├── README.md                     # Quick navigation and overview
│       ├── visual-assets.md              # Curated figure/table guide with sources and reading placement
│       ├── summary.md                    # Detailed summary
│       ├── insights.md                   # Key insights (most important!)
│       ├── method.md                     # Method structure, flow, pseudocode, reproducibility risks
│       ├── mental-model.md              # Prior knowledge, research map, and paper categorization
│       ├── reflection.md                # Extensions, fragile assumptions, and future questions
│       ├── qa.md                         # Layered learning questions and answers
│       ├── chat-notes.md                 # Follow-up Q&A notes created by the Web UI
│       ├── index.html                    # Interactive HTML explorer
│       ├── paper.pdf                     # Copy of the original PDF
│       ├── evidence-ledger.json          # Internal paper-only evidence ledger
│       ├── reasoning-analysis.json       # Internal research reasoning contract
│       ├── images/                       # Curated extracted figures, tables, and necessary page previews
│       │   ├── fig1.png
│       │   └── fig2.png
│       ├── code/                         # Code demonstrations
│       │   └── core-concept-demo.py      # At least one runnable core-concept example
│
│       # The following JSON files are internal evidence files and hidden in the Web UI by default
│       ├── paper-data.json               # Canonical parsed paper facts
│       ├── facts.json                    # Evidence-first claims, results, limitations
│       ├── analysis.json                 # Structured analysis draft
│       ├── meta.json                     # Paper metadata (title, authors, etc.)
│
│       # Hidden local context for grounded follow-up answers
│       └── .codex-paper/
│           ├── answering-pack.md         # Evidence navigation pack for $paper-chat
│           ├── external-evidence.json    # Optional external evidence for canonical/literature modes
│           ├── reasoning-review.md       # Fixed self-review checklist
│           └── validation-report.json    # Latest validation report
│
└── index.json                           # Global search index
```

### Validation and Migration

Run the full deterministic suite:

```bash
bash scripts/codex-paper.sh install
bash scripts/codex-paper.sh test
bash scripts/codex-paper.sh benchmark-all
bash scripts/codex-paper.sh smoke-test
bash scripts/codex-paper.sh build
```

Validate one completed study package:

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js ~/codex-papers/papers/{paper-slug} --strict
node plugins/codex-paper/skills/study/scripts/validate-study-package.js ~/codex-papers/papers/{paper-slug} --run-code
```

Migrate an older package to draft evidence/reasoning files without inventing high-level analysis:

```bash
bash scripts/codex-paper.sh migrate ~/codex-papers/papers/{paper-slug}
```

Out-of-library package directories must be migrated explicitly:

```bash
bash scripts/codex-paper.sh migrate /path/to/package --external-path
```

Before filling the draft reasoning analysis, you can sanity-check the migrated package:

```bash
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js ~/codex-papers/papers/{paper-slug} --allow-draft
```

See the [evidence ledger](docs/evidence-ledger.md), [reasoning analysis](docs/reasoning-analysis.md), [package contract](docs/package-v2.md), and [migration guide](docs/migration-v1-to-v2.md) docs for the detailed package contracts.

---

## Architecture

### Plugin Structure

```
codex-paper/
├── .codex-plugin/
│   └── marketplace.json              # Marketplace catalog entry
├── plugin/                           # Legacy copy kept for reference
├── plugins/
│   └── codex-paper/
│       ├── .codex-plugin/
│       │   └── plugin.json              # Plugin manifest
│       ├── skills/
│       │   ├── study/
│       │   │   ├── SKILL.md             # Study workflow definition
│       │   │   └── scripts/
│       │   │       ├── parse-pdf.js     # Stable JSON parser
│       │   │       ├── prepare-paper.js # Canonical paper preparation pipeline
│       │   │       └── extract-images.py
│       │   ├── summary/
│       │   │   └── SKILL.md             # Evidence-constrained quick summary
│       │   ├── chat/
│       │   │   └── SKILL.md             # Grounded follow-up Q&A
│       │   └── webui/
│       │       └── SKILL.md             # Local viewer launcher
│       ├── hooks/
│       │   ├── hooks.json               # Session lifecycle hooks
│       │   └── check-install.sh
│       ├── src/
│       │   └── web/                     # Nuxt.js web viewer
│       └── package.json
├── benchmarks/
│   ├── manifest.json                    # Fixed parser benchmark set
│   ├── gold/                            # Gold expectations for the 5 papers
│   ├── reasoning/                       # Reasoning validator fixtures
│   ├── packages/                        # Visible package quality fixtures
│   ├── run-benchmark.mjs                # Benchmark executor
│   ├── run-reasoning-benchmark.mjs      # Reasoning benchmark entrypoint
│   ├── run-package-benchmark.mjs        # Package benchmark entrypoint
│   └── benchmark-report.mjs             # Human-readable report formatter
└── README.md
```

### Key Components

1. **Study Skill** - Codex paper-reading and writing agent that generates the full study package
2. **PDF Parser** - Uses a layered `PyMuPDF`-first parser with `pdf-parse` fallback and stable JSON output
3. **Image Extractor** - Python script for PDF figure extraction
4. **Preparation Pipeline** - Produces internal evidence files `paper-data.json`, `facts.json`, `analysis.json`, `meta.json`, and `evidence-ledger.json`, then updates `~/codex-papers/index.json`
5. **Research Reasoning Validation** - Uses `reasoning-analysis.json`, paper profiles, and `validate-reasoning.js` to check evidence refs, source types, numeric grounding, reasoning DAGs, and critical analysis
6. **Web Viewer** - Nuxt.js application with Nitro APIs that displays user materials by default, hides machine JSON, and shows evidence audit and reasoning views
7. **Ask Codex API** - Reuses a long-running Codex MCP worker for grounded follow-up questions, then appends answers to `chat-notes.md`
8. **Hooks System** - Automatic dependency installation and setup

---

## Development

### One Entry Script

Use a single root script for local setup and testing:

```bash
bash scripts/codex-paper.sh install
bash scripts/codex-paper.sh build
bash scripts/codex-paper.sh start
bash scripts/codex-paper.sh stop
bash scripts/codex-paper.sh status
bash scripts/codex-paper.sh smoke-test
bash scripts/codex-paper.sh benchmark
bash scripts/codex-paper.sh benchmark-all
bash scripts/codex-paper.sh benchmark-report
```

This keeps the local workflow in one place while `scripts/common.sh` stays internal.

### Running Tests

```bash
# Test PDF parsing
node plugins/codex-paper/skills/study/scripts/parse-pdf.js /path/to/paper.pdf

# Prepare a paper into paper-data.json, facts.json, and evidence-ledger.json
node plugins/codex-paper/skills/study/scripts/prepare-paper.js /path/to/paper.pdf

# Validate research reasoning
node plugins/codex-paper/skills/study/scripts/validate-reasoning.js paper-slug --strict

# Validate a generated study package
node plugins/codex-paper/skills/study/scripts/validate-study-package.js paper-slug --lang zh --run-code

# Run parser, reasoning, and package benchmarks
bash scripts/codex-paper.sh benchmark-all

# Test web viewer
bash scripts/codex-paper.sh start
```

### Building for Production

```bash
# Build web viewer
bash scripts/codex-paper.sh build

# The built viewer will be in plugins/codex-paper/src/web/.output/
```

---

## Configuration

### Environment Variables

No configuration required! The plugin uses sensible defaults:

- **Papers directory**: `~/codex-papers/`
- **Benchmark directory**: `~/codex-papers/paper-examples`
- **Web viewer port**: `5815`
- **Long-paper behavior**: extraction quality flags and fallbacks are recorded in the generated package

### Advanced Customization

You can modify behavior by editing:

- `plugins/codex-paper/skills/study/SKILL.md`
- `plugins/codex-paper/skills/summary/SKILL.md`
- `benchmarks/gold/*.json`

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Add tests if applicable
5. Commit your changes (`git commit -m 'add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

---

## License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- Built for Codex
- PDF parsing powered by [PyMuPDF](https://pymupdf.readthedocs.io/) with [pdf-parse](https://www.npmjs.com/package/pdf-parse) fallback
- Web viewer built with [Nuxt.js](https://nuxt.com)
- Math rendering by [KaTeX](https://katex.org)
- Inspired by [alaliqing/claude-paper](https://github.com/alaliqing/claude-paper/) and [FeijiangHan/PaperForge](https://github.com/FeijiangHan/PaperForge)
