#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..')
const LEGACY_TREE = 'plugin'
const DUPLICATE_MARKETPLACE = '.codex-plugin/marketplace.json'
const ORIGINAL_PLUGIN = 'plugins/codex-paper/.codex-plugin/original-plugin.json'
const BASELINE_PATH = 'docs/contracts/s0-contract-baseline.json'
const EXPECTED_BASELINE_SHA256 = '85bb06acf0f22d7b979605d524717d45ac1f7097de8bf129b7d749eeb889a142'
const FIXTURE_PDF_ROOT = 'benchmarks/fixtures/pdf/'
const MANDATORY_MANIFEST = 'benchmarks/mandatory/manifest.json'
const MANDATORY_RUNNER = 'benchmarks/run-mandatory-benchmark.mjs'
const MANDATORY_WORKER = 'benchmarks/mandatory/run-fixture.mjs'
const FIXTURE_GENERATOR = 'benchmarks/fixtures/generate-pdf-fixtures.py'
const CI_WORKFLOW = '.github/workflows/ci.yml'
const ROOT_SCRIPT = 'scripts/codex-paper.sh'
const FACTS_SCHEMA = 'plugins/codex-paper/skills/study/schemas/facts-2.1.schema.json'
const FACTS_EXTRACTOR = 'plugins/codex-paper/skills/study/scripts/extract-facts.js'
const PACKAGE_COMPATIBILITY = 'plugins/codex-paper/src/shared/package-compatibility.mjs'
const STUDY_VALIDATOR = 'plugins/codex-paper/skills/study/scripts/validate-study-package.js'
const MIGRATION_SCRIPT = 'plugins/codex-paper/skills/study/scripts/migrate-package.js'
const VIEWER_COMPATIBILITY = 'plugins/codex-paper/src/web/server/utils/storedPackageCompatibility.mjs'
const VALIDATION_SCHEMA = 'plugins/codex-paper/skills/study/schemas/validation-report-1.0.schema.json'
const VALIDATION_ENGINE = 'plugins/codex-paper/skills/study/scripts/validation-report.js'
const VALIDATION_API = 'plugins/codex-paper/src/web/server/api/papers/[slug]/validation.get.ts'
const IDENTITY_SCHEMA = 'plugins/codex-paper/skills/study/schemas/paper-identity-1.0.schema.json'
const IDENTITY_ENGINE = 'plugins/codex-paper/skills/study/scripts/paper-identity.js'
const GENERATION_CONTRACT = 'plugins/codex-paper/skills/study/generation-contract-1.0.json'
const PREPARE_SCRIPT = 'plugins/codex-paper/skills/study/scripts/prepare-paper.js'
const LIBRARY_RESOLVER = 'plugins/codex-paper/src/shared/paper-library.mjs'
const CURRENT_SCHEMA = 'plugins/codex-paper/skills/study/schemas/paper-current-1.0.schema.json'
const PAPER_RECORD_SCHEMA = 'plugins/codex-paper/skills/study/schemas/paper-record-1.0.schema.json'
const OVERLAY_SCHEMA = 'plugins/codex-paper/skills/study/schemas/paper-overlay-1.0.schema.json'
const LAYOUT_TEST = 'scripts/tests/library-layout.test.mjs'
const STUDY_SKILL = 'plugins/codex-paper/skills/study/SKILL.md'
const SUMMARY_SKILL = 'plugins/codex-paper/skills/summary/SKILL.md'
const MANDATORY_SENTINELS = [
  MANDATORY_MANIFEST,
  MANDATORY_RUNNER,
  MANDATORY_WORKER,
  'benchmarks/mandatory/contract.mjs',
  'benchmarks/mandatory/authoring-boundary.mjs',
  FIXTURE_GENERATOR,
  CI_WORKFLOW,
  ROOT_SCRIPT,
]
const EXPECTED_DEFAULT_PROMPT_COUNT = 3
const EXPECTED_ACTIVE_PLUGIN = Object.freeze({
  name: 'codex-paper',
  sourcePath: 'plugins/codex-paper',
  marketplacePath: '.agents/plugins/marketplace.json',
  packageVersion: '2.0.0',
})
const FROZEN_SCHEMAS = Object.freeze({
  'evidence-ledger': Object.freeze({
    version: '2.0.0',
    path: 'plugins/codex-paper/skills/study/schemas/evidence-ledger.schema.json',
    sha256: '413d0a60300ea11ca0af36ef706f16904159e0df60a1448f5571d3dcec337df6',
  }),
  'external-evidence': Object.freeze({
    version: '2.0.0',
    path: 'plugins/codex-paper/skills/study/schemas/external-evidence.schema.json',
    sha256: 'ffa9e0dd916db8f17ac1995624e00dace08cf0ecf56e8623fbab36981d7d49ca',
  }),
  'reasoning-analysis': Object.freeze({
    version: '2.0.0',
    path: 'plugins/codex-paper/skills/study/schemas/reasoning-analysis.schema.json',
    sha256: '52fd874b0fb8843b2f175bb44cd7b4e93abfeefc431625db24918c310d1392c7',
  }),
})
const SENTINELS = [
  'plugins/codex-paper/.codex-plugin/plugin.json',
  'plugins/codex-paper/package.json',
  'plugins/codex-paper/package-lock.json',
  'plugins/codex-paper/skills/study/SKILL.md',
  'plugins/codex-paper/skills/study/scripts/sandbox-code.js',
  'plugins/codex-paper/skills/study/scripts/download-pdf.cjs',
  'plugins/codex-paper/skills/study/scripts/parse-pdf.js',
  FACTS_EXTRACTOR,
  FACTS_SCHEMA,
  PACKAGE_COMPATIBILITY,
  STUDY_VALIDATOR,
  MIGRATION_SCRIPT,
  VIEWER_COMPATIBILITY,
  VALIDATION_SCHEMA,
  VALIDATION_ENGINE,
  VALIDATION_API,
  IDENTITY_SCHEMA,
  IDENTITY_ENGINE,
  GENERATION_CONTRACT,
  PREPARE_SCRIPT,
  LIBRARY_RESOLVER,
  CURRENT_SCHEMA,
  PAPER_RECORD_SCHEMA,
  OVERLAY_SCHEMA,
  LAYOUT_TEST,
  SUMMARY_SKILL,
  'plugins/codex-paper/skills/study/scripts/pdf-parser-launcher.py',
  'plugins/codex-paper/skills/study/scripts/pdf-parser-worker.js',
  'plugins/codex-paper/skills/study/scripts/pdf-security-policy.json',
  'plugins/codex-paper/sandbox/Dockerfile',
  'plugins/codex-paper/sandbox/policy.json',
  'plugins/codex-paper/src/web/package.json',
  'plugins/codex-paper/hooks/hooks.json',
]
const CONFIG_EXTENSIONS = new Set([
  '.bash', '.cjs', '.js', '.json', '.mjs', '.mts', '.cts', '.py', '.sh', '.toml', '.ts', '.yaml', '.yml', '.zsh',
])
const LOCKFILE_NAMES = new Set([
  'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
])

