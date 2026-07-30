import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { checkRepository } from '../check-repository.mjs'

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const BASELINE = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/contracts/s0-contract-baseline.json'), 'utf8'))
const SENTINELS = [
  'plugins/codex-paper/.codex-plugin/plugin.json',
  'plugins/codex-paper/package.json',
  'plugins/codex-paper/package-lock.json',
  'plugins/codex-paper/skills/study/SKILL.md',
  'plugins/codex-paper/skills/study/scripts/sandbox-code.js',
  'plugins/codex-paper/skills/study/scripts/download-pdf.cjs',
  'plugins/codex-paper/skills/study/scripts/parse-pdf.js',
  'plugins/codex-paper/skills/study/scripts/tests/parse-pdf-compat.test.mjs',
  'plugins/codex-paper/skills/study/scripts/tests/parse-pdf-title.test.mjs',
  'plugins/codex-paper/skills/study/scripts/pdf-parser-launcher.py',
  'plugins/codex-paper/skills/study/scripts/pdf-parser-worker.js',
  'plugins/codex-paper/skills/study/scripts/pdf-security-policy.json',
  'plugins/codex-paper/skills/study/scripts/prepare-paper.js',
  'plugins/codex-paper/skills/study/scripts/extract-facts.js',
  'plugins/codex-paper/skills/study/scripts/validate-study-package.js',
  'plugins/codex-paper/skills/study/scripts/validation-report.js',
  'plugins/codex-paper/skills/study/scripts/paper-identity.js',
  'plugins/codex-paper/skills/study/scripts/tests/prepare-paper-identity.test.mjs',
  'plugins/codex-paper/skills/study/scripts/tests/paper-identity.test.mjs',
  'plugins/codex-paper/skills/study/scripts/migrate-package.js',
  'plugins/codex-paper/skills/study/schemas/facts-2.1.schema.json',
  'plugins/codex-paper/skills/study/schemas/validation-report-1.0.schema.json',
  'plugins/codex-paper/skills/study/schemas/paper-identity-1.0.schema.json',
  'plugins/codex-paper/skills/study/generation-contract-1.0.json',
  'plugins/codex-paper/skills/summary/SKILL.md',
  'plugins/codex-paper/src/shared/package-compatibility.mjs',
  'plugins/codex-paper/src/shared/paper-library.mjs',
  'plugins/codex-paper/skills/study/schemas/paper-current-1.0.schema.json',
  'plugins/codex-paper/skills/study/schemas/paper-record-1.0.schema.json',
  'plugins/codex-paper/skills/study/schemas/paper-overlay-1.0.schema.json',
  'plugins/codex-paper/skills/study/schemas/generation-workspace-1.0.schema.json',
  'plugins/codex-paper/src/shared/generation-workspace.mjs',
  'plugins/codex-paper/src/shared/storage-transaction.mjs',
  'plugins/codex-paper/src/shared/workspace-writer.mjs',
  'plugins/codex-paper/skills/study/scripts/workspace-cli.js',
  'plugins/codex-paper/skills/study/scripts/publication-cli.js',
  'plugins/codex-paper/skills/study/schemas/generation-manifest-1.0.schema.json',
  'plugins/codex-paper/skills/study/schemas/publication-transaction-1.0.schema.json',
  'plugins/codex-paper/src/shared/generation-manifest.mjs',
  'plugins/codex-paper/src/shared/generation-publication.mjs',
  'plugins/codex-paper/src/web/nuxt.config.ts',
  'plugins/codex-paper/runtime/python/requirements.lock',
  'plugins/codex-paper/src/web/server/utils/librarySecurity.mjs',
  'plugins/codex-paper/src/web/server/utils/packageCompatibility.mjs',
  'plugins/codex-paper/src/web/server/utils/storedPackageCompatibility.mjs',
  'plugins/codex-paper/src/web/server/api/papers/[slug]/validation.get.ts',
  'plugins/codex-paper/sandbox/Dockerfile',
  'plugins/codex-paper/sandbox/policy.json',
  'plugins/codex-paper/scripts/start-webui.sh',
  'plugins/codex-paper/src/web/package.json',
  'plugins/codex-paper/hooks/hooks.json',
  '.agents/plugins/marketplace.json',
  'docs/contracts/s0-contract-baseline.json',
  'README.md',
  'README.zh-CN.md',
  '.github/workflows/ci.yml',
  'security/runtime-baseline.json',
  'security/dependency-policy.json',
  'security/secret-scan-policy.json',
  'security/supply-chain-review.json',
  'scripts/codex-paper.sh',
  'scripts/common.sh',
  'scripts/runtime-policy.mjs',
  'scripts/dependency-audit.mjs',
  'scripts/secret-scan.mjs',
  'scripts/supply-chain-check.mjs',
  'scripts/tests/library-layout.test.mjs',
  'scripts/tests/storage-transaction.test.mjs',
  'scripts/tests/generation-publication.test.mjs',
  'benchmarks/run-mandatory-benchmark.mjs',
  'benchmarks/mandatory/run-fixture.mjs',
  'benchmarks/mandatory/contract.mjs',
  'benchmarks/mandatory/authoring-boundary.mjs',
  'benchmarks/mandatory/manifest.json',
  'benchmarks/mandatory/gold/front-matter-noise.json',
  'benchmarks/mandatory/gold/result-conflict.json',
  'benchmarks/fixtures/generate-pdf-fixtures.py',
  'benchmarks/fixtures/pdf/front-matter-noise.pdf',
  'benchmarks/fixtures/pdf/front-matter-noise.pdf.manifest.json',
  'benchmarks/fixtures/pdf/result-conflict.pdf',
  'benchmarks/fixtures/pdf/result-conflict.pdf.manifest.json',
]

