import fs from 'fs';

const reportPath = process.env.BENCHMARK_REPORT_FILE || '/tmp/codex-paper-benchmark.json';
const mandatoryReportPath = process.env.MANDATORY_BENCHMARK_REPORT_FILE || '/tmp/codex-paper-mandatory-benchmark.json';

if (fs.existsSync(mandatoryReportPath)) {
  const mandatory = JSON.parse(fs.readFileSync(mandatoryReportPath, 'utf8'));
  console.log(`Mandatory report: ${mandatoryReportPath}`);
  console.log(`Generated: ${mandatory.generatedAt}`);
  console.log(`Declared: ${mandatory.totals.declared}; executed: ${mandatory.totals.executed}; completed: ${mandatory.totals.completed}; passed: ${mandatory.totals.passed}; failed: ${mandatory.totals.failed}`);
  for (const fixture of mandatory.fixtures || []) {
    console.log(`  ${fixture.fixtureId}: ${fixture.pass ? 'PASS' : 'FAIL'}`);
    console.log(`    observed expected findings: ${(fixture.observedFindings || []).join(', ') || '<none>'}`);
  }
  console.log('');
} else {
  console.log(`No mandatory benchmark report found at ${mandatoryReportPath}`);
  console.log('');
}

if (!fs.existsSync(reportPath)) {
  console.error(`No benchmark report found at ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

console.log(`Optional external report: ${reportPath}`);
console.log(`Generated: ${report.generatedAt}`);
console.log(`Benchmark directory: ${report.benchmarkDir}`);
console.log(`Passed: ${report.totals.passed}/${report.totals.papers}`);
if (report.totals.skipped > 0) {
  console.log(`Skipped: ${report.totals.skipped}/${report.totals.papers}`);
}

for (const paper of report.papers) {
  console.log(`\n${paper.slug}`);
  console.log(`  status: ${paper.skipped ? 'SKIP' : paper.pass ? 'PASS' : 'FAIL'}`);
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
