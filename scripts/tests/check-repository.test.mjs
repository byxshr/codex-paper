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
  'plugins/codex-paper/skills/study/scripts/pdf-parser-launcher.py',
  'plugins/codex-paper/skills/study/scripts/pdf-parser-worker.js',
  'plugins/codex-paper/skills/study/scripts/pdf-security-policy.json',
  'plugins/codex-paper/skills/study/scripts/prepare-paper.js',
  'plugins/codex-paper/sandbox/Dockerfile',
  'plugins/codex-paper/sandbox/policy.json',
  'plugins/codex-paper/src/web/package.json',
  'plugins/codex-paper/hooks/hooks.json',
  '.agents/plugins/marketplace.json',
  'docs/contracts/s0-contract-baseline.json',
  'README.md',
  'README.zh-CN.md',
]

function write(root, path, content = '') {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function makeFixture() {
  const root = mkdtempSync('/tmp/codex-paper-repo-check-')
  for (const path of SENTINELS) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(join(REPO_ROOT, path), join(root, path), { recursive: true })
  }
  for (const schema of BASELINE.schemas) {
    mkdirSync(dirname(join(root, schema.path)), { recursive: true })
    cpSync(join(REPO_ROOT, schema.path), join(root, schema.path), { recursive: true })
  }
  const trackedFiles = [...SENTINELS, ...BASELINE.schemas.map((schema) => schema.path)]
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

test('sandbox policy requires digest-pinned image and fixed contract versions', () => withFixture((fixture) => {
  const dockerfile = join(fixture.root, 'plugins/codex-paper/sandbox/Dockerfile')
  writeFileSync(dockerfile, readFileSync(dockerfile, 'utf8').replace(/@sha256:[a-f0-9]{64}/, ''))
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

test('sandbox image includes the Python standard library required by its trusted entrypoint', () => withFixture((fixture) => {
  const dockerfile = join(fixture.root, 'plugins/codex-paper/sandbox/Dockerfile')
  writeFileSync(dockerfile, readFileSync(dockerfile, 'utf8').replace('python3 \\', 'python3-minimal \\'))
  assert.match(errorsFor(fixture), /must install the Python 3 standard library/)
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