function write(root, path, content = '') {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function makeFixture() {
  const root = mkdtempSync('/tmp/codex-paper-repo-check-')
  const generationContract = JSON.parse(readFileSync(join(REPO_ROOT, 'plugins/codex-paper/skills/study/generation-contract-1.0.json'), 'utf8'))
  const contractFiles = [...generationContract.common, ...generationContract.workflows.study, ...generationContract.workflows.summary]
    .map((path) => `plugins/codex-paper/${path}`)
  const fixtureFiles = [...new Set([...SENTINELS, ...contractFiles])]
  for (const path of fixtureFiles) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true })
  }
  for (const schema of BASELINE.schemas) {
    mkdirSync(dirname(join(root, schema.path)), { recursive: true })
    cpSync(join(REPO_ROOT, schema.path), join(root, schema.path), { recursive: true })
  }
  const trackedFiles = [...fixtureFiles, ...BASELINE.schemas.map((schema) => schema.path)]
  return {
    root,
    trackedFiles,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function withFixture(callback) {
  const fixture = makeFixture()
  try {
    callback(fixture)
  } finally {
    fixture.cleanup()
  }
}

function errorsFor(fixture) {
  return checkRepository({ repoRoot: fixture.root, trackedFiles: fixture.trackedFiles }).errors.join('\n')
}

test('canonical repository contract passes', () => withFixture((fixture) => {
  assert.deepEqual(checkRepository({ repoRoot: fixture.root, trackedFiles: fixture.trackedFiles }).errors, [])
}))

test('CLI rejects missing, duplicate, and unknown option values', () => {
  const scriptPath = join(REPO_ROOT, 'scripts/check-repository.mjs')
  const cases = [
    {
      argv: ['--active-plugin-relative', '--repo-root', REPO_ROOT],
      expected: /--active-plugin-relative requires a value/,
    },
    {
      argv: ['--repo-root', REPO_ROOT, '--repo-root', REPO_ROOT],
      expected: /duplicate option: --repo-root/,
    },
    {
      argv: ['--unsupported', 'value'],
      expected: /unknown option: --unsupported/,
    },
  ]

  for (const testCase of cases) {
    const result = spawnSync(process.execPath, [scriptPath, ...testCase.argv], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, testCase.expected)
  }
})

test('legacy tree and redundant manifests fail', () => withFixture((fixture) => {
  write(fixture.root, 'plugin/README.md')
  write(fixture.root, '.codex-plugin/marketplace.json', '{}')
  write(fixture.root, 'plugins/codex-paper/.codex-plugin/original-plugin.json', '{}')
  fixture.trackedFiles.push('plugin/README.md')
  const errors = errorsFor(fixture)
  assert.match(errors, /legacy tree must not exist/)
  assert.match(errors, /legacy tree contains tracked files/)
  assert.match(errors, /\.codex-plugin\/marketplace\.json/)
  assert.match(errors, /original-plugin\.json/)
}))

test('duplicate or incorrect marketplace entry fails', () => withFixture((fixture) => {
  const marketplacePath = join(fixture.root, '.agents/plugins/marketplace.json')
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'))
  marketplace.plugins.push(structuredClone(marketplace.plugins[0]))
  writeFileSync(marketplacePath, JSON.stringify(marketplace))
  assert.match(errorsFor(fixture), /exactly one codex-paper entry/)

  marketplace.plugins.pop()
  marketplace.plugins[0].source.path = './plugin'
  marketplace.plugins[0].source.source = 'git'
  writeFileSync(marketplacePath, JSON.stringify(marketplace))
  const errors = errorsFor(fixture)
  assert.match(errors, /source\.source must be "local"/)
  assert.match(errors, /source\.path must be/)
}))

test('missing active sentinel fails with its path', () => withFixture((fixture) => {
  rmSync(join(fixture.root, 'plugins/codex-paper/skills/study/SKILL.md'))
  assert.match(errorsFor(fixture), /active plugin sentinel is missing: plugins\/codex-paper\/skills\/study\/SKILL\.md/)
}))

test('folder, package, lockfile, and base versions must agree', () => withFixture((fixture) => {
  const manifestPath = join(fixture.root, 'plugins/codex-paper/.codex-plugin/plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.name = 'wrong-name'
  manifest.version = '2.1.0+codex.test'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const errors = errorsFor(fixture)
  assert.match(errors, /active plugin names must match/)
  assert.match(errors, /must match package and lockfile versions/)
}))

test('plugin manifest must keep exactly three surfaced default prompts', () => withFixture((fixture) => {
  const manifestPath = join(fixture.root, 'plugins/codex-paper/.codex-plugin/plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.interface.defaultPrompt.push('Launch the web viewer')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.match(errorsFor(fixture), /interface\.defaultPrompt must contain exactly 3 core prompts; found 4/)
}))

test('root automation and tracked manifests cannot select a second plugin tree', () => withFixture((fixture) => {
  assert.match(
    checkRepository({
      repoRoot: fixture.root,
      trackedFiles: fixture.trackedFiles,
      actualActivePluginRelative: 'plugins/alternate',
    }).errors.join('\n'),
    /root automation active plugin must be plugins\/codex-paper/,
  )
  write(fixture.root, 'plugins/alternate/.codex-plugin/plugin.json', '{}')
  fixture.trackedFiles.push('plugins/alternate/.codex-plugin/plugin.json')
  assert.match(errorsFor(fixture), /tracked plugin manifests must contain only/)
}))

test('root-level plugin manifest is also rejected as a second implementation', () => withFixture((fixture) => {
  write(fixture.root, '.codex-plugin/plugin.json', '{}')
  fixture.trackedFiles.push('.codex-plugin/plugin.json')
  assert.match(errorsFor(fixture), /tracked plugin manifests must contain only/)
}))

test('legacy executable/config reference fails', () => withFixture((fixture) => {
  write(fixture.root, 'scripts/example.sh', 'cd "$REPO_ROOT/plugin/src/web"\n')
  fixture.trackedFiles.push('scripts/example.sh')
  assert.match(errorsFor(fixture), /executable\/config references legacy path: scripts\/example\.sh/)
}))

test('generated lockfiles are excluded from legacy prose scanning', () => withFixture((fixture) => {
  write(fixture.root, 'config/package-lock.json', '{"resolvedPath":"plugin/src/web"}\n')
  fixture.trackedFiles.push('config/package-lock.json')
  assert.deepEqual(checkRepository({ repoRoot: fixture.root, trackedFiles: fixture.trackedFiles }).errors, [])

  write(fixture.root, 'config/settings.json', '{"activePath":"plugin/src/web"}\n')
  fixture.trackedFiles.push('config/settings.json')
  assert.match(errorsFor(fixture), /executable\/config references legacy path: config\/settings\.json/)
}))

for (const artifact of [
  'x/node_modules/a.js',
  'x/.nuxt/state.json',
  'x/.output/server.mjs',
  'x/.vitepress/cache.json',
  'x/.vitepress.backup/cache.json',
  'x/dist/app.js',
  'x/__pycache__/a.pyc',
  'x/.DS_Store',
  'x/cache.pyo',
  'x/run.log',
  'x/server.pid',
  'x/.installed',
]) {
  test(`tracked generated artifact fails: ${artifact}`, () => withFixture((fixture) => {
    write(fixture.root, artifact)
    fixture.trackedFiles.push(artifact)
    assert.match(errorsFor(fixture), new RegExp(artifact.split('/').at(-1).replaceAll('.', '\\.')))
  }))
}

test('untracked and ignored build caches do not fail', () => withFixture((fixture) => {
  write(fixture.root, 'plugins/codex-paper/node_modules/cache.js')
  write(fixture.root, 'plugins/codex-paper/src/web/.output/server.mjs')
  assert.deepEqual(checkRepository({ repoRoot: fixture.root, trackedFiles: fixture.trackedFiles }).errors, [])
}))

test('git add -f cannot hide a generated artifact', () => withFixture((fixture) => {
  execFileSync('git', ['init', '-q'], { cwd: fixture.root })
  write(fixture.root, '.gitignore', 'node_modules/\n')
  write(fixture.root, 'plugins/codex-paper/node_modules/forced.js')
  execFileSync('git', ['add', '.'], { cwd: fixture.root })
  execFileSync('git', ['add', '-f', 'plugins/codex-paper/node_modules/forced.js'], { cwd: fixture.root })
  const result = checkRepository({ repoRoot: fixture.root })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /plugins\/codex-paper\/node_modules\/forced\.js/)
}))

test('tracked dangling symlink cannot hide a legacy tree', () => withFixture((fixture) => {
  execFileSync('git', ['init', '-q'], { cwd: fixture.root })
  symlinkSync('missing-target', join(fixture.root, 'plugin'))
  execFileSync('git', ['add', '.'], { cwd: fixture.root })
  const result = checkRepository({ repoRoot: fixture.root })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /legacy tree contains tracked files: plugin/)
}))

test('tracked PDFs are restricted to licensed, hashed fixture sidecars', () => withFixture((fixture) => {
  write(fixture.root, 'benchmarks/outside.pdf', 'outside')
  fixture.trackedFiles.push('benchmarks/outside.pdf')
  assert.match(errorsFor(fixture), /tracked PDF is outside the fixture allowlist/)

  fixture.trackedFiles.pop()
  rmSync(join(fixture.root, 'benchmarks/outside.pdf'))
  const pdfPath = 'benchmarks/fixtures/pdf/synthetic.pdf'
  const content = 'synthetic fixture'
  write(fixture.root, pdfPath, content)
  const manifestPath = `${pdfPath}.manifest.json`
  write(fixture.root, manifestPath, JSON.stringify({
    id: 'synthetic',
    kind: 'pdf',
    origin: 'original-synthetic',
    copyright: 'Copyright 2026 Codex Paper contributors',
    spdx: 'MIT',
    license: 'MIT',
    redistributable: true,
    sha256: createHash('sha256').update(content).digest('hex'),
    generator: 'tests/synthetic-fixture',
  }))
  fixture.trackedFiles.push(pdfPath, manifestPath)
  assert.deepEqual(checkRepository({ repoRoot: fixture.root, trackedFiles: fixture.trackedFiles }).errors, [])

  const invalidManifest = JSON.parse(readFileSync(join(fixture.root, manifestPath), 'utf8'))
  for (const field of ['id', 'kind', 'copyright', 'spdx', 'license', 'generator']) invalidManifest[field] = null
  writeFileSync(join(fixture.root, manifestPath), JSON.stringify(invalidManifest))
  const errors = errorsFor(fixture)
  assert.match(errors, /field id must be a non-empty string/)
  assert.match(errors, /field license must be a non-empty string/)
  assert.match(errors, /kind must be "pdf"/)
}))

test('mandatory regression manifest cannot be empty or contain duplicate fixture ids', () => withFixture((fixture) => {
  const manifestPath = join(fixture.root, 'benchmarks/mandatory/manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.fixtures = []
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.match(errorsFor(fixture), /must declare at least one fixture/)

  manifest.fixtures = [
    { id: 'front-matter-noise', pdf: 'benchmarks/fixtures/pdf/front-matter-noise.pdf', licenseManifest: 'benchmarks/fixtures/pdf/front-matter-noise.pdf.manifest.json', gold: 'benchmarks/mandatory/gold/front-matter-noise.json' },
    { id: 'front-matter-noise', pdf: 'benchmarks/fixtures/pdf/front-matter-noise.pdf', licenseManifest: 'benchmarks/fixtures/pdf/front-matter-noise.pdf.manifest.json', gold: 'benchmarks/mandatory/gold/front-matter-noise.json' },
  ]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  assert.match(errorsFor(fixture), /duplicate fixture id: front-matter-noise/)
}))

test('mandatory regression fails for missing gold, changed PDF hash, and wrong generator', () => withFixture((fixture) => {
  rmSync(join(fixture.root, 'benchmarks/mandatory/gold/front-matter-noise.json'))
  writeFileSync(join(fixture.root, 'benchmarks/fixtures/pdf/result-conflict.pdf'), 'changed fixture')
  const licensePath = join(fixture.root, 'benchmarks/fixtures/pdf/result-conflict.pdf.manifest.json')
  const license = JSON.parse(readFileSync(licensePath, 'utf8'))
  license.generator = 'tests/not-the-canonical-generator'
  writeFileSync(licensePath, JSON.stringify(license))
  const errors = errorsFor(fixture)
  assert.match(errors, /fixture front-matter-noise gold is missing/)
  assert.match(errors, /fixture result-conflict generator mismatch/)
  assert.match(errors, /fixture result-conflict sha256 mismatch/)
}))

test('tracked mandatory manifest cannot reference an untracked fixture file', () => withFixture((fixture) => {
  fixture.trackedFiles = fixture.trackedFiles.filter((path) => path !== 'benchmarks/mandatory/gold/front-matter-noise.json')
  assert.match(errorsFor(fixture), /fixture front-matter-noise gold must be tracked/)
}))

test('facts 2.1 schema and writer version boundaries cannot drift', () => withFixture((fixture) => {
  const schemaPath = join(fixture.root, 'plugins/codex-paper/skills/study/schemas/facts-2.1.schema.json')
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  delete schema.properties.resultClaims
  writeFileSync(schemaPath, JSON.stringify(schema))
  const preparePath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
  writeFileSync(preparePath, readFileSync(preparePath, 'utf8')
    .replace("const PACKAGE_VERSION = '2.1.0'", "const PACKAGE_VERSION = '2.0.0'")
    .replaceAll('validateFactsSchema(facts)', 'true')
    .replace('evidenceSchemaVersion: EVIDENCE_SCHEMA_VERSION', 'evidenceSchemaVersion: PACKAGE_VERSION'))
  const errors = errorsFor(fixture)
  assert.match(errors, /must define facts schema 2\.1 with resultClaims/)
  assert.match(errors, /must preserve package 2\.1 writer boundary/)
  assert.match(errors, /validateFactsSchema\(facts\)/)
  assert.match(errors, /must not couple frozen evidence schema/)
}))

test('package reader compatibility modes cannot be removed', () => withFixture((fixture) => {
  const compatibilityPath = join(fixture.root, 'plugins/codex-paper/src/shared/package-compatibility.mjs')
  writeFileSync(compatibilityPath, readFileSync(compatibilityPath, 'utf8')
    .replaceAll('unknown_read_only', 'unknown')
    .replaceAll('assertWritablePackage', 'removedWritableGuard')
    .replaceAll('unsupportedVersions', 'firstArtifactVersion'))
  const errors = errorsFor(fixture)
  assert.match(errors, /must preserve reader compatibility mode unknown_read_only/)
  assert.match(errors, /must preserve reader compatibility mode assertWritablePackage/)
  assert.match(errors, /must preserve reader compatibility mode unsupportedVersions/)
}))

test('round-two and round-three compatibility, legacy, and migration guards cannot be removed', () => withFixture((fixture) => {
  const extractorPath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/extract-facts.js')
  const validatorPath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/validate-study-package.js')
  const migrationPath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/migrate-package.js')
  const viewerPath = join(fixture.root, 'plugins/codex-paper/src/web/server/utils/storedPackageCompatibility.mjs')
  writeFileSync(extractorPath, readFileSync(extractorPath, 'utf8').replaceAll('compareCandidatesForMerge', 'removedMergeOrder'))
  writeFileSync(validatorPath, readFileSync(validatorPath, 'utf8')
    .replaceAll('LEGACY_PACKAGE_REQUIRES_LEGACY_OK', 'legacy-soft-pass')
    .replaceAll('classifyInvalidPackageArtifacts', 'ignoreInvalidArtifacts'))
  writeFileSync(migrationPath, readFileSync(migrationPath, 'utf8')
    .replaceAll('MIGRATION_SOURCE_VERSION_UNSUPPORTED', 'migration-soft-pass')
    .replaceAll('isLegacyMigrationSourceVersion', 'declared-v1-unsupported')
    .replaceAll('classifyPackageCompatibility({ reasoning: existingReasoning, ledger: existingLedger })', 'classifyPackageCompatibility({ meta })')
    .replaceAll('classifyInvalidPackageArtifacts', 'rawJsonParse'))
  writeFileSync(viewerPath, readFileSync(viewerPath, 'utf8')
    .replaceAll('classifyStoredPackageCompatibility', 'classifyEndpointLocally')
    .replaceAll('classifyInvalidPackageArtifacts', 'ignoreInvalidArtifacts')
    .replaceAll("readCompatibilityArtifact(slug, 'meta.json'", "readOptionalInternalJson(slug, 'meta.json'"))
  const errors = errorsFor(fixture)
  assert.match(errors, /compareCandidatesForMerge/)
  assert.match(errors, /explicit read-only legacy validation/)
  assert.match(errors, /diagnose corrupt compatibility artifacts/)
  assert.match(errors, /reject unsupported versions before migration writes/)
  assert.match(errors, /explicit 1\.x migration without partial writes/)
  assert.match(errors, /preflight ancillary artifact versions/)
  assert.match(errors, /diagnose corrupt migration inputs/)
  assert.match(errors, /cross-endpoint compatibility classification/)
  assert.match(errors, /corrupt-artifact compatibility diagnostics/)
  assert.match(errors, /corrupt-meta compatibility fallback/)
}))

test('mandatory worker cannot bypass prepare or honor the optional skip flag', () => withFixture((fixture) => {
  const workerPath = join(fixture.root, 'benchmarks/mandatory/run-fixture.mjs')
  writeFileSync(workerPath, 'import { parsePdfDetailedWorkerInternal } from "pdf-parser-worker";\nconst flag = process.env.CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS;\n')
  const errors = errorsFor(fixture)
  assert.match(errors, /must enter the bounded pipeline through preparePaper/)
  assert.match(errors, /must not bypass the parser supervisor or honor the optional skip flag/)
}))

test('CI cannot remove or reorder the mandatory regression gate', () => withFixture((fixture) => {
  const workflowPath = join(fixture.root, '.github/workflows/ci.yml')
  const workflow = readFileSync(workflowPath, 'utf8').replace('bash scripts/codex-paper.sh benchmark-mandatory', 'true')
  writeFileSync(workflowPath, workflow)
  assert.match(errorsFor(fixture), /must run benchmark-mandatory before the optional external corpus/)
}))

test('CI cannot remove the Validation Report 1.0 gate', () => withFixture((fixture) => {
  const workflowPath = join(fixture.root, '.github/workflows/ci.yml')
  const workflow = readFileSync(workflowPath, 'utf8').replace('bash scripts/codex-paper.sh validation-test', 'true')
  writeFileSync(workflowPath, workflow)
  assert.match(errorsFor(fixture), /must run validation-test before benchmark-mandatory/)
}))

test('CI cannot remove or reorder the Paper Identity 1.0 gate', () => withFixture((fixture) => {
  const workflowPath = join(fixture.root, '.github/workflows/ci.yml')
  const workflow = readFileSync(workflowPath, 'utf8').replace('bash scripts/codex-paper.sh identity-test', 'true')
  writeFileSync(workflowPath, workflow)
  assert.match(errorsFor(fixture), /must run identity-test before validation-test and benchmark-mandatory/)
}))

test('CI cannot remove or reorder the storage transaction gate', () => withFixture((fixture) => {
  const workflowPath = join(fixture.root, '.github/workflows/ci.yml')
  const workflow = readFileSync(workflowPath, 'utf8').replace('bash scripts/codex-paper.sh storage-test', 'true')
  writeFileSync(workflowPath, workflow)
  assert.match(errorsFor(fixture), /must run storage-test after layout-test/)
}))

test('CI cannot remove the generation publication gate', () => withFixture((fixture) => {
  const workflowPath = join(fixture.root, '.github/workflows/ci.yml')
  writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('bash scripts/codex-paper.sh publication-test', 'true'))
  assert.match(errorsFor(fixture), /must run publication-test after storage-test/)
}))

test('generation manifest, authoritative resolver, and mandatory publication boundaries are guarded', () => withFixture((fixture) => {
  const resolver = join(fixture.root, 'plugins/codex-paper/src/shared/paper-library.mjs')
  const worker = join(fixture.root, 'benchmarks/mandatory/run-fixture.mjs')
  const manifest = join(fixture.root, 'plugins/codex-paper/src/shared/generation-manifest.mjs')
  writeFileSync(resolver, readFileSync(resolver, 'utf8').replaceAll('verifyGenerationManifest', 'uncheckedManifest'))
  writeFileSync(worker, readFileSync(worker, 'utf8').replaceAll('publishGenerationWorkspace', 'skipPublication'))
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replaceAll('GENERATION_MANIFEST_DIRTY', 'MANIFEST_CHANGED'))
  const errors = errorsFor(fixture)
  assert.match(errors, /must verify sealed generations during authoritative resolution/)
  assert.match(errors, /mandatory pipeline through publication/)
  assert.match(errors, /generation manifest boundary GENERATION_MANIFEST_DIRTY/)
}))

