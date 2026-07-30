import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { writeAuthoringBoundary } from '../../benchmarks/mandatory/authoring-boundary.mjs'
import { preparePaper } from '../../plugins/codex-paper/skills/study/scripts/prepare-paper.js'
import {
  buildManagedIndexEntries,
  publishGenerationWorkspace,
  rebuildLibraryIndex,
  recoverPublications,
} from '../../plugins/codex-paper/src/shared/generation-publication.mjs'
import {
  inventoryGenerationFiles,
  unsealGenerationPackageForLifecycle,
  verifyGenerationManifest,
} from '../../plugins/codex-paper/src/shared/generation-manifest.mjs'
import { collectRuntimeAttestation } from '../../plugins/codex-paper/src/shared/generation-provenance.mjs'
import {
  isActiveGenerationWorkspace,
  listGenerationWorkspaces,
  resolveGenerationWorkspace,
  setWorkspaceTags,
  writeWorkspaceAuthoring,
} from '../../plugins/codex-paper/src/shared/generation-workspace.mjs'
import { resolveLibraryPaper } from '../../plugins/codex-paper/src/shared/paper-library.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixtures = Object.fromEntries(['front-matter-noise', 'result-conflict'].map((fixtureId) => [fixtureId, {
  fixtureId,
  pdf: path.join(repoRoot, `benchmarks/fixtures/pdf/${fixtureId}.pdf`),
  gold: JSON.parse(fs.readFileSync(path.join(repoRoot, `benchmarks/mandatory/gold/${fixtureId}.json`), 'utf8')),
}]))
const pluginScripts = path.join(repoRoot, 'plugins/codex-paper/skills/study/scripts')

function temporaryLibrary(t) {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-publication-'))
  fs.writeFileSync(path.join(libraryRoot, 'index.json'), '[]\n')
  t.after(() => {
    if (fs.existsSync(libraryRoot)) fs.chmodSync(libraryRoot, 0o700)
    for (const entry of fs.existsSync(libraryRoot) ? fs.readdirSync(libraryRoot, { recursive: true }) : []) {
      const candidate = path.join(libraryRoot, entry)
      try { fs.chmodSync(candidate, fs.lstatSync(candidate).isDirectory() ? 0o700 : 0o600) } catch {}
    }
    fs.rmSync(libraryRoot, { recursive: true, force: true })
  })
  return libraryRoot
}

function validator(name, paperDir, libraryRoot, args) {
  return spawnSync(process.execPath, [path.join(pluginScripts, name), paperDir, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PAPERS_DIR: libraryRoot },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
}

async function prepareValidated(libraryRoot, { strict = false, profile = 'empirical', fixtureId = 'front-matter-noise' } = {}) {
  const previous = process.env.PAPERS_DIR
  process.env.PAPERS_DIR = libraryRoot
  try {
    const fixture = fixtures[fixtureId]
    const prepared = await preparePaper(fixture.pdf, { libraryRoot, contextMode: 'paper-only', profile, workflow: 'study', language: 'en' })
    await writeAuthoringBoundary({ paperDir: prepared.paperDir, fixtureId, gold: fixture.gold, ledger: prepared.ledger })
    const args = ['--lang', 'en', '--json', ...(strict ? ['--strict'] : [])]
    const result = validator('validate-study-package.js', prepared.paperDir, libraryRoot, args)
    assert.equal(result.status, strict ? 1 : 0, result.stderr || result.stdout)
    return { libraryRoot, prepared }
  } finally {
    if (previous === undefined) delete process.env.PAPERS_DIR
    else process.env.PAPERS_DIR = previous
  }
}

async function validatedWorkspace(t, options = {}) {
  const libraryRoot = temporaryLibrary(t)
  return prepareValidated(libraryRoot, options)
}

test('publication requires the intrinsic standard allow_publish gate', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t, { strict: true })
  await assert.rejects(publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 }), { code: 'PUBLICATION_GATE_BLOCKED' })
  assert.equal(fs.existsSync(prepared.paperDir), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8')), [])
})

test('reindex preserves legacy papers and the existing index envelope', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const legacy = path.join(libraryRoot, 'papers', 'legacy-paper')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'meta.json'), `${JSON.stringify({ title: 'Legacy Paper', tags: ['legacy'] })}\n`)
  fs.writeFileSync(path.join(libraryRoot, 'index.json'), `${JSON.stringify({ schemaVersion: 'legacy-envelope', papers: [], retained: true })}\n`)
  const indexResult = await rebuildLibraryIndex({ libraryRoot, lockTimeoutMs: 0 })
  assert.deepEqual(indexResult.entries.map((entry) => entry.slug), ['legacy-paper'])
  assert.deepEqual(indexResult.diagnostics, [])
  const index = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8'))
  assert.equal(index.schemaVersion, 'legacy-envelope')
  assert.equal(index.retained, true)
  assert.equal(index.papers[0].title, 'Legacy Paper')
})

