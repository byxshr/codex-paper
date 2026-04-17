import fs from 'fs';

const reportPath = process.env.BENCHMARK_REPORT_FILE || '/tmp/codex-paper-benchmark.json';

if (!fs.existsSync(reportPath)) {
  console.error(`No benchmark report found at ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

console.log(`Report: ${reportPath}`);
console.log(`Generated: ${report.generatedAt}`);
console.log(`Benchmark directory: ${report.benchmarkDir}`);
console.log(`Passed: ${report.totals.passed}/${report.totals.papers}`);

for (const paper of report.papers) {
  console.log(`\n${paper.slug}`);
  console.log(`  status: ${paper.pass ? 'PASS' : 'FAIL'}`);
  if (paper.error) {
    console.log(`  error: ${paper.error}`);
    continue;
  }

  console.log(`  title: ${paper.parsed.title}`);
  console.log(`  authors: ${(paper.parsed.authors || []).join(', ') || '<none>'}`);
  console.log(`  pageCount: ${paper.parsed.pageCount}`);
  console.log(`  qualityFlags: ${(paper.parsed.qualityFlags || []).join(', ') || '<none>'}`);

  const failedChecks = Object.entries(paper.checks || {})
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (failedChecks.length > 0) {
    console.log(`  failedChecks: ${failedChecks.join(', ')}`);
  }
}