test('publication recovery and index isolation fixes are guarded', () => withFixture((fixture) => {
  const manifest = join(fixture.root, 'plugins/codex-paper/src/shared/generation-manifest.mjs')
  const publication = join(fixture.root, 'plugins/codex-paper/src/shared/generation-publication.mjs')
  const workspace = join(fixture.root, 'plugins/codex-paper/src/shared/generation-workspace.mjs')
  writeFileSync(manifest, readFileSync(manifest, 'utf8')
    .replace('return files.sort', 'return files')
    .replaceAll('verifyGenerationManifestBinding', 'uncheckedManifestBinding')
    .replaceAll('readManifestBoundFile', 'uncheckedManifestFile')
    .replaceAll('unsealGenerationPackageForLifecycle', 'unsafeLifecycleCleanup')
    .replaceAll('containmentRoot', 'uncheckedRoot'))
  writeFileSync(publication, readFileSync(publication, 'utf8')
    .replaceAll('after_new_payload_rename', 'newRenameRecoveryRemoved')
    .replaceAll('after_existing_payload_rename', 'existingRenameRecoveryRemoved')
    .replaceAll('after_new_payload_staged', 'stagingRecoveryRemoved')
    .replaceAll('persistedJournal', 'staleJournal')
    .replaceAll('indexDiagnostics', 'hiddenIndexFailures'))
  writeFileSync(workspace, readFileSync(workspace, 'utf8').replaceAll('publicationInvalid', 'hiddenJournalInvalid'))
  const errors = errorsFor(fixture)
  assert.match(errors, /manifest boundary return files\.sort/)
  assert.match(errors, /manifest boundary verifyGenerationManifestBinding/)
  assert.match(errors, /manifest boundary readManifestBoundFile/)
  assert.match(errors, /manifest boundary unsealGenerationPackageForLifecycle/)
  assert.match(errors, /manifest boundary containmentRoot/)
  assert.match(errors, /publication boundary after_new_payload_rename/)
  assert.match(errors, /publication boundary after_existing_payload_rename/)
  assert.match(errors, /publication boundary after_new_payload_staged/)
  assert.match(errors, /publication boundary persistedJournal/)
  assert.match(errors, /publication boundary indexDiagnostics/)
  assert.match(errors, /workspace boundary publicationInvalid/)
}))