test('publication rejects a route claimed by a legacy paper before current commit', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  const legacy = path.join(libraryRoot, 'papers', prepared.paperSlug)
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'meta.json'), `${JSON.stringify({ title: 'Legacy owner' })}\n`)
  await assert.rejects(publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 }), { code: 'PUBLICATION_ROUTE_CONFLICT' })
  assert.deepEqual(fs.readdirSync(path.join(libraryRoot, '.codex-paper/store-v1/papers')), [])
})

test('publication seals one immutable generation and commits current before index visibility', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  const driftedRuntime = collectRuntimeAttestation(process.env, {
    node: '22.23.1',
    npm: '10.9.8',
    python: {
      version: '3.11.15',
      implementation: 'CPython',
      pyMuPDF: '1.28.0',
    },
  })
  driftedRuntime.host.node = '22.23.2'
  await assert.rejects(
    publishGenerationWorkspace(prepared.workspaceId, {
      libraryRoot,
      lockTimeoutMs: 0,
      runtimeAttestation: driftedRuntime,
    }),
    { code: 'PUBLICATION_RUNTIME_MISMATCH' },
  )
  assert.equal(resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot }).workspace.state, 'validated')
  const published = await publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(published.published, true)
  const descriptor = resolveLibraryPaper(prepared.paperSlug, { libraryRoot })
  assert.equal(descriptor.mode, 'managed_v1')
  assert.equal(descriptor.current.manifestId, published.manifestId)
  assert.equal(descriptor.integrity.verified, true)
  assert.equal(descriptor.manifest.validation.reportHash, descriptor.current.validationReportHash)
  const verified = verifyGenerationManifest(descriptor.packageDir, {
    manifestId: descriptor.current.manifestId,
    manifestHash: descriptor.current.manifestHash,
    manifestFileSha256: descriptor.current.manifestFileSha256,
    paperKey: descriptor.paperKey,
    generationId: descriptor.generationId,
  })
  assert.equal(verified.manifest.manifestId, published.manifestId)
  const residue = resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot })
  assert.equal(residue.publicationResidue, true)
  assert.equal(residue.readOnly, true)
  assert.equal(isActiveGenerationWorkspace(residue), false)
  const index = JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8'))
  assert.equal(index.length, 1)
  assert.equal(index[0].generationManifest.manifestId, published.manifestId)
  const provenanceCli = path.join(pluginScripts, 'provenance-cli.js')
  const provenance = spawnSync(process.execPath, [provenanceCli, 'verify', prepared.paperSlug, '--json'], {
    cwd: repoRoot,
    env: { ...process.env, PAPERS_DIR: libraryRoot },
    encoding: 'utf8',
  })
  assert.equal(provenance.status, 0, provenance.stderr)
  assert.equal(JSON.parse(provenance.stdout).mode, 'native_2_0')
  const outsideReports = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-outside-execution-'))
  fs.symlinkSync(outsideReports, path.join(descriptor.overlayDir, 'execution-reports'))
  const unsafeProvenance = spawnSync(process.execPath, [provenanceCli, 'verify', prepared.paperSlug, '--json'], {
    cwd: repoRoot,
    env: { ...process.env, PAPERS_DIR: libraryRoot },
    encoding: 'utf8',
  })
  assert.equal(unsafeProvenance.status, 1)
  assert.match(unsafeProvenance.stderr, /PROVENANCE_EXECUTION_INVALID/)
  assert.equal(unsafeProvenance.stderr.includes(libraryRoot), false)
  fs.rmSync(path.join(descriptor.overlayDir, 'execution-reports'))
  fs.rmSync(outsideReports, { recursive: true, force: true })
  assert.deepEqual(await recoverPublications({ libraryRoot, lockTimeoutMs: 0 }), [])
  assert.equal(fs.readFileSync(path.join(prepared.workspaceDir, 'publication.json'), 'utf8').includes(fs.realpathSync(libraryRoot)), false)
})

