import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parsePdf } from '../plugins/codex-paper/skills/study/scripts/parse-pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.join(__dirname, 'manifest.json');
const benchmarkDir = process.env.BENCHMARK_DIR || process.env.CODEX_PAPER_BENCHMARK_DIR || path.join(process.env.HOME || '', 'codex-papers', 'paper-examples');
const reportPath = process.env.BENCHMARK_REPORT_FILE || '/tmp/codex-paper-benchmark.json';

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanLink(link) {
  return String(link || '').replace(/[)>.,;:]+$/g, '');
}

function loadGold(slug) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'gold', `${slug}.json`), 'utf8'));
}

function evaluatePaper(parsed, gold) {
  const links = [...(parsed.githubLinks || []), ...(parsed.codeLinks || [])].map(cleanLink);
  const checks = {
    title: normalize(parsed.title) === normalize(gold.expectedTitle),
    authors: (gold.expectedPrimaryAuthors || []).some((author) =>
      (parsed.authors || []).some((parsedAuthor) => normalize(parsedAuthor).includes(normalize(author)))
    ),
    abstract: (gold.requiredAbstractPhrases || []).length === 0
      ? Boolean(parsed.abstract)
      : (gold.requiredAbstractPhrases || []).some((phrase) => normalize(parsed.abstract).includes(normalize(phrase))),
    pageCount: Number(parsed.pageCount) === Number(gold.expectedPageCount),
    links: (gold.requiredLinks || []).every((link) => links.includes(cleanLink(link))),
    forbiddenTitlePatterns: (gold.forbiddenTitlePatterns || []).every((pattern) => !(new RegExp(pattern, 'i')).test(parsed.title || '')),
    jsonShape: Boolean(parsed.title && parsed.pageCount && parsed.parserVersion)
  };

  return {
    checks,
    pass: Object.values(checks).every(Boolean)
  };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const papers = [];

  for (const entry of manifest.papers) {
    const pdfPath = path.join(benchmarkDir, entry.sourceFilename);
    const gold = loadGold(entry.slug);

    if (!fs.existsSync(pdfPath)) {
      papers.push({
        ...entry,
        pdfPath,
        error: `Missing PDF: ${pdfPath}`,
        pass: false
      });
      continue;
    }

    try {
      const parsed = await parsePdf(pdfPath);
      const evaluation = evaluatePaper(parsed, gold);
      papers.push({
        ...entry,
        pdfPath,
        parsed,
        ...evaluation
      });
    } catch (error) {
      papers.push({
        ...entry,
        pdfPath,
        error: error.message,
        pass: false
      });
    }
  }

  const totals = {
    papers: papers.length,
    passed: papers.filter((paper) => paper.pass).length,
    failed: papers.filter((paper) => !paper.pass).length
  };

  const report = {
    generatedAt: new Date().toISOString(),
    benchmarkDir,
    reportPath,
    totals,
    papers
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`Benchmark directory: ${benchmarkDir}`);
  console.log(`Report written to: ${reportPath}`);
  console.log(`Passed: ${totals.passed}/${totals.papers}`);

  for (const paper of papers) {
    console.log(`- ${paper.slug}: ${paper.pass ? 'PASS' : 'FAIL'}`);
    if (paper.error) {
      console.log(`  error: ${paper.error}`);
      continue;
    }

    for (const [name, value] of Object.entries(paper.checks)) {
      if (!value) {
        console.log(`  failed check: ${name}`);
      }
    }
  }

  process.exit(totals.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