test('workspace schema, shared writer, and workspace-only prepare boundaries are required', () => withFixture((fixture) => {
  const schema = 'plugins/codex-paper/skills/study/schemas/generation-workspace-1.0.schema.json'
  rmSync(join(fixture.root, schema))
  const preparePath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
  writeFileSync(preparePath, `${readFileSync(preparePath, 'utf8')}\nfunction writeIndexPreserveShape() { fs.writeFileSync('index.json', '[]') }\n`)
  const authoringPath = join(fixture.root, 'benchmarks/mandatory/authoring-boundary.mjs')
  writeFileSync(authoringPath, readFileSync(authoringPath, 'utf8').replace('writeWorkspaceAuthoring', 'writeFileSync'))
  const errors = errorsFor(fixture)
  assert.match(errors, /generation-workspace-1\.0\.schema\.json/)
  assert.match(errors, /must not publish current, record, or index/)
  assert.match(errors, /must author through the shared workspace writer/)
}))

test('workspace-only prepare guard rejects imported and blessed-writer publication bypasses', () => withFixture((fixture) => {
  const preparePath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
  writeFileSync(preparePath, `${readFileSync(preparePath, 'utf8')}\nimport { writeFileSync } from 'node:fs'\nconst forbiddenPublication = () => atomicWriteJson({ root: libraryRoot, relativePath: 'index.json', value: {} })\n`)
  assert.match(errorsFor(fixture), /must not publish current, record, or index/)
}))