test('a later generation switches current without mutating the old generation or overlay', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const first = await prepareValidated(libraryRoot, { profile: 'empirical' })
  await setWorkspaceTags(first.prepared.workspaceId, ['translation'], { libraryRoot, lockTimeoutMs: 0 })
  await publishGenerationWorkspace(first.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  const firstDescriptor = resolveLibraryPaper(first.prepared.paperSlug, { libraryRoot })
  const firstManifest = firstDescriptor.current.manifestId
  const firstPackage = firstDescriptor.packageDir

  const second = await prepareValidated(libraryRoot, { profile: 'auto' })
  assert.notEqual(second.prepared.identity.generationId, first.prepared.identity.generationId)
  await publishGenerationWorkspace(second.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  const current = resolveLibraryPaper(first.prepared.paperSlug, { libraryRoot })
  assert.equal(current.generationId, second.prepared.identity.generationId)
  assert.notEqual(current.current.manifestId, firstManifest)
  assert.equal(fs.existsSync(firstPackage), true)
  assert.equal(verifyGenerationManifest(firstPackage, { manifestId: firstManifest }).manifest.manifestId, firstManifest)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current.overlayDir, 'state.json'), 'utf8')).tags, ['translation'])
})

test('manifest drift blocks authoritative resolution without coupling index availability', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  await publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  const descriptor = resolveLibraryPaper(prepared.paperSlug, { libraryRoot })
  const summary = path.join(descriptor.packageDir, 'summary.md')
  fs.chmodSync(summary, 0o600)
  fs.appendFileSync(summary, '\nsynthetic drift\n')
  assert.throws(() => resolveLibraryPaper(prepared.paperSlug, { libraryRoot }), { code: 'GENERATION_MANIFEST_DIRTY' })
  const rebuilt = await rebuildLibraryIndex({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(rebuilt.entries.length, 1)
  assert.deepEqual(rebuilt.diagnostics, [])
})

test('journal recovery completes an interruption after generation commit', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  await assert.rejects(
    publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_generation_commit' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const residue = resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot })
  assert.equal(residue.publicationResidue, true)
  assert.throws(() => resolveLibraryPaper(prepared.paperSlug, { libraryRoot }), { code: 'PAPER_NOT_FOUND' })
  const recovered = await recoverPublications({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].success, true)
  assert.equal(resolveLibraryPaper(prepared.paperSlug, { libraryRoot }).generationId, prepared.identity.generationId)
})

test('a sealed workspace becomes read-only before its package is moved', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  await assert.rejects(
    publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_manifest' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const sealed = resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot })
  assert.equal(sealed.publicationResidue, true)
  assert.equal(sealed.publicationDetached, false)
  assert.equal(sealed.readOnly, true)
  assert.equal(isActiveGenerationWorkspace(sealed), true)
  await assert.rejects(
    preparePaper(fixtures['front-matter-noise'].pdf, { libraryRoot, contextMode: 'paper-only', profile: 'empirical', workflow: 'study', language: 'en' }),
    { code: 'WORKSPACE_EXISTS' }
  )
  await assert.rejects(
    writeWorkspaceAuthoring(prepared.workspaceId, 'summary.md', '# changed\n', { expectedSha256: '0'.repeat(64) }, { libraryRoot, lockTimeoutMs: 0 }),
    { code: 'WORKSPACE_PUBLICATION_IN_PROGRESS' }
  )
  const recovered = await recoverPublications({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(recovered[0].success, true)
})

test('current remains authoritative when index publication is interrupted and reindex is deterministic', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  await assert.rejects(
    publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_current_commit' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const interruptedJournal = JSON.parse(fs.readFileSync(path.join(prepared.workspaceDir, 'publication.json'), 'utf8'))
  assert.equal(interruptedJournal.state, 'current_committed')
  const descriptor = resolveLibraryPaper(prepared.paperSlug, { libraryRoot })
  const publishedAt = descriptor.current.publishedAt
  assert.equal(descriptor.integrity.verified, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8')), [])
  const expected = buildManagedIndexEntries(libraryRoot)
  const rebuilt = await rebuildLibraryIndex({ libraryRoot, lockTimeoutMs: 0 })
  assert.deepEqual(rebuilt.entries, expected)
  assert.deepEqual(rebuilt.diagnostics, [])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'), 'utf8')), expected)
  const recovered = await recoverPublications({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(recovered[0].success, true)
  assert.equal(resolveLibraryPaper(prepared.paperSlug, { libraryRoot }).current.publishedAt, publishedAt)
})

test('manifest inventory uses global path order for directory and file siblings', (t) => {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-manifest-order-'))
  t.after(() => fs.rmSync(packageDir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(packageDir, 'notes'))
  fs.writeFileSync(path.join(packageDir, 'notes', 'x.md'), 'nested\n')
  fs.writeFileSync(path.join(packageDir, 'notes.md'), 'sibling\n')
  fs.mkdirSync(path.join(packageDir, 'data'))
  fs.writeFileSync(path.join(packageDir, 'data', 'x.json'), '{}\n')
  fs.writeFileSync(path.join(packageDir, 'data.json'), '{}\n')
  assert.deepEqual(inventoryGenerationFiles(packageDir).map((item) => item.path), [
    'data.json', 'data/x.json', 'notes.md', 'notes/x.md',
  ])
})

test('new-paper staging recovers after payload rename before record metadata', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  await assert.rejects(
    publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_new_payload_rename' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const detached = resolveGenerationWorkspace(prepared.workspaceId, { libraryRoot })
  assert.equal(detached.publicationDetached, true)
  const journal = JSON.parse(fs.readFileSync(path.join(prepared.workspaceDir, 'publication.json'), 'utf8'))
  const stagingPackage = path.join(libraryRoot, '.codex-paper/store-v1/papers', `.publish-${journal.transactionId}-${journal.paperKey}`, ...journal.targetPackageRelativePath.split('/'))
  assert.equal(fs.statSync(stagingPackage).mode & 0o777, 0o700)
  const recovered = await recoverPublications({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(recovered.find((item) => item.workspaceId === prepared.workspaceId)?.success, true)
  const published = resolveLibraryPaper(prepared.paperSlug, { libraryRoot })
  assert.equal(published.generationId, prepared.identity.generationId)
  assert.equal(fs.statSync(published.packageDir).mode & 0o777, 0o500)
  assert.equal(fs.statSync(path.join(published.packageDir, 'summary.md')).mode & 0o777, 0o400)
})

test('one corrupt journal is diagnosed without blocking healthy recovery', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const poisoned = await prepareValidated(libraryRoot, { fixtureId: 'front-matter-noise' })
  await assert.rejects(
    publishGenerationWorkspace(poisoned.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_manifest' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const journalPath = path.join(poisoned.prepared.workspaceDir, 'publication.json')
  fs.writeFileSync(journalPath, '{not-json\n', { mode: 0o600 })
  const poisonedDescriptor = resolveGenerationWorkspace(poisoned.prepared.workspaceId, { libraryRoot })
  assert.equal(poisonedDescriptor.publicationInvalid, true)
  assert.equal(poisonedDescriptor.publicationState, 'invalid')
  assert.equal(poisonedDescriptor.publicationDiagnostic.code, 'PUBLICATION_JOURNAL_INVALID')

  const symlinked = await prepareValidated(libraryRoot, { fixtureId: 'front-matter-noise', profile: 'auto' })
  await assert.rejects(
    publishGenerationWorkspace(symlinked.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_manifest' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const symlinkedJournal = path.join(symlinked.prepared.workspaceDir, 'publication.json')
  fs.rmSync(symlinkedJournal)
  fs.symlinkSync(path.join(symlinked.prepared.workspaceDir, 'workspace.json'), symlinkedJournal)
  const listedSymlink = listGenerationWorkspaces({ libraryRoot }).find((item) => item.workspaceId === symlinked.prepared.workspaceId)
  assert.equal(listedSymlink.publicationInvalid, true)
  assert.equal(listedSymlink.publicationDiagnostic.code, 'WORKSPACE_PATH_UNSAFE')

  const healthy = await prepareValidated(libraryRoot, { fixtureId: 'result-conflict' })
  await assert.rejects(
    publishGenerationWorkspace(healthy.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_manifest' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const recovered = await recoverPublications({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(recovered.find((item) => item.workspaceId === poisoned.prepared.workspaceId)?.success, false)
  assert.equal(recovered.find((item) => item.workspaceId === poisoned.prepared.workspaceId)?.code, 'PUBLICATION_JOURNAL_INVALID')
  assert.equal(recovered.find((item) => item.workspaceId === symlinked.prepared.workspaceId)?.success, false)
  assert.equal(recovered.find((item) => item.workspaceId === symlinked.prepared.workspaceId)?.code, 'STORAGE_PATH_UNSAFE')
  assert.equal(recovered.find((item) => item.workspaceId === healthy.prepared.workspaceId)?.success, true)
  assert.equal(resolveLibraryPaper(healthy.prepared.paperSlug, { libraryRoot }).generationId, healthy.prepared.identity.generationId)
})

test('corrupt managed manifests are isolated from publication and reindex', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const first = await prepareValidated(libraryRoot, { fixtureId: 'front-matter-noise' })
  await publishGenerationWorkspace(first.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  const firstDescriptor = resolveLibraryPaper(first.prepared.paperSlug, { libraryRoot })
  const manifestPath = path.join(firstDescriptor.packageDir, '.codex-paper', 'generation-manifest.json')
  fs.chmodSync(manifestPath, 0o600)
  fs.writeFileSync(manifestPath, '{broken\n')

  const second = await prepareValidated(libraryRoot, { fixtureId: 'result-conflict' })
  const published = await publishGenerationWorkspace(second.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  assert.equal(published.published, true)
  assert.equal(published.indexDiagnostics.some((item) => item.paperKey === firstDescriptor.paperKey && item.code === 'GENERATION_MANIFEST_INVALID'), true)
  assert.equal(resolveLibraryPaper(second.prepared.paperSlug, { libraryRoot }).generationId, second.prepared.identity.generationId)
  assert.throws(() => resolveLibraryPaper(first.prepared.paperSlug, { libraryRoot }), { code: 'GENERATION_MANIFEST_INVALID' })

  const rebuilt = await rebuildLibraryIndex({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(rebuilt.entries.some((item) => item.slug === first.prepared.paperSlug), false)
  assert.equal(rebuilt.entries.some((item) => item.slug === second.prepared.paperSlug), true)
  assert.equal(rebuilt.diagnostics.some((item) => item.paperKey === firstDescriptor.paperKey), true)
})

test('sealed package lifecycle unseal is explicit and no-follow', async (t) => {
  const { libraryRoot, prepared } = await validatedWorkspace(t)
  await publishGenerationWorkspace(prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  const descriptor = resolveLibraryPaper(prepared.paperSlug, { libraryRoot })
  assert.throws(() => unsealGenerationPackageForLifecycle(descriptor.packageDir), { code: 'GENERATION_LIFECYCLE_AUTHORIZATION_REQUIRED' })
  assert.throws(() => unsealGenerationPackageForLifecycle(descriptor.packageDir, { authorized: true }), { code: 'GENERATION_LIFECYCLE_CONTAINMENT_REQUIRED' })
  const aliasRoot = path.join(libraryRoot, 'package-alias')
  fs.symlinkSync(descriptor.packageDir, aliasRoot)
  assert.throws(() => unsealGenerationPackageForLifecycle(aliasRoot, { authorized: true, containmentRoot: descriptor.paperRoot }), { code: 'GENERATION_MANIFEST_PATH_UNSAFE' })
  unsealGenerationPackageForLifecycle(descriptor.packageDir, { authorized: true, containmentRoot: descriptor.paperRoot })
  assert.equal(fs.statSync(descriptor.packageDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(descriptor.packageDir, 'summary.md')).mode & 0o777, 0o600)
  assert.equal(verifyGenerationManifest(descriptor.packageDir, { manifestId: descriptor.current.manifestId }).manifest.manifestId, descriptor.current.manifestId)
})

test('existing-paper recovery re-seals a generation after rename interruption', async (t) => {
  const libraryRoot = temporaryLibrary(t)
  const first = await prepareValidated(libraryRoot, { fixtureId: 'front-matter-noise', profile: 'empirical' })
  await publishGenerationWorkspace(first.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0 })
  const second = await prepareValidated(libraryRoot, { fixtureId: 'front-matter-noise', profile: 'auto' })
  await assert.rejects(
    publishGenerationWorkspace(second.prepared.workspaceId, { libraryRoot, lockTimeoutMs: 0, faultAt: 'after_existing_payload_rename' }),
    { code: 'PUBLICATION_FAULT_INJECTED' }
  )
  const journal = JSON.parse(fs.readFileSync(path.join(second.prepared.workspaceDir, 'publication.json'), 'utf8'))
  const recordDir = path.join(libraryRoot, '.codex-paper/store-v1/papers', journal.paperKey)
  const target = path.join(recordDir, ...journal.targetPackageRelativePath.split('/'))
  assert.equal(fs.statSync(target).mode & 0o777, 0o700)
  const recovered = await recoverPublications({ libraryRoot, lockTimeoutMs: 0 })
  assert.equal(recovered.find((item) => item.workspaceId === second.prepared.workspaceId)?.success, true)
  const current = resolveLibraryPaper(second.prepared.paperSlug, { libraryRoot })
  assert.equal(current.generationId, second.prepared.identity.generationId)
  assert.equal(fs.statSync(current.packageDir).mode & 0o777, 0o500)
  assert.equal(fs.statSync(path.join(current.packageDir, 'summary.md')).mode & 0o777, 0o400)
})