function normalizePath(path) {
  return path.split(sep).join('/')
}

function readJson(path, errors, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`)
    return null
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function lexicallyExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function gitTrackedFiles(repoRoot) {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter(Boolean)
      // Keep dangling symlinks visible to lexical path checks. Deleted worktree
      // entries are excluded so an unstaged deletion can be validated before staging.
      .filter((path) => lexicallyExists(join(repoRoot, path)))
  } catch (error) {
    throw new Error(`cannot list tracked files: ${error.message}`)
  }
}

function generatedArtifactReason(path) {
  const segments = path.split('/')
  const basename = segments.at(-1) || ''

  if (segments.some((segment) => ['node_modules', '.nuxt', '.output', '.vitepress', '.vitepress.backup', 'dist', '__pycache__'].includes(segment))) {
    return 'generated directory'
  }
  if (basename === '.DS_Store') return 'macOS metadata'
  if (basename === '.installed') return 'installation marker'
  if (/\.(?:pyc|pyo)$/i.test(basename)) return 'Python bytecode'
  if (/\.(?:log|pid)$/i.test(basename)) return 'log/PID file'
  return null
}

function isSafeRepositoryRelativePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

function isExecutableOrConfig(repoRoot, path) {
  if (path === 'scripts/check-repository.mjs' || path.startsWith('scripts/tests/')) return false
  if (LOCKFILE_NAMES.has(basename(path))) return false
  if (CONFIG_EXTENSIONS.has(extname(path).toLowerCase())) return true
  try {
    return Boolean(statSync(join(repoRoot, path)).mode & 0o111)
  } catch {
    return false
  }
}

export function checkRepository({
  repoRoot = DEFAULT_REPO_ROOT,
  trackedFiles,
  actualActivePluginRelative = EXPECTED_ACTIVE_PLUGIN.sourcePath,
} = {}) {
  const root = resolve(repoRoot)
  const errors = []
  const tracked = (trackedFiles || gitTrackedFiles(root)).map(normalizePath)
  const trackedSet = new Set(tracked)

  if (actualActivePluginRelative !== EXPECTED_ACTIVE_PLUGIN.sourcePath) {
    errors.push(`root automation active plugin must be ${EXPECTED_ACTIVE_PLUGIN.sourcePath}; found ${JSON.stringify(actualActivePluginRelative)}`)
  }

  if (existsSync(join(root, LEGACY_TREE))) {
    errors.push(`legacy tree must not exist in the working tree: ${LEGACY_TREE}/`)
  }
  const trackedLegacy = tracked.filter((path) => path === LEGACY_TREE || path.startsWith(`${LEGACY_TREE}/`))
  if (trackedLegacy.length) {
    errors.push(`legacy tree contains tracked files: ${trackedLegacy.join(', ')}`)
  }
  for (const forbiddenPath of [DUPLICATE_MARKETPLACE, ORIGINAL_PLUGIN]) {
    if (existsSync(join(root, forbiddenPath)) || trackedSet.has(forbiddenPath)) {
      errors.push(`redundant plugin entry must not exist: ${forbiddenPath}`)
    }
  }

  for (const sentinel of SENTINELS) {
    if (!existsSync(join(root, sentinel))) errors.push(`active plugin sentinel is missing: ${sentinel}`)
    else if (isSymlink(join(root, sentinel))) errors.push(`active plugin sentinel must not be a symlink: ${sentinel}`)
  }
  for (const sentinel of MANDATORY_SENTINELS) {
    if (!existsSync(join(root, sentinel))) errors.push(`mandatory regression sentinel is missing: ${sentinel}`)
    else if (isSymlink(join(root, sentinel))) errors.push(`mandatory regression sentinel must not be a symlink: ${sentinel}`)
    if (trackedSet.has(MANDATORY_MANIFEST) && !trackedSet.has(sentinel)) errors.push(`mandatory regression sentinel must be tracked: ${sentinel}`)
  }

  const pluginManifests = tracked.filter((path) => path === '.codex-plugin/plugin.json' || path.endsWith('/.codex-plugin/plugin.json'))
  const canonicalManifest = `${EXPECTED_ACTIVE_PLUGIN.sourcePath}/.codex-plugin/plugin.json`
  if (pluginManifests.length !== 1 || pluginManifests[0] !== canonicalManifest) {
    errors.push(`tracked plugin manifests must contain only ${canonicalManifest}; found ${pluginManifests.join(', ') || 'none'}`)
  }

  const baseline = readJson(join(root, BASELINE_PATH), errors, BASELINE_PATH)
  if (isSymlink(join(root, BASELINE_PATH))) errors.push(`${BASELINE_PATH} must not be a symlink`)
  if (existsSync(join(root, BASELINE_PATH)) && sha256(join(root, BASELINE_PATH)) !== EXPECTED_BASELINE_SHA256) {
    errors.push(`${BASELINE_PATH} immutable baseline hash does not match ${EXPECTED_BASELINE_SHA256}`)
  }
  for (const [field, expected] of Object.entries(EXPECTED_ACTIVE_PLUGIN)) {
    if (baseline?.activePlugin?.[field] !== expected) {
      errors.push(`${BASELINE_PATH} activePlugin.${field} must be ${JSON.stringify(expected)}; found ${JSON.stringify(baseline?.activePlugin?.[field])}`)
    }
  }
  const activePath = EXPECTED_ACTIVE_PLUGIN.sourcePath
  const marketplacePath = EXPECTED_ACTIVE_PLUGIN.marketplacePath
  const manifestPath = join(root, activePath, '.codex-plugin/plugin.json')
  const packagePath = join(root, activePath, 'package.json')
  const lockPath = join(root, activePath, 'package-lock.json')
  const marketplace = readJson(join(root, marketplacePath), errors, marketplacePath)
  const manifest = readJson(manifestPath, errors, normalizePath(relative(root, manifestPath)))
  const packageJson = readJson(packagePath, errors, normalizePath(relative(root, packagePath)))
  const lockJson = readJson(lockPath, errors, normalizePath(relative(root, lockPath)))

  if (marketplace) {
    if (isSymlink(join(root, marketplacePath))) errors.push(`canonical marketplace must not be a symlink: ${marketplacePath}`)
    const entries = marketplace.plugins?.filter((entry) => entry?.name === 'codex-paper') || []
    if (entries.length !== 1) {
      errors.push(`canonical marketplace must contain exactly one codex-paper entry; found ${entries.length}`)
    } else {
      const source = entries[0].source
      if (source?.source !== 'local') errors.push('canonical marketplace source.source must be "local"')
      if (source?.path !== './plugins/codex-paper') {
        errors.push(`canonical marketplace source.path must be "./plugins/codex-paper"; found ${JSON.stringify(source?.path)}`)
      }
    }
  }

  if (manifest && packageJson && lockJson) {
    const folderName = basename(activePath)
    const names = [folderName, manifest.name, packageJson.name, lockJson.name, lockJson.packages?.['']?.name]
    if (names.some((name) => name !== folderName)) {
      errors.push(`active plugin names must match folder ${folderName}: ${names.map((name) => JSON.stringify(name)).join(', ')}`)
    }

    const baseVersion = String(manifest.version || '').split('+', 1)[0]
    const packageVersions = [packageJson.version, lockJson.version, lockJson.packages?.['']?.version]
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(baseVersion)) {
      errors.push(`plugin base version is not semver: ${JSON.stringify(baseVersion)}`)
    }
    if (packageVersions.some((version) => version !== baseVersion)) {
      errors.push(`plugin base version ${baseVersion} must match package and lockfile versions: ${packageVersions.join(', ')}`)
    }

    const defaultPrompts = manifest.interface?.defaultPrompt
    if (!Array.isArray(defaultPrompts) || defaultPrompts.length !== EXPECTED_DEFAULT_PROMPT_COUNT) {
      errors.push(`plugin interface.defaultPrompt must contain exactly ${EXPECTED_DEFAULT_PROMPT_COUNT} core prompts; found ${Array.isArray(defaultPrompts) ? defaultPrompts.length : 'non-array'}`)
    }
  }

  for (const path of tracked) {
    const reason = generatedArtifactReason(path)
    if (reason) errors.push(`tracked generated artifact (${reason}): ${path}`)
  }

  for (const pdfPath of tracked.filter((path) => path.toLowerCase().endsWith('.pdf'))) {
    if (!pdfPath.startsWith(FIXTURE_PDF_ROOT)) {
      errors.push(`tracked PDF is outside the fixture allowlist ${FIXTURE_PDF_ROOT}: ${pdfPath}`)
      continue
    }
    const absolutePdfPath = join(root, pdfPath)
    if (isSymlink(absolutePdfPath)) {
      errors.push(`fixture PDF must not be a symlink: ${pdfPath}`)
      continue
    }
    const manifestPath = `${pdfPath}.manifest.json`
    if (!trackedSet.has(manifestPath) || !existsSync(join(root, manifestPath))) {
      errors.push(`fixture PDF requires a tracked manifest: ${manifestPath}`)
      continue
    }
    if (isSymlink(join(root, manifestPath))) {
      errors.push(`fixture manifest must not be a symlink: ${manifestPath}`)
      continue
    }
    const fixtureManifest = readJson(join(root, manifestPath), errors, manifestPath)
    const requiredFields = baseline?.fixturePolicy?.requiredManifestFields || []
    const stringFields = requiredFields.filter((field) => field !== 'redistributable')
    for (const field of stringFields) {
      if (typeof fixtureManifest?.[field] !== 'string' || fixtureManifest[field].trim() === '') {
        errors.push(`fixture manifest ${manifestPath} field ${field} must be a non-empty string`)
      }
    }
    if (fixtureManifest?.redistributable !== true) {
      errors.push(`fixture manifest ${manifestPath} must set redistributable to true`)
    }
    if (fixtureManifest?.kind !== 'pdf') {
      errors.push(`fixture manifest ${manifestPath} kind must be "pdf"`)
    }
    if (typeof fixtureManifest?.spdx === 'string' && !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(fixtureManifest.spdx)) {
      errors.push(`fixture manifest ${manifestPath} spdx must be a valid SPDX identifier token`)
    }
    const allowedOrigins = baseline?.fixturePolicy?.allowedOrigins || []
    if (!allowedOrigins.includes(fixtureManifest?.origin)) {
      errors.push(`fixture manifest ${manifestPath} has unsupported origin: ${JSON.stringify(fixtureManifest?.origin)}`)
    }
    const actualPdfHash = sha256(absolutePdfPath)
    if (fixtureManifest?.sha256 !== actualPdfHash) {
      errors.push(`fixture manifest ${manifestPath} sha256 mismatch: expected ${actualPdfHash}, found ${fixtureManifest?.sha256}`)
    }
  }

  if (existsSync(join(root, MANDATORY_MANIFEST))) {
    const mandatory = readJson(join(root, MANDATORY_MANIFEST), errors, MANDATORY_MANIFEST)
    const fixtures = mandatory?.fixtures
    if (mandatory?.schemaVersion !== '1.0.0') errors.push(`${MANDATORY_MANIFEST} schemaVersion must be 1.0.0`)
    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      errors.push(`${MANDATORY_MANIFEST} must declare at least one fixture`)
    } else {
      const fixtureIds = new Set()
      for (const fixture of fixtures) {
        const fixtureId = fixture?.id
        if (typeof fixtureId !== 'string' || !fixtureId) {
          errors.push(`${MANDATORY_MANIFEST} fixture id must be a non-empty string`)
          continue
        }
        if (fixtureIds.has(fixtureId)) errors.push(`${MANDATORY_MANIFEST} has duplicate fixture id: ${fixtureId}`)
        fixtureIds.add(fixtureId)
        for (const field of ['pdf', 'licenseManifest', 'gold']) {
          const relativePath = fixture[field]
          if (!isSafeRepositoryRelativePath(relativePath)) {
            errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} has unsafe ${field} path`)
            continue
          }
          const absolutePath = join(root, relativePath)
          if (!existsSync(absolutePath)) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} ${field} is missing: ${relativePath}`)
          else if (isSymlink(absolutePath)) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} ${field} must not be a symlink: ${relativePath}`)
          if (trackedSet.has(MANDATORY_MANIFEST) && !trackedSet.has(relativePath)) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} ${field} must be tracked: ${relativePath}`)
        }
        if (![fixture.pdf, fixture.licenseManifest, fixture.gold].every((value) => isSafeRepositoryRelativePath(value) && existsSync(join(root, value)))) continue
        if (fixture.pdf !== `${FIXTURE_PDF_ROOT}${fixtureId}.pdf`) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} PDF path must match its id`)
        if (fixture.licenseManifest !== `${fixture.pdf}.manifest.json`) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} license manifest must be adjacent to its PDF`)
        const license = readJson(join(root, fixture.licenseManifest), errors, fixture.licenseManifest)
        const gold = readJson(join(root, fixture.gold), errors, fixture.gold)
        if (license?.id !== fixtureId || license?.origin !== 'original-synthetic' || license?.redistributable !== true) {
          errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} must use its original-synthetic redistributable license manifest`)
        }
        const expectedGenerator = `python3 ${FIXTURE_GENERATOR} --fixture ${fixtureId}`
        if (license?.generator !== expectedGenerator) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} generator mismatch`)
        if (license?.sha256 !== sha256(join(root, fixture.pdf))) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} sha256 mismatch`)
        if (gold?.schemaVersion !== '1.2.0' || gold?.fixtureId !== fixtureId) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} gold identity mismatch`)
        if (!gold?.requiredAssertions || !gold?.authoring) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} gold must define requiredAssertions and authoring`)
        if (!gold?.requiredAssertions?.resultClaims2_1 || !gold?.requiredAssertions?.validationReport1_0) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} must require B2 and Validation Report 1.0`)
        if (gold?.reservedTargets?.validationReport1_0) errors.push(`${MANDATORY_MANIFEST} fixture ${fixtureId} must activate, not reserve, Validation Report 1.0`)
      }
    }
  }

  if (existsSync(join(root, MANDATORY_WORKER))) {
    const worker = readFileSync(join(root, MANDATORY_WORKER), 'utf8')
    if (!worker.includes('preparePaper')) errors.push(`${MANDATORY_WORKER} must enter the bounded pipeline through preparePaper`)
    if (/parsePdfDetailedWorkerInternal|pdf-parser-worker|CODEX_PAPER_PARSER_WORKER|CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS/.test(worker)) {
      errors.push(`${MANDATORY_WORKER} must not bypass the parser supervisor or honor the optional skip flag`)
    }
  }
  if (existsSync(join(root, MANDATORY_RUNNER))) {
    const runner = readFileSync(join(root, MANDATORY_RUNNER), 'utf8')
    if (!runner.includes('mandatoryTotalsPass') || !runner.includes('executed') || /CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS/.test(runner)) {
      errors.push(`${MANDATORY_RUNNER} must fail closed on zero execution and must not honor the optional skip flag`)
    }
  }
  if (existsSync(join(root, ROOT_SCRIPT))) {
    const rootScript = readFileSync(join(root, ROOT_SCRIPT), 'utf8')
    if (!rootScript.includes('benchmark-mandatory') || !rootScript.includes('run-mandatory-benchmark.mjs')) {
      errors.push(`${ROOT_SCRIPT} must expose benchmark-mandatory`)
    }
    if (!rootScript.includes('validation-test') || !rootScript.includes('validation-report.test.mjs')) errors.push(`${ROOT_SCRIPT} must expose validation-test`)
    if (!rootScript.includes('identity-test') || !rootScript.includes('paper-identity.test.mjs') || !rootScript.includes('prepare-paper-identity.test.mjs')) {
      errors.push(`${ROOT_SCRIPT} must expose identity-test`)
    }
    if (!rootScript.includes('layout-test') || !rootScript.includes('library-layout.test.mjs')) errors.push(`${ROOT_SCRIPT} must expose layout-test`)
  }
  if (existsSync(join(root, CI_WORKFLOW))) {
    const workflow = readFileSync(join(root, CI_WORKFLOW), 'utf8')
    const mandatoryIndex = workflow.indexOf('benchmark-mandatory')
    const optionalIndex = workflow.indexOf('CODEX_PAPER_ALLOW_MISSING_BENCHMARK_PDFS')
    if (mandatoryIndex < 0 || optionalIndex < 0 || mandatoryIndex > optionalIndex) {
      errors.push(`${CI_WORKFLOW} must run benchmark-mandatory before the optional external corpus`)
    }
    const validationIndex = workflow.indexOf('validation-test')
    if (validationIndex < 0 || validationIndex > mandatoryIndex) errors.push(`${CI_WORKFLOW} must run validation-test before benchmark-mandatory`)
    const identityIndex = workflow.indexOf('identity-test')
    if (identityIndex < 0 || identityIndex > validationIndex || identityIndex > mandatoryIndex) {
      errors.push(`${CI_WORKFLOW} must run identity-test before validation-test and benchmark-mandatory`)
    }
    const layoutIndex = workflow.indexOf('layout-test')
    if (layoutIndex < 0 || layoutIndex > validationIndex || layoutIndex > mandatoryIndex) {
      errors.push(`${CI_WORKFLOW} must run layout-test before validation-test and benchmark-mandatory`)
    }
  }

  if (existsSync(join(root, LIBRARY_RESOLVER))) {
    const resolver = readFileSync(join(root, LIBRARY_RESOLVER), 'utf8')
    for (const required of ['managed_v1', 'legacy_flat', 'current.json', 'overlay', 'paperLockKey', 'generationLockKey']) {
      if (!resolver.includes(required)) errors.push(`${LIBRARY_RESOLVER} must implement ${required}`)
    }
  }
  for (const consumer of [
    PREPARE_SCRIPT,
    'plugins/codex-paper/skills/study/scripts/build-analysis.js',
    'plugins/codex-paper/skills/study/scripts/render-from-analysis.js',
    'plugins/codex-paper/skills/study/scripts/scaffold-reasoning-analysis.js',
    'plugins/codex-paper/skills/study/scripts/validate-reasoning.js',
    'plugins/codex-paper/skills/study/scripts/validate-study-package.js',
    'plugins/codex-paper/skills/study/scripts/sandbox-code.js',
    'plugins/codex-paper/src/web/server/utils/librarySecurity.mjs',
  ]) {
    if (!existsSync(join(root, consumer))) continue
    const source = readFileSync(join(root, consumer), 'utf8')
    if (!source.includes('paper-library.mjs')) errors.push(`${consumer} must use the shared paper library resolver`)
  }

  if (existsSync(join(root, GENERATION_CONTRACT))) {
    const contract = readJson(join(root, GENERATION_CONTRACT), errors, GENERATION_CONTRACT)
    if (contract?.version !== '1.0.0') {
      errors.push(`${GENERATION_CONTRACT} must declare version 1.0.0`)
    }
    for (const [group, paths] of [
      ['common', contract?.common],
      ['study', contract?.workflows?.study],
      ['summary', contract?.workflows?.summary],
    ]) {
      if (!Array.isArray(paths) || paths.length === 0) {
        errors.push(`${GENERATION_CONTRACT} trustedFiles.${group} must be non-empty`)
        continue
      }
      const seen = new Set()
      for (const contractPath of paths) {
        if (!isSafeRepositoryRelativePath(contractPath)) {
          errors.push(`${GENERATION_CONTRACT} trustedFiles.${group} contains unsafe path: ${JSON.stringify(contractPath)}`)
          continue
        }
        if (seen.has(contractPath)) errors.push(`${GENERATION_CONTRACT} trustedFiles.${group} contains duplicate path: ${contractPath}`)
        seen.add(contractPath)
        const absolutePath = join(root, EXPECTED_ACTIVE_PLUGIN.sourcePath, contractPath)
        if (!existsSync(absolutePath)) errors.push(`${GENERATION_CONTRACT} trustedFiles.${group} path is missing: ${contractPath}`)
        else if (isSymlink(absolutePath)) errors.push(`${GENERATION_CONTRACT} trustedFiles.${group} path must not be a symlink: ${contractPath}`)
      }
    }
    const allTrustedPaths = [
      ...(contract?.common || []),
      ...(contract?.workflows?.study || []),
      ...(contract?.workflows?.summary || []),
    ]
    for (const forbidden of ['.codex-plugin/plugin.json', 'package-lock.json']) {
      if (allTrustedPaths.includes(forbidden)) errors.push(`${GENERATION_CONTRACT} must exclude provenance-only file from fingerprint: ${forbidden}`)
    }
    if (!allTrustedPaths.includes('skills/study/scripts/paper-identity.js') || !allTrustedPaths.includes('skills/study/schemas/paper-identity-1.0.schema.json')) {
      errors.push(`${GENERATION_CONTRACT} must trust the Paper Identity engine and schema`)
    }
  }

  if (existsSync(join(root, IDENTITY_SCHEMA))) {
    const schema = readJson(join(root, IDENTITY_SCHEMA), errors, IDENTITY_SCHEMA)
    if (schema?.$id !== 'https://github.com/byxshr/codex-paper/schemas/paper-identity-1.0.schema.json'
      || schema?.properties?.schemaVersion?.const !== '1.0.0'
      || !schema?.required?.includes('paperId')
      || !schema?.required?.includes('generationId')) {
      errors.push(`${IDENTITY_SCHEMA} must preserve the strict Paper Identity 1.0 contract`)
    }
  }
  if (existsSync(join(root, IDENTITY_ENGINE))) {
    const source = readFileSync(join(root, IDENTITY_ENGINE), 'utf8')
    for (const required of ['CANONICAL_ID_CONFLICT', 'canonicalStringify', 'buildContentContract', "gen:sha256:", 'pluginBuildVersion']) {
      if (!source.includes(required)) errors.push(`${IDENTITY_ENGINE} must preserve identity boundary ${required}`)
    }
    if (!source.includes('sha256(canonicalStringify(generationInputs))')) {
      errors.push(`${IDENTITY_ENGINE} generation fingerprint must hash canonical inputs without provenance`)
    }
  }
  if (existsSync(join(root, PREPARE_SCRIPT))) {
    const source = readFileSync(join(root, PREPARE_SCRIPT), 'utf8')
    for (const required of ['resolvePreparationAction', 'PAPER_IDENTITY_RECONCILIATION_REQUIRED', 'RESUME_GENERATION_NOT_FOUND', 'COPYFILE_EXCL', 'IDENTITY_RELATIVE_PATH']) {
      if (!source.includes(required)) errors.push(`${PREPARE_SCRIPT} must preserve fail-closed identity boundary ${required}`)
    }
    if (/--force\b|force\s*:\s*true|copyFileSync\([^\n]*COPYFILE_FICLONE_FORCE/.test(source)) {
      errors.push(`${PREPARE_SCRIPT} must not restore overwrite or force preparation`)
    }
  }
  for (const [skillPath, workflow] of [[STUDY_SKILL, 'study'], [SUMMARY_SKILL, 'summary']]) {
    if (!existsSync(join(root, skillPath))) continue
    const source = readFileSync(join(root, skillPath), 'utf8')
    if (!source.includes(`--workflow ${workflow}`) || !source.includes('--language')) {
      errors.push(`${skillPath} must pass explicit --workflow ${workflow} and --language to prepare-paper.js`)
    }
  }

  const legacyReference = new RegExp(`(^|[^A-Za-z0-9_-])${LEGACY_TREE}/`)
  for (const path of tracked) {
    if (!isExecutableOrConfig(root, path)) continue
    try {
      const content = readFileSync(join(root, path), 'utf8')
      if (legacyReference.test(content)) errors.push(`executable/config references legacy path: ${path}`)
    } catch (error) {
      errors.push(`cannot inspect executable/config ${path}: ${error.message}`)
    }
  }

  for (const readmePath of ['README.md', 'README.zh-CN.md']) {
    if (!existsSync(join(root, readmePath))) continue
    const content = readFileSync(join(root, readmePath), 'utf8')
    if (!content.includes('plugins/codex-paper/') || !content.includes('.agents/plugins/marketplace.json')) {
      errors.push(`${readmePath} must document the canonical plugin and marketplace paths`)
    }
    if (/├── plugin\/|Historical source copy retained|历史源码副本保留在/.test(content)) {
      errors.push(`${readmePath} still presents the legacy tree as repository layout`)
    }
    if (legacyReference.test(content)) {
      errors.push(`${readmePath} references the legacy plugin path`)
    }
  }

  const validatorRelative = `${activePath}/skills/study/scripts/validate-study-package.js`
  const studySkillRelative = `${activePath}/skills/study/SKILL.md`
  const sandboxRunnerRelative = `${activePath}/skills/study/scripts/sandbox-code.js`
  const sandboxPolicyRelative = `${activePath}/sandbox/policy.json`
  const sandboxDockerfileRelative = `${activePath}/sandbox/Dockerfile`
  const validatorSource = existsSync(join(root, validatorRelative)) ? readFileSync(join(root, validatorRelative), 'utf8') : ''
  if (/node:child_process|from ['"]child_process['"]|require\(['"](?:node:)?child_process['"]\)/.test(validatorSource)) {
    errors.push(`${validatorRelative} must remain static-only and must not execute child processes`)
  }
  for (const prosePath of ['README.md', 'README.zh-CN.md', studySkillRelative]) {
    if (!existsSync(join(root, prosePath))) continue
    const content = readFileSync(join(root, prosePath), 'utf8')
    if (/validate-study-package\.js[^\n`]*--run-(?:code|artifacts)/.test(content)) {
      errors.push(`${prosePath} must not recommend legacy generated-code execution through the package validator`)
    }
  }
  if (existsSync(join(root, studySkillRelative))) {
    const studySkill = readFileSync(join(root, studySkillRelative), 'utf8')
    if (!studySkill.includes('does not authenticate a human') || !studySkill.includes('Never issue and consume a token in one uninterrupted turn')) {
      errors.push(`${studySkillRelative} must preserve the explicit human-consent workflow boundary`)
    }
  }
  if (existsSync(join(root, sandboxRunnerRelative))) {
    const runnerSource = readFileSync(join(root, sandboxRunnerRelative), 'utf8')
    if (/\bshell\s*:\s*true\b|import\s*\{[^}]*\bexec(?:File)?(?:Sync)?\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/.test(runnerSource)) {
      errors.push(`${sandboxRunnerRelative} must use argv-array process execution without a shell or exec fallback`)
    }
  }
  if (existsSync(join(root, sandboxDockerfileRelative))) {
    const dockerfile = readFileSync(join(root, sandboxDockerfileRelative), 'utf8')
    if (!/^ARG BASE_IMAGE=[^\s]+@sha256:[a-f0-9]{64}$/m.test(dockerfile)) {
      errors.push(`${sandboxDockerfileRelative} base image must be pinned to an exact sha256 manifest digest`)
    }
    if (/python3-minimal/.test(dockerfile) || !/apt-get install --yes --no-install-recommends python3(?:\s|\\)/.test(dockerfile)) {
      errors.push(`${sandboxDockerfileRelative} must install the Python 3 standard library required by the trusted entrypoint and demos`)
    }
  }
  if (existsSync(join(root, sandboxPolicyRelative))) {
    const policy = readJson(join(root, sandboxPolicyRelative), errors, sandboxPolicyRelative)
    if (!String(policy?.baseImage || '').match(/@sha256:[a-f0-9]{64}$/)) errors.push(`${sandboxPolicyRelative} baseImage must be digest-pinned`)
    if (policy?.policyVersion !== '1.0.0' || policy?.conformanceVersion !== '1.0.0') {
      errors.push(`${sandboxPolicyRelative} must declare P0-A3 policy and conformance version 1.0.0`)
    }
  }

  const pdfPolicyRelative = `${activePath}/skills/study/scripts/pdf-security-policy.json`
  const downloaderRelative = `${activePath}/skills/study/scripts/download-pdf.cjs`
  const parserRelative = `${activePath}/skills/study/scripts/parse-pdf.js`
  const parserWorkerRelative = `${activePath}/skills/study/scripts/pdf-parser-worker.js`
  const parserLauncherRelative = `${activePath}/skills/study/scripts/pdf-parser-launcher.py`
  const prepareRelative = `${activePath}/skills/study/scripts/prepare-paper.js`
  if (existsSync(join(root, pdfPolicyRelative))) {
    const policy = readJson(join(root, pdfPolicyRelative), errors, pdfPolicyRelative)
    const expected = {
      policyVersion: '1.0.0', httpsOnly: true, maxInputBytes: 134217728, maxPages: 2000,
      maxRedirects: 5, requestTimeoutMs: 30000, parserWallTimeMs: 60000,
      parserCpuSeconds: 45, parserMemoryBytes: 1073741824, parserOutputBytes: 67108864,
      parserStdoutBytes: 1048576, parserStderrBytes: 1048576, parserOpenFiles: 64,
      quarantineRetentionDays: 7, quarantineMaxEntries: 32, quarantineMaxBytes: 536870912,
    }
    for (const [field, value] of Object.entries(expected)) {
      if (policy?.[field] !== value) errors.push(`${pdfPolicyRelative} ${field} must be ${JSON.stringify(value)}`)
    }
  }
  if (existsSync(join(root, downloaderRelative))) {
    const source = readFileSync(join(root, downloaderRelative), 'utf8')
    for (const required of ['https.request', 'resolveSafeTarget', 'remoteAddress', 'O_EXCL', 'O_NOFOLLOW', '%PDF-']) {
      if (!source.includes(required)) errors.push(`${downloaderRelative} must preserve secure download boundary ${required}`)
    }
    if (/require\(['"](?:node:)?http['"]\)|codex-paper-downloads|url\.startsWith\(['"]http/.test(source)) {
      errors.push(`${downloaderRelative} must not restore HTTP or shared predictable staging`)
    }
  }
  if (existsSync(join(root, parserRelative))) {
    const source = readFileSync(join(root, parserRelative), 'utf8')
    for (const required of ['parserWallTimeMs', 'parserMemoryBytes', 'killParserGroup', 'copyPdfSnapshot', 'preflightPdfFile', 'quarantinePdf']) {
      if (!source.includes(required)) errors.push(`${parserRelative} must preserve bounded parser control ${required}`)
    }
  }
  if (existsSync(join(root, parserWorkerRelative))) {
    const source = readFileSync(join(root, parserWorkerRelative), 'utf8')
    if (!source.includes('CODEX_PAPER_PARSER_WORKER') || !source.includes('parserOutputBytes')) {
      errors.push(`${parserWorkerRelative} must remain supervisor-only and output-bounded`)
    }
  }
  if (existsSync(join(root, parserLauncherRelative))) {
    const source = readFileSync(join(root, parserLauncherRelative), 'utf8')
    for (const required of ['RLIMIT_CPU', 'RLIMIT_FSIZE', 'RLIMIT_NOFILE', 'os.execve']) {
      if (!source.includes(required)) errors.push(`${parserLauncherRelative} must preserve hard parser resource limit ${required}`)
    }
  }
  if (existsSync(join(root, prepareRelative))) {
    const source = readFileSync(join(root, prepareRelative), 'utf8')
    if (!source.includes('stagePdfInput') || !source.includes('resolvedInput.cleanup()') || /execFileSync/.test(source)) {
      errors.push(`${prepareRelative} must use and clean secure PDF staging without a downloader subprocess`)
    }
    for (const required of ["const PACKAGE_VERSION = '2.1.0'", "const EVIDENCE_SCHEMA_VERSION = '2.0.0'", 'buildFactsFromLedger', 'validateFactsSchema(facts)']) {
      if (!source.includes(required)) errors.push(`${prepareRelative} must preserve package 2.1 writer boundary ${required}`)
    }
    if (/evidenceSchemaVersion:\s*PACKAGE_VERSION/.test(source)) errors.push(`${prepareRelative} must not couple frozen evidence schema to package contract version`)
  }

  if (existsSync(join(root, FACTS_SCHEMA))) {
    const factsSchema = readJson(join(root, FACTS_SCHEMA), errors, FACTS_SCHEMA)
    if (factsSchema?.properties?.schemaVersion?.const !== '2.1.0' || !factsSchema?.properties?.resultClaims) {
      errors.push(`${FACTS_SCHEMA} must define facts schema 2.1 with resultClaims`)
    }
  }
  if (existsSync(join(root, FACTS_EXTRACTOR))) {
    const source = readFileSync(join(root, FACTS_EXTRACTOR), 'utf8')
    for (const required of ['extractResultClaims', 'projectKeyResults', 'validateFactsEvidenceRefs', 'PAPER_EVIDENCE_ID_PATTERN', 'compareCandidatesForMerge']) {
      if (!source.includes(required)) errors.push(`${FACTS_EXTRACTOR} must preserve ResultClaim writer boundary ${required}`)
    }
  }
  if (existsSync(join(root, PACKAGE_COMPATIBILITY))) {
    const source = readFileSync(join(root, PACKAGE_COMPATIBILITY), 'utf8')
    for (const required of ['native_2_1', 'compatible_2_0', 'legacy_v1', 'unknown_read_only', 'PACKAGE_VERSION_UNSUPPORTED', 'PACKAGE_ARTIFACT_INVALID', 'assertWritablePackage', 'evidenceRefExists', 'isLegacyMigrationSourceVersion', 'classifyInvalidPackageArtifacts', 'unsupportedVersions']) {
      if (!source.includes(required)) errors.push(`${PACKAGE_COMPATIBILITY} must preserve reader compatibility mode ${required}`)
    }
  }
  if (existsSync(join(root, STUDY_VALIDATOR))) {
    const source = readFileSync(join(root, STUDY_VALIDATOR), 'utf8')
    if (!source.includes('LEGACY_PACKAGE_REQUIRES_LEGACY_OK')) errors.push(`${STUDY_VALIDATOR} must preserve explicit read-only legacy validation`)
    if (!source.includes('classifyInvalidPackageArtifacts')) errors.push(`${STUDY_VALIDATOR} must diagnose corrupt compatibility artifacts`)
  }
  if (existsSync(join(root, MIGRATION_SCRIPT))) {
    const source = readFileSync(join(root, MIGRATION_SCRIPT), 'utf8')
    if (!source.includes('MIGRATION_SOURCE_VERSION_UNSUPPORTED')) errors.push(`${MIGRATION_SCRIPT} must reject unsupported versions before migration writes`)
    if (!source.includes('isLegacyMigrationSourceVersion')) errors.push(`${MIGRATION_SCRIPT} must preserve explicit 1.x migration without partial writes`)
    if (!source.includes('classifyPackageCompatibility({ reasoning: existingReasoning, ledger: existingLedger })')) errors.push(`${MIGRATION_SCRIPT} must preflight ancillary artifact versions before migration writes`)
    if (!source.includes('classifyInvalidPackageArtifacts')) errors.push(`${MIGRATION_SCRIPT} must diagnose corrupt migration inputs before writes`)
  }
  if (existsSync(join(root, VIEWER_COMPATIBILITY))) {
    const source = readFileSync(join(root, VIEWER_COMPATIBILITY), 'utf8')
    if (!source.includes('classifyStoredPackageCompatibility')) errors.push(`${VIEWER_COMPATIBILITY} must preserve cross-endpoint compatibility classification`)
    if (!source.includes('classifyInvalidPackageArtifacts')) errors.push(`${VIEWER_COMPATIBILITY} must preserve corrupt-artifact compatibility diagnostics`)
    if (!source.includes("readCompatibilityArtifact(slug, 'meta.json'")) errors.push(`${VIEWER_COMPATIBILITY} must preserve corrupt-meta compatibility fallback`)
  }
  if (existsSync(join(root, VALIDATION_ENGINE))) {
    const source = readFileSync(join(root, VALIDATION_ENGINE), 'utf8')
    for (const required of ['pass_with_warnings', 'allow_authoring', 'allow_publish', 'reportHash', 'writeValidationReportAtomic', 'RESULT_VALUE_CONFLICT', 'PARSER_FRONT_MATTER_CONTAMINATION']) {
      if (!source.includes(required)) errors.push(`${VALIDATION_ENGINE} must preserve Validation Report 1.0 contract ${required}`)
    }
    if (source.includes('validation-report-v2') || source.includes('validation-report-1.0.json')) errors.push(`${VALIDATION_ENGINE} must write only .codex-paper/validation-report.json`)
  }

  if (Array.isArray(baseline?.schemas)) {
    const declaredNames = baseline.schemas.map((schema) => schema.name).sort()
    const expectedNames = Object.keys(FROZEN_SCHEMAS).sort()
    if (JSON.stringify(declaredNames) !== JSON.stringify(expectedNames)) {
      errors.push(`${BASELINE_PATH} must declare exactly the frozen schemas: ${expectedNames.join(', ')}`)
    }
    for (const [name, expected] of Object.entries(FROZEN_SCHEMAS)) {
      const schema = baseline.schemas.find((candidate) => candidate.name === name)
      if (!schema) continue
      for (const field of ['version', 'path', 'sha256']) {
        if (schema[field] !== expected[field]) {
          errors.push(`${BASELINE_PATH} schema ${name}.${field} must be ${JSON.stringify(expected[field])}; found ${JSON.stringify(schema[field])}`)
        }
      }
      const schemaPath = join(root, expected.path)
      if (!existsSync(schemaPath)) {
        errors.push(`frozen schema is missing: ${expected.path}`)
        continue
      }
      if (isSymlink(schemaPath)) {
        errors.push(`frozen schema must not be a symlink: ${expected.path}`)
        continue
      }
      const actualHash = sha256(schemaPath)
      if (actualHash !== expected.sha256) {
        errors.push(`frozen schema hash mismatch: ${expected.path} expected ${expected.sha256}, found ${actualHash}`)
      }
    }
  } else {
    errors.push(`${BASELINE_PATH} must declare schemas`)
  }

  return { ok: errors.length === 0, errors, trackedFileCount: tracked.length }
}

function parseCliArgs(argv) {
  const parsed = {
    repoRoot: DEFAULT_REPO_ROOT,
    actualActivePluginRelative: EXPECTED_ACTIVE_PLUGIN.sourcePath,
  }
  const optionTargets = new Map([
    ['--repo-root', 'repoRoot'],
    ['--active-plugin-relative', 'actualActivePluginRelative'],
  ])
  const seen = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const target = optionTargets.get(option)
    if (!target) throw new Error(`unknown option: ${option}`)
    if (seen.has(option)) throw new Error(`duplicate option: ${option}`)

    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)

    parsed[target] = target === 'repoRoot' ? resolve(value) : value
    seen.add(option)
    index += 1
  }

  return parsed
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkRepository(parseCliArgs(process.argv.slice(2)))
    if (!result.ok) {
      console.error(`Repository contract failed with ${result.errors.length} error(s):`)
      for (const error of result.errors) console.error(`- ${error}`)
      process.exitCode = 1
    } else {
      console.log(`Repository contract passed (${result.trackedFileCount} tracked files inspected).`)
    }
  } catch (error) {
    console.error(`Repository contract could not run: ${error.message}`)
    process.exitCode = 1
  }
}