test('workspace-only prepare guard rejects asynchronous direct writes', () => withFixture((fixture) => {
  const preparePath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
  writeFileSync(preparePath, `${readFileSync(preparePath, 'utf8')}\nconst forbiddenAsyncWrite = () => fs.promises.writeFile(targetPath, 'unsafe')\n`)
  assert.match(errorsFor(fixture), /must not publish current, record, or index/)
}))

test('workspace initialization cleanup cannot move outside the registry lock', () => withFixture((fixture) => {
  const engine = join(fixture.root, 'plugins/codex-paper/src/shared/generation-workspace.mjs')
  writeFileSync(engine, readFileSync(engine, 'utf8').replace(
    "  return withStorageLocks(keys, async (lockHandle) => {\n    cleanupInitDirectories(layout)",
    "  cleanupInitDirectories(layout)\n  return withStorageLocks(keys, async (lockHandle) => {"
  ))
  assert.match(errorsFor(fixture), /must clean initialization residues while holding the registry lock/)
}))

test('prepare and migration must retain the shared paper library resolver', () => withFixture((fixture) => {
  for (const relativePath of [
    'plugins/codex-paper/skills/study/scripts/prepare-paper.js',
    'plugins/codex-paper/skills/study/scripts/migrate-package.js',
  ]) {
    const target = join(fixture.root, relativePath)
    writeFileSync(target, readFileSync(target, 'utf8').replaceAll('paper-library.mjs', 'paper-library-bypass.mjs'))
  }
  const errors = errorsFor(fixture)
  assert.match(errors, /prepare-paper\.js must use the shared paper library resolver/)
  assert.match(errors, /migrate-package\.js must use the shared paper library resolver/)
}))

test('every guarded resolver and workspace-writer consumer has mutation coverage', () => withFixture((fixture) => {
  const resolverConsumers = [
    'plugins/codex-paper/skills/study/scripts/validate-reasoning.js',
    'plugins/codex-paper/skills/study/scripts/validate-study-package.js',
    'plugins/codex-paper/skills/study/scripts/sandbox-code.js',
    'plugins/codex-paper/src/web/server/utils/librarySecurity.mjs',
  ]
  const writerConsumers = [
    'plugins/codex-paper/skills/study/scripts/build-analysis.js',
    'plugins/codex-paper/skills/study/scripts/render-from-analysis.js',
    'plugins/codex-paper/skills/study/scripts/scaffold-reasoning-analysis.js',
  ]
  for (const relativePath of resolverConsumers) {
    const target = join(fixture.root, relativePath)
    writeFileSync(target, readFileSync(target, 'utf8').replaceAll('paper-library.mjs', 'paper-library-bypass.mjs'))
  }
  for (const relativePath of writerConsumers) {
    const target = join(fixture.root, relativePath)
    writeFileSync(target, readFileSync(target, 'utf8').replaceAll('workspace-writer.mjs', 'workspace-writer-bypass.mjs'))
  }
  const errors = errorsFor(fixture)
  for (const relativePath of resolverConsumers) assert.ok(errors.includes(`${relativePath} must use the shared paper library resolver`))
  for (const relativePath of writerConsumers) assert.ok(errors.includes(`${relativePath} must use the shared workspace writer`))
}))

test('legacy migration must share the paper lock and preserve existing reviews', () => withFixture((fixture) => {
  const migrationPath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/migrate-package.js')
  writeFileSync(migrationPath, readFileSync(migrationPath, 'utf8')
    .replace('withStorageLocks([lockKey]', 'withStorageLocks([`legacy:migration:${lockKey}`]')
    .replace('!fs.existsSync(reviewPath) || options.force', 'options.force'))
  const errors = errorsFor(fixture)
  assert.match(errors, /must hold the shared legacy paper lock/)
  assert.match(errors, /must preserve an existing reasoning review/)
}))

