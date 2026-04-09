<div align="center">

# Codex Paper

**Transform research papers into comprehensive learning environments**

[English](README.md) | [中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Codex Plugin Skeleton](https://img.shields.io/badge/Codex-Plugin-blue)](https://openai.com)

A research-paper study project that now includes a **Codex plugin skeleton** alongside the original implementation.

<table>
  <tr>
    <td align="center">
      <img src="assets/screenshot1.png" alt="Library View" width="100%"/>
      <br/>
      <sub>Library View - Browse and search your paper collection</sub>
    </td>
    <td align="center">
      <img src="assets/screenshot2.png" alt="Reading View" width="100%"/>
      <br/>
      <sub>Reading View - Study papers with rich formatting and math support</sub>
    </td>
  </tr>
</table>

</div>

## Features

- **Automatic PDF parsing** - Extract title, authors, abstract, and full content
- **Smart content truncation** - Handles large papers (50k char limit) intelligently
- **Code repository detection** - Automatically finds GitHub, arXiv, CodeOcean links
- **Adaptive learning materials** - Generates README, summary, insights, Q&A based on paper complexity
- **Code demonstrations** - Clean implementations with Jupyter notebooks and original code integration
- **Interactive web viewer** - Nuxt.js interface with math equation support (KaTeX)
- **Intelligent assessment** - Difficulty levels and paper type detection for adaptive content generation

---

## Codex Plugin Skeleton

This repository now includes a Codex-ready skeleton that preserves the current skills, hooks, parser scripts, and web viewer:

- Codex plugin root: `plugins/codex-paper/`
- Codex manifest: `plugins/codex-paper/.codex-plugin/plugin.json`
- Repo-local marketplace entry: `.agents/plugins/marketplace.json`
- Original source retained for reference: `plugin/`

The new Codex skeleton is additive: it keeps the original implementation intact while exposing a standard Codex plugin layout that we can keep iterating on.

---

## Quick Start

### Installation

Install from the Codex marketplace:

```bash
# Add the marketplace
/plugin marketplace add byxshr/codex-paper

# Install the plugin
/plugin install codex-paper

# Restart Codex for the plugin to take effect
```

**That's it!** The plugin will automatically:
- Install all dependencies (pdf-parse for PDF processing)
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
Help me study the paper at ~/Downloads/attention-is-all-you-need.pdf
```

You can also use URLs:

```
# Direct PDF URL
Help me study the paper at https://arxiv.org/pdf/1706.03762.pdf

# arXiv abstract URL (automatically converted to PDF)
Help me study the paper at https://arxiv.org/abs/1706.03762
```

Codex will automatically trigger the study workflow and:
1. Parse the PDF and extract metadata
2. Analyze paper complexity and type
3. Generate adaptive learning materials
4. Create code demonstrations (if applicable)
5. Extract and include original code (if available)
6. Extract key figures and images
7. Update the global search index
8. Launch the web viewer automatically

### Launch Web Viewer

```bash
/codex-paper:webui
```

Opens the interactive web interface at **http://localhost:5815** where you can:
- Browse all studied papers
- View generated materials with math rendering
- Access code demonstrations and notebooks
- Search through your paper library

---

## Paper Storage Structure

Papers are organized in `~/codex-papers/papers/{paper-slug}/`:

```
~/codex-papers/
├── papers/
│   └── {paper-slug}/
│       ├── paper.pdf                     # Original PDF file
│       ├── meta.json                     # Paper metadata (title, authors, etc.)
│       ├── README.md                     # Quick navigation and overview
│       ├── summary.md                    # Detailed summary
│       ├── insights.md                   # Key insights (most important!)
│       ├── method.md                     # Methodology (if complex)
│       ├── mental-model.md              # Paper categorization (if needed)
│       ├── reflection.md                # Future directions (if needed)
│       ├── qa.md                         # Learning questions
│       ├── index.html                    # Interactive HTML explorer
│       ├── images/                       # Extracted figures and tables
│       │   ├── fig1.png
│       │   └── fig2.png
│       └── code/                         # Code demonstrations
│           ├── core-demo.py              # Clean reference implementation
│           └── concept-demo.ipynb        # Interactive Jupyter notebook
│
└── index.json                           # Global search index
```

---

## Architecture

### Plugin Structure

```
codex-paper/
├── .codex-plugin/
│   └── marketplace.json              # Marketplace catalog entry
├── plugin/
│   ├── .codex-plugin/
│   │   └── plugin.json              # Plugin manifest
│   ├── skills/
│   │   └── study/
│   │       ├── SKILL.md             # Study workflow definition
│   │       └── scripts/
│   │           ├── parse-pdf.js    # PDF parsing utility
│   │           └── extract-images.py  # Image extraction
│   ├── commands/
│   │   └── webui.md                # /webui command
│   ├── hooks/
│   │   ├── hooks.json              # Session lifecycle hooks
│   │   └── check-install.sh        # Installation verification
│   ├── src/
│   │   └── web/                    # Nuxt.js web viewer
│   │       ├── components/         # Vue components
│   │       ├── composables/        # Vue composables
│   │       ├── server/             # API endpoints
│   │       └── package.json
│   └── package.json
└── README.md
```

### Key Components

1. **Study Skill** - Main workflow agent that orchestrates paper processing
2. **PDF Parser** - Extracts text, metadata, and code links using pdf-parse
3. **Image Extractor** - Python script for PDF figure extraction
4. **Web Viewer** - Nuxt.js application with Nitro API server
5. **Hooks System** - Automatic dependency installation and setup

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
```

This keeps the local workflow in one place while `scripts/common.sh` stays internal.

### Running Tests

```bash
# Test PDF parsing
node plugin/skills/study/scripts/parse-pdf.js /path/to/paper.pdf

# Test web viewer
cd plugin/src/web
npm run dev

# Test full workflow
cd /path/to/codex-paper
codex --plugin-dir ./plugin
/codex-paper:study /path/to/paper.pdf
```

### Building for Production

```bash
# Build web viewer
cd plugin/src/web
npm run build

# The built viewer will be in .output/
```

---

## Configuration

### Environment Variables

No configuration required! The plugin uses sensible defaults:

- **Papers directory**: `~/codex-papers/`
- **Web viewer port**: `5815`
- **Content limit**: `50,000` characters (with intelligent truncation)

### Advanced Customization

You can modify behavior by editing the skill file at:
`plugin/skills/study/SKILL.md`

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
- PDF parsing powered by [pdf-parse](https://github.com/ffalt/json2csv-converter)
- Web viewer built with [Nuxt.js](https://nuxt.com)
- Math rendering by [KaTeX](https://katex.org)