test('Paper Identity 1.0 schema and generation contract are required', () => withFixture((fixture) => {
  const schema = 'plugins/codex-paper/skills/study/schemas/paper-identity-1.0.schema.json'
  rmSync(join(fixture.root, schema))
  const contractPath = join(fixture.root, 'plugins/codex-paper/skills/study/generation-contract-1.0.json')
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  contract.common.push('.codex-plugin/plugin.json')
  writeFileSync(contractPath, JSON.stringify(contract))
  const errors = errorsFor(fixture)
  assert.match(errors, /active plugin sentinel is missing: .*paper-identity-1\.0\.schema\.json/)
  assert.match(errors, /must exclude provenance-only file from fingerprint/)
}))

test('prepare and skills cannot restore overwrite or implicit identity inputs', () => withFixture((fixture) => {
  const preparePath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
  writeFileSync(preparePath, `${readFileSync(preparePath, 'utf8')}\nconst force = { force: true }; // mutation\n`)
  const studyPath = join(fixture.root, 'plugins/codex-paper/skills/study/SKILL.md')
  writeFileSync(studyPath, readFileSync(studyPath, 'utf8').replace('--workflow study', '--workflow auto'))
  const summaryPath = join(fixture.root, 'plugins/codex-paper/skills/summary/SKILL.md')
  writeFileSync(summaryPath, readFileSync(summaryPath, 'utf8').replace('--language "$OUTPUT_LANG"', '--lang "$OUTPUT_LANG"'))
  const errors = errorsFor(fixture)
  assert.match(errors, /must not restore overwrite or force preparation/)
  assert.match(errors, /must pass explicit --workflow study/)
  assert.match(errors, /must pass explicit --workflow summary and --language/)
}))

test('Validation Report 1.0 schema is a required repository sentinel', () => withFixture((fixture) => {
  const schema = 'plugins/codex-paper/skills/study/schemas/validation-report-1.0.schema.json'
  rmSync(join(fixture.root, schema))
  fixture.trackedFiles = fixture.trackedFiles.filter((path) => path !== schema)
  assert.match(errorsFor(fixture), /active plugin sentinel is missing: .*validation-report-1\.0\.schema\.json/)
}))

test('Validation engine cannot introduce a parallel report path', () => withFixture((fixture) => {
  const engine = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/validation-report.js')
  writeFileSync(engine, readFileSync(engine, 'utf8').replace(
    "const REPORT_PATH = '.codex-paper/validation-report.json'",
    "const REPORT_PATH = '.codex-paper/validation-report-v2.json'"
  ))
  assert.match(errorsFor(fixture), /must write only \.codex-paper\/validation-report\.json/)
}))

test('validators must persist workspace state and report in one atomic transaction', () => withFixture((fixture) => {
  const validator = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/validate-reasoning.js')
  writeFileSync(validator, readFileSync(validator, 'utf8')
    .replaceAll('persistWorkspaceValidationReport', 'writeValidationReportAtomic'))
  assert.match(errorsFor(fixture), /must persist validation state and report through one atomic workspace transaction/)
}))

test('shared CAS, CLI limits, and both validation failure compensations cannot drift', () => withFixture((fixture) => {
  const librarySecurity = join(fixture.root, 'plugins/codex-paper/src/web/server/utils/librarySecurity.mjs')
  const prepare = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
  const workspaceCli = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/workspace-cli.js')
  const validation = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/validation-report.js')
  writeFileSync(librarySecurity, readFileSync(librarySecurity, 'utf8').replaceAll('fileWritePrecondition', 'localCasPrecondition'))
  for (const cli of [prepare, workspaceCli]) writeFileSync(cli, readFileSync(cli, 'utf8')
    .replaceAll('storageCliExitCode', 'localCliExitCode')
    .replaceAll('MAX_LOCK_TIMEOUT_MS', '30_000'))
  writeFileSync(validation, readFileSync(validation, 'utf8')
    .replaceAll('createWorkspaceDiagnostic', 'localWorkspaceDiagnostic')
    .replaceAll('validation_report_write_failed', 'validation_started')
    .replaceAll('validation_state_update_failed', 'validation_started')
    .replaceAll('preservationError', 'discardedSecondaryError'))
  const errors = errorsFor(fixture)
  assert.match(errors, /librarySecurity\.mjs must use the shared CAS precondition helper/)
  assert.match(errors, /prepare-paper\.js must use the shared storage CLI exit mapping/)
  assert.match(errors, /workspace-cli\.js must use the shared storage CLI exit mapping/)
  assert.match(errors, /prepare-paper\.js must use the shared storage lock timeout maximum/)
  assert.match(errors, /workspace-cli\.js must use the shared storage lock timeout maximum/)
  assert.match(errors, /Validation Report 1\.0 contract createWorkspaceDiagnostic/)
  assert.match(errors, /Validation Report 1\.0 contract validation_report_write_failed/)
  assert.match(errors, /Validation Report 1\.0 contract validation_state_update_failed/)
  assert.match(errors, /Validation Report 1\.0 contract preservationError/)
}))

test('README layout cannot present the legacy tree as active', () => withFixture((fixture) => {
  writeFileSync(join(fixture.root, 'README.md'), `${readFileSync(join(fixture.root, 'README.md'), 'utf8')}\n├── plugin/\n`)
  assert.match(errorsFor(fixture), /README\.md still presents the legacy tree/)
}))

test('README prose cannot reference the legacy plugin path', () => withFixture((fixture) => {
  writeFileSync(join(fixture.root, 'README.md'), `${readFileSync(join(fixture.root, 'README.md'), 'utf8')}\nInstall from plugin/ now.\n`)
  assert.match(errorsFor(fixture), /README\.md references the legacy plugin path/)
}))

test('package validator cannot regain generated-code process execution', () => withFixture((fixture) => {
  const validator = 'plugins/codex-paper/skills/study/scripts/validate-study-package.js'
  write(fixture.root, validator, "import { spawn } from 'node:child_process'\n")
  fixture.trackedFiles.push(validator)
  assert.match(errorsFor(fixture), /must remain static-only/)
}))

test('study instructions cannot recommend legacy validator execution flags', () => withFixture((fixture) => {
  const skill = join(fixture.root, 'plugins/codex-paper/skills/study/SKILL.md')
  writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nnode validate-study-package.js paper --run-code\n`)
  assert.match(errorsFor(fixture), /must not recommend legacy generated-code execution/)
}))

test('study instructions preserve the explicit human-consent workflow boundary', () => withFixture((fixture) => {
  const skill = join(fixture.root, 'plugins/codex-paper/skills/study/SKILL.md')
  writeFileSync(skill, readFileSync(skill, 'utf8').replace('does not authenticate a human', 'authenticates a human'))
  assert.match(errorsFor(fixture), /must preserve the explicit human-consent workflow boundary/)
}))

test('study image extraction paths remain relative to the study skill directory', () => withFixture((fixture) => {
  const skill = join(fixture.root, 'plugins/codex-paper/skills/study/SKILL.md')
  writeFileSync(skill, readFileSync(skill, 'utf8').replace(
    'bash ../../scripts/runtime-python.sh ./scripts/extract-images.py',
    'bash ./scripts/runtime-python.sh ./skills/study/scripts/extract-images.py',
  ))
  assert.match(errorsFor(fixture), /must invoke image extraction through paths relative to the study skill directory/)
}))

test('sandbox policy requires digest-pinned image and fixed contract versions', () => withFixture((fixture) => {
  const dockerfile = join(fixture.root, 'plugins/codex-paper/sandbox/Dockerfile')
  writeFileSync(
    dockerfile,
    readFileSync(dockerfile, 'utf8').replace(
      /^(ARG BASE_IMAGE=[^@\n]+)@sha256:[a-f0-9]{64}$/m,
      '$1',
    ),
  )
  const policyPath = join(fixture.root, 'plugins/codex-paper/sandbox/policy.json')
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
  policy.baseImage = 'node:20-bookworm-slim'
  policy.policyVersion = 'dev'
  writeFileSync(policyPath, JSON.stringify(policy))
  const errors = errorsFor(fixture)
  assert.match(errors, /Dockerfile base image must be pinned/)
  assert.match(errors, /policy\.json baseImage must be digest-pinned/)
  assert.match(errors, /policy and conformance version 1\.0\.0/)
}))

test('sandbox image composes complete digest-pinned CPython without a mutable package manager', () => withFixture((fixture) => {
  const dockerfile = join(fixture.root, 'plugins/codex-paper/sandbox/Dockerfile')
  writeFileSync(dockerfile, readFileSync(dockerfile, 'utf8')
    .replace('FROM ${PYTHON_BASE_IMAGE}', 'FROM ${BASE_IMAGE}')
    .replace('import bz2, ctypes, hashlib, lzma, readline, sqlite3, ssl, uuid, zlib', 'import hashlib, ssl, zlib'))
  assert.match(errorsFor(fixture), /complete package-manager-free CPython 3\.11\.15/)
}))

test('runtime baseline and Python wheel hashes are immutable repository contracts', () => withFixture((fixture) => {
  const runtimePath = join(fixture.root, 'security/runtime-baseline.json')
  const runtime = JSON.parse(readFileSync(runtimePath, 'utf8'))
  runtime.host.node = 'latest'
  runtime.retroactiveManifestRewrite = true
  writeFileSync(runtimePath, JSON.stringify(runtime))
  const requirements = join(fixture.root, 'plugins/codex-paper/runtime/python/requirements.lock')
  writeFileSync(requirements, 'PyMuPDF>=1\n')
  const errors = errorsFor(fixture)
  assert.match(errors, /host\.node must be 22\.23\.1/)
  assert.match(errors, /non-retroactive P1-4 provenance input/)
  assert.match(errors, /four supported wheel hashes/)
}))

test('production Node and managed-runtime containment sites must follow the runtime baseline', () => withFixture((fixture) => {
  const common = join(fixture.root, 'scripts/common.sh')
  writeFileSync(common, readFileSync(common, 'utf8').replace('NODE_REQUIRED="22.23.1"', 'NODE_REQUIRED="22.24.0"'))
  const launcher = join(fixture.root, 'plugins/codex-paper/scripts/start-webui.sh')
  writeFileSync(launcher, readFileSync(launcher, 'utf8').replaceAll('22.23.1', '22.24.0'))
  const runtimePolicy = join(fixture.root, 'scripts/runtime-policy.mjs')
  writeFileSync(runtimePolicy, readFileSync(runtimePolicy, 'utf8')
    .replaceAll('managedStdlibSha256', 'uncheckedStdlibSha256')
    .replaceAll('managedTreeSha256', 'uncheckedTreeSha256')
    .replaceAll('rewriteMacNativeReferences', 'skipMacNativeRelocation'))
  const errors = errorsFor(fixture)
  assert.match(errors, /scripts\/common\.sh Node version must match/)
  assert.match(errors, /start-webui\.sh Node version must match/)
  assert.match(errors, /locked rollback-safe runtime replacement: managedStdlibSha256/)
  assert.match(errors, /locked rollback-safe runtime replacement: managedTreeSha256/)
  assert.match(errors, /locked rollback-safe runtime replacement: rewriteMacNativeReferences/)
}))

test('host runtime must verify native imports, reject residual bootstrap references, and avoid fabricated provenance', () => withFixture((fixture) => {
  const runtimePolicy = join(fixture.root, 'scripts/runtime-policy.mjs')
  writeFileSync(runtimePolicy, readFileSync(runtimePolicy, 'utf8')
    .replace('import bz2, ctypes, hashlib, json, lzma, os, platform, readline, sqlite3, ssl', 'import json, os, platform')
    .replaceAll('verifyNativeReferences', 'skipNativeReferenceVerification')
    .replace('if (!isSharedLibraryName(name)) continue', 'if (name === versionDirectory) continue')
    .concat('\n// command = ${path.join(target\n'))
  const errors = errorsFor(fixture)
  assert.match(errors, /locked rollback-safe runtime replacement: verifyNativeReferences/)
  assert.match(errors, /locked rollback-safe runtime replacement: import bz2/)
  assert.match(errors, /minimal relocatable native runtime without fabricated venv provenance/)
}))

test('runtime publication cannot lose rpath inspection, sanitized loader probes, bootstrap imports, or mode attestation', () => withFixture((fixture) => {
  const runtimePolicy = join(fixture.root, 'scripts/runtime-policy.mjs')
  writeFileSync(runtimePolicy, readFileSync(runtimePolicy, 'utf8')
    .replaceAll('macRpaths', 'skipMacRpathInspection')
    .replaceAll('runtimeProbeEnvironment', 'inheritAmbientLoaderEnvironment')
    .replaceAll('nativeRuntimeSelfContained', 'uncheckedNativeRuntime')
    .replaceAll('info.mode & 0o777', '0o700')
    .replace('import bz2, ctypes, hashlib, json, lzma, platform, readline, sqlite3, ssl', 'import json, platform'))
  const errors = errorsFor(fixture)
  assert.match(errors, /locked rollback-safe runtime replacement: macRpaths/)
  assert.match(errors, /locked rollback-safe runtime replacement: runtimeProbeEnvironment/)
  assert.match(errors, /locked rollback-safe runtime replacement: nativeRuntimeSelfContained/)
  assert.match(errors, /locked rollback-safe runtime replacement: info\.mode & 0o777/)
  assert.match(errors, /must reject a bootstrap that lacks required native extension modules/)
}))

test('runtime setup cannot delete the active target before replacement publication', () => withFixture((fixture) => {
  const runtimePolicy = join(fixture.root, 'scripts/runtime-policy.mjs')
  writeFileSync(runtimePolicy, readFileSync(runtimePolicy, 'utf8')
    .replace('    publishPreparedRuntime(temporary, target, {', '    rmSync(target, { recursive: true })\n    publishPreparedRuntime(temporary, target, {'))
  assert.match(errorsFor(fixture), /must not delete the active runtime before publishing its replacement/)
}))

test('CI cannot remove P1-3a supply-chain and runtime gates', () => withFixture((fixture) => {
  const workflowPath = join(fixture.root, '.github/workflows/ci.yml')
  const workflow = readFileSync(workflowPath, 'utf8')
    .replace('bash scripts/codex-paper.sh secret-scan', 'true')
    .replace('node-version: "22.23.1"', 'node-version: "latest"')
    .replace('sudo chmod go-w "$pythonLocation" "$python_stdlib"', 'true')
    .replace('CODEX_PAPER_BOOTSTRAP_PYTHON: ${{ env.pythonLocation }}/bin/python', 'CODEX_PAPER_BOOTSTRAP_PYTHON: python')
  writeFileSync(workflowPath, workflow)
  const errors = errorsFor(fixture)
  assert.match(errors, /node-version: "22\.23\.1"/)
  assert.match(errors, /codex-paper\.sh secret-scan/)
  assert.match(errors, /sudo chmod go-w/)
  assert.match(errors, /CODEX_PAPER_BOOTSTRAP_PYTHON/)
}))

test('CI requires immutable action forms and a post-install supply-chain gate', () => withFixture((fixture) => {
  const workflowPath = join(fixture.root, '.github/workflows/ci.yml')
  const workflow = readFileSync(workflowPath, 'utf8')
    .replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout')
    .replace('      - name: Verify lockfiles remain reviewed after install\n        run: bash scripts/codex-paper.sh supply-chain-test\n\n', '')
  writeFileSync(workflowPath, workflow)
  const errors = errorsFor(fixture)
  assert.match(errors, /action actions\/checkout must use a full commit SHA/)
  assert.match(errors, /verify supply-chain policy again after dependency installation/)
}))

test('sandbox runner cannot enable a shell or import exec helpers', () => withFixture((fixture) => {
  const runner = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/sandbox-code.js')
  writeFileSync(runner, "import { execFileSync } from 'node:child_process'\nspawn('tool', [], { shell: true })\n")
  assert.match(errorsFor(fixture), /argv-array process execution without a shell/)
}))

test('PDF ingestion policy keeps HTTPS, resource budgets, and private bounded quarantine', () => withFixture((fixture) => {
  const policyPath = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/pdf-security-policy.json')
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
  policy.httpsOnly = false
  policy.maxInputBytes = Number.MAX_SAFE_INTEGER
  policy.parserWallTimeMs = 0
  policy.quarantineMaxEntries = Number.MAX_SAFE_INTEGER
  writeFileSync(policyPath, JSON.stringify(policy))
  const errors = errorsFor(fixture)
  assert.match(errors, /httpsOnly must be true/)
  assert.match(errors, /maxInputBytes must be 134217728/)
  assert.match(errors, /parserWallTimeMs must be 60000/)
  assert.match(errors, /quarantineMaxEntries must be 32/)
}))

test('PDF downloader and prepare workflow cannot restore HTTP or shared staging', () => withFixture((fixture) => {
  const downloader = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/download-pdf.cjs')
  writeFileSync(downloader, "const http = require('http')\nconst DOWNLOAD_DIR='/tmp/codex-paper-downloads'\n")
  const prepare = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/prepare-paper.js')
  writeFileSync(prepare, "import { execFileSync } from 'node:child_process'\n")
  const errors = errorsFor(fixture)
  assert.match(errors, /must not restore HTTP or shared predictable staging/)
  assert.match(errors, /must use and clean secure PDF staging/)
}))

test('PDF parser worker and launcher cannot lose supervisor and hard-limit gates', () => withFixture((fixture) => {
  const parser = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/parse-pdf.js')
  writeFileSync(parser, 'export async function parsePdfDetailed() {}\n')
  const worker = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/pdf-parser-worker.js')
  writeFileSync(worker, 'console.log("direct")\n')
  const launcher = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/pdf-parser-launcher.py')
  writeFileSync(launcher, 'import os\n')
  const errors = errorsFor(fixture)
  assert.match(errors, /must preserve bounded parser control/)
  assert.match(errors, /must remain supervisor-only and output-bounded/)
  assert.match(errors, /must preserve hard parser resource limit/)
}))

test('PDF parser cannot trust a caller-movable canonical runtime anchor or ambient downgrade flags', () => withFixture((fixture) => {
  const parser = join(fixture.root, 'plugins/codex-paper/skills/study/scripts/parse-pdf.js')
  writeFileSync(parser, readFileSync(parser, 'utf8')
    .replace("process.env.CODEX_PAPER_PARSER_WORKER !== '1'", 'false')
    .replaceAll('MANAGED_VERSION_ROOT', 'CALLER_SELECTED_ROOT')
    .concat('\nconst unsafe = process.env.CODEX_PAPER_FORCE_PYMUPDF_FAILURE\n'))
  const errors = errorsFor(fixture)
  assert.match(errors, /bounded parser control process\.env\.CODEX_PAPER_PARSER_WORKER/)
  assert.match(errors, /must not expose ambient test-only parser downgrade switches/)
  assert.match(errors, /bounded parser control MANAGED_VERSION_ROOT/)
}))

test('repository and study suites keep explicit execution-count gates and failure diagnostics', () => withFixture((fixture) => {
  const rootScript = join(fixture.root, 'scripts/codex-paper.sh')
  writeFileSync(rootScript, readFileSync(rootScript, 'utf8')
    .replace('"repository-security" 204', '"repository-security" 203')
    .replace('"study" 87', '"study" 86')
    .replace('preserved output: $output', 'test output was discarded'))
  assert.match(errorsFor(fixture), /must fail and preserve diagnostics when a regression test is silently not executed/)
}))

test('modifying any frozen 2.0 schema fails', () => {
  for (const schema of BASELINE.schemas) {
    withFixture((fixture) => {
      writeFileSync(join(fixture.root, schema.path), `${readFileSync(join(fixture.root, schema.path), 'utf8')}\n`)
      assert.match(errorsFor(fixture), new RegExp(`frozen schema hash mismatch: ${schema.path.replaceAll('.', '\\.')}`))
    })
  }
})

test('changing the recorded active path or frozen hash fails', () => withFixture((fixture) => {
  const baselinePath = join(fixture.root, 'docs/contracts/s0-contract-baseline.json')
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  baseline.activePlugin.sourcePath = 'plugins/alternate'
  baseline.schemas[0].sha256 = '0'.repeat(64)
  writeFileSync(baselinePath, JSON.stringify(baseline))
  const errors = errorsFor(fixture)
  assert.match(errors, /activePlugin\.sourcePath must be "plugins\/codex-paper"/)
  assert.match(errors, /schema evidence-ledger\.sha256 must be/)
}))
