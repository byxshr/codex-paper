import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildPublicFileTree,
  normalizeRelativePath,
  readFileNoFollow,
  requirePaperDir,
  resolvePublicFile,
  writeFileAtomic,
} from '../../plugins/codex-paper/src/web/server/utils/librarySecurity.mjs'
import { resetOperationLocksForTests, tryAcquireLocks, withOperationLocks, withOperationLocksSync } from '../../plugins/codex-paper/src/web/server/utils/operationLocks.mjs'
import {
  consumeDeleteConfirmation,
  createDeleteConfirmation,
  isAllowedHost,
  isAllowedOrigin,
  pairSession,
  resetSecurityStateForTests,
  validateCsrf,
  validateDeleteConfirmation,
} from '../../plugins/codex-paper/src/web/server/utils/sessionSecurity.mjs'
import { listTrash, movePaperToTrash, restoreTrashEntry } from '../../plugins/codex-paper/src/web/server/utils/trashManager.mjs'
import { acquirePaperAskLease, hasActivePaperAsk, resetPaperAskLeasesForTests } from '../../plugins/codex-paper/src/web/server/utils/askLeases.mjs'
import { callCodexPaperTool, finalizeCodexPaperToolResult } from '../../plugins/codex-paper/src/web/server/utils/codexThreadState.mjs'

test('Ask establishes a short lifecycle lease, runs Codex outside the lock, and preserves every generated answer', () => {
  const source = fs.readFileSync(path.resolve('plugins/codex-paper/src/web/server/api/papers/[slug]/ask.post.ts'), 'utf8')
  const lease = source.indexOf('acquirePaperAskLease(')
  const worker = source.indexOf('await askCodexWorker(')
  const lock = source.indexOf('await withOperationLocks(', worker)
  const append = source.indexOf('appendChatNote(', lock)
  assert.ok(lease >= 0 && worker > lease && lock > worker && append > lock)
  assert.doesNotMatch(source.slice(lease, worker), /withOperationLocks/)
  assert.doesNotMatch(source.slice(worker, lock), /withOperationLocks/)
  assert.match(source.slice(lock, append + 500), /timeoutMs:\s*3_000/)
  const workerSource = fs.readFileSync(path.resolve('plugins/codex-paper/src/web/server/utils/codexWorker.ts'), 'utf8')
  assert.match(workerSource, /paperQueues = new Map<string, Promise<void>>\(\)/)
  assert.match(workerSource, /then\(\(\) => this\.askSerialized\(options\)\)/)
  assert.doesNotMatch(workerSource, /resetAfterFailure/)
  assert.match(workerSource, /callCodexPaperTool/)
  assert.match(source, /slug:\s*descriptor\.paperLockKey/)
  assert.match(source, /saveWarning/)
  assert.match(source, /renderSafeMarkdownForDelivery/)
  assert.match(source, /富文本渲染失败，已使用安全纯文本显示/)
  assert.doesNotMatch(source, /answerHtml:\s*renderSafeMarkdown\(/)
  assert.doesNotMatch(source, /saveError\?\.code/)
  const deleteSource = fs.readFileSync(path.resolve('plugins/codex-paper/src/web/server/api/papers/[slug]/delete.delete.ts'), 'utf8')
  assert.match(deleteSource, /hasActivePaperAsk\(descriptor\.paperLockKey\)/)
})

test('a failed reply invalidates only that paper and the next request creates a fresh thread', async () => {
  const paperThreads = new Map([
    ['paper:a', { threadId: 'stale-a', paperDir: '/papers/a' }],
    ['paper:b', { threadId: 'healthy-b', paperDir: '/papers/b' }],
  ])
  const failedCalls = []
  await assert.rejects(
    callCodexPaperTool({
      paperThreads, slug: 'paper:a', paperDir: '/papers/a', prompt: 'question',
      callTool: async (name, args) => { failedCalls.push({ name, args }); throw new Error('thread expired') }
    }),
    /thread expired/
  )
  assert.deepEqual(failedCalls, [{ name: 'codex-reply', args: { threadId: 'stale-a', prompt: 'question' } }])
  assert.equal(paperThreads.has('paper:a'), false)
  assert.equal(paperThreads.get('paper:b').threadId, 'healthy-b')

  const fresh = await callCodexPaperTool({
    paperThreads, slug: 'paper:a', paperDir: '/papers/a', prompt: 'retry',
    callTool: async (name, args) => ({ name, args })
  })
  assert.equal(fresh.existingThreadId, undefined)
  assert.equal(fresh.result.name, 'codex')
  assert.deepEqual(fresh.result.args, {
    prompt: 'retry', cwd: '/papers/a', sandbox: 'read-only', 'approval-policy': 'never'
  })
})

test('an empty successful reply invalidates only the matching cached paper thread', () => {
  const paperThreads = new Map([
    ['paper:a', { threadId: 'empty-a', paperDir: '/papers/a' }],
    ['paper:b', { threadId: 'healthy-b', paperDir: '/papers/b' }],
  ])
  assert.throws(() => finalizeCodexPaperToolResult({
    paperThreads,
    slug: 'paper:a',
    paperDir: '/papers/a',
    existingThreadId: 'empty-a',
    result: { content: '   ' },
    extractOutput: (result) => result,
  }), /empty answer/)
  assert.equal(paperThreads.has('paper:a'), false)
  assert.equal(paperThreads.get('paper:b').threadId, 'healthy-b')
})

test('Ask lifecycle leases are reference-counted and idempotently released', () => {
  resetPaperAskLeasesForTests()
  const first = acquirePaperAskLease('paper:test')
  const second = acquirePaperAskLease('paper:test')
  assert.equal(hasActivePaperAsk('paper:test'), true)
  first(); first()
  assert.equal(hasActivePaperAsk('paper:test'), true)
  second()
  assert.equal(hasActivePaperAsk('paper:test'), false)
})

function fixture() {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-security-'))
  const paperDir = path.join(libraryRoot, 'papers', 'sample-paper')
  fs.mkdirSync(path.join(paperDir, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(paperDir, 'README.md'), '# Sample\n')
  fs.writeFileSync(path.join(paperDir, 'notes', 'public.md'), 'safe')
  fs.writeFileSync(path.join(paperDir, 'meta.json'), JSON.stringify({ title: 'Sample', slug: 'sample-paper' }))
  fs.writeFileSync(path.join(libraryRoot, 'index.json'), JSON.stringify([{ title: 'Sample', slug: 'sample-paper', tags: [] }]))
  return { libraryRoot, paperDir }
}

function moveLocked(slug, options) {
  return withOperationLocksSync([`legacy:${slug}`, 'index'], () => movePaperToTrash(slug, options), options)
}

function restoreLocked(trashId, options) {
  return withOperationLocksSync([`legacy:sample-paper`, `trash:${trashId}`, 'index'], () => restoreTrashEntry(trashId, options), options)
}

test('session pairing, Host, Origin, CSRF, rate limit, and bounded confirmations', () => {
  const previousPort = process.env.PORT
  process.env.PORT = '5815'
  try {
    const token = 'a'.repeat(64)
    resetSecurityStateForTests(token)
    assert.equal(isAllowedHost('127.0.0.1:5815'), true)
    assert.equal(isAllowedHost('localhost:5815'), true)
    assert.equal(isAllowedHost('evil.test:5815'), false)
    assert.equal(isAllowedOrigin('http://localhost:5815', 'localhost:5815'), true)
    assert.equal(isAllowedOrigin('http://127.0.0.1:5815', 'localhost:5815'), false)
    const paired = pairSession(token)
    assert.equal(paired.ok, true)
    assert.equal(validateCsrf(paired.sessionId, paired.csrfToken), true)
    assert.equal(validateCsrf(paired.sessionId, 'wrong'), false)
    const confirmation = createDeleteConfirmation(paired.sessionId, 'sample-paper', 100)
    assert.equal(validateDeleteConfirmation(confirmation.token, paired.sessionId, 'sample-paper', 101), true)
    assert.equal(validateDeleteConfirmation(confirmation.token, paired.sessionId, 'other', 101), false)
    assert.equal(consumeDeleteConfirmation(confirmation.token, paired.sessionId, 'other', 101), false)
    assert.equal(consumeDeleteConfirmation(confirmation.token, paired.sessionId, 'sample-paper', 102), false)
    const expiring = createDeleteConfirmation(paired.sessionId, 'sample-paper', 100)
    assert.equal(consumeDeleteConfirmation(expiring.token, paired.sessionId, 'sample-paper', 120_101), false)

    resetSecurityStateForTests(token)
    const boundedSession = pairSession(token)
    const confirmations = Array.from({ length: 257 }, (_, index) => createDeleteConfirmation(boundedSession.sessionId, `paper-${index}`, 200))
    assert.equal(consumeDeleteConfirmation(confirmations[0].token, boundedSession.sessionId, 'paper-0', 201), false)
    assert.equal(consumeDeleteConfirmation(confirmations[256].token, boundedSession.sessionId, 'paper-256', 201), true)

    resetSecurityStateForTests(token)
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal(pairSession('wrong', 'client', 0).statusCode, 401)
    assert.equal(pairSession(token, 'client', 0).statusCode, 409)

    process.env.PORT = '80'
    assert.equal(isAllowedHost('localhost'), true)
    assert.equal(isAllowedHost('127.0.0.1'), true)
    assert.equal(isAllowedHost('localhost:80'), true)
    assert.equal(isAllowedOrigin('http://localhost', 'localhost:80'), true)
    assert.equal(isAllowedOrigin('http://localhost:80', 'localhost:80'), false)
  } finally {
    if (previousPort === undefined) delete process.env.PORT
    else process.env.PORT = previousPort
  }
})

test('path resolver rejects traversal, encoded separators, hidden files, and symlinks', (t) => {
  const { libraryRoot, paperDir } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  for (const unsafe of ['../secret', '%2e%2e/secret', '%252e%252e%252fsecret', '/etc/passwd', 'a\\b', 'a//b', 'a/./b']) {
    assert.throws(() => normalizeRelativePath(unsafe))
  }
  assert.equal(resolvePublicFile('sample-paper', 'notes/public.md', { libraryRoot }).relativePath, 'notes/public.md')
  assert.throws(() => resolvePublicFile('sample-paper', 'meta.json', { libraryRoot }), { statusCode: 404 })
  fs.symlinkSync('/etc/passwd', path.join(paperDir, 'escape.txt'))
  assert.throws(() => resolvePublicFile('sample-paper', 'escape.txt', { libraryRoot }), { statusCode: 403 })
  assert.equal(buildPublicFileTree('sample-paper', { libraryRoot }).some((node) => node.name === 'escape.txt'), false)
  fs.rmSync(paperDir, { recursive: true })
  fs.symlinkSync('/tmp', paperDir)
  assert.throws(() => requirePaperDir('sample-paper', { libraryRoot }), { statusCode: 403 })
})

test('no-follow reader applies file size limits', (t) => {
  const { libraryRoot, paperDir } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  const file = path.join(paperDir, 'README.md')
  assert.equal(readFileNoFollow(file, 1024).toString(), '# Sample\n')
  assert.throws(() => readFileNoFollow(file, 1), { statusCode: 413 })
})

test('atomic writer uses exclusive and no-follow temporary files', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-atomic-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const target = path.join(directory, 'state.json')
  const originalOpen = fs.openSync
  let observedFlags = 0
  fs.openSync = (filePath, flags, mode) => {
    if (String(filePath).endsWith('.tmp')) observedFlags = flags
    return originalOpen(filePath, flags, mode)
  }
  try {
    withOperationLocksSync(['paper:atomic'], () => writeFileAtomic(target, '{}\n', 0o600, 'paper:atomic'), { libraryRoot: directory })
  } finally {
    fs.openSync = originalOpen
  }
  assert.ok(observedFlags & fs.constants.O_EXCL)
  if (fs.constants.O_NOFOLLOW) assert.ok(observedFlags & fs.constants.O_NOFOLLOW)
  assert.equal(fs.readFileSync(target, 'utf8'), '{}\n')
})

test('public file trees enforce depth and node budgets', (t) => {
  const { libraryRoot, paperDir } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  let deep = paperDir
  for (let depth = 0; depth < 14; depth += 1) {
    deep = path.join(deep, `d${depth}`)
    fs.mkdirSync(deep)
  }
  assert.throws(() => buildPublicFileTree('sample-paper', { libraryRoot }), { statusCode: 413 })
  fs.rmSync(path.join(paperDir, 'd0'), { recursive: true })
  for (let index = 0; index < 5001; index += 1) fs.writeFileSync(path.join(paperDir, `node-${index}.txt`), '')
  assert.throws(() => buildPublicFileTree('sample-paper', { libraryRoot }), { statusCode: 413 })
})

test('operation locks fail immediately on conflicts and release reliably', async () => {
  const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paper-lock-test-'))
  resetOperationLocksForTests()
  const release = tryAcquireLocks(['paper:sample', 'index'], { libraryRoot })
  assert.ok(release)
  await assert.rejects(() => withOperationLocks(['paper:sample'], async () => {}, { libraryRoot }), { statusCode: 409 })
  release()
  await withOperationLocks(['paper:sample'], async () => 'ok', { libraryRoot })
  fs.rmSync(libraryRoot, { recursive: true, force: true })
})

test('trash preserves and restores array index entries and rejects conflicts', (t) => {
  const { libraryRoot } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  const moved = moveLocked('sample-paper', { libraryRoot, now: 1_700_000_000_000 })
  assert.equal(fs.existsSync(path.join(libraryRoot, 'papers', 'sample-paper')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'))).length, 0)
  assert.equal(listTrash({ libraryRoot })[0].trashId, moved.trashId)
  restoreLocked(moved.trashId, { libraryRoot })
  assert.equal(fs.existsSync(path.join(libraryRoot, 'papers', 'sample-paper')), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json')))[0].title, 'Sample')
  assert.equal(fs.existsSync(path.join(libraryRoot, 'papers', 'sample-paper', '.codex-paper-trash.json')), false)

  const second = moveLocked('sample-paper', { libraryRoot, now: 1_700_000_000_001 })
  fs.mkdirSync(path.join(libraryRoot, 'papers', 'sample-paper'))
  assert.throws(() => restoreLocked(second.trashId, { libraryRoot }), { statusCode: 409 })
})

test('restore treats a dangling target symlink as a conflict', (t) => {
  const { libraryRoot } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  const moved = moveLocked('sample-paper', { libraryRoot, now: 1_700_000_000_004 })
  fs.symlinkSync(path.join(libraryRoot, 'missing-target'), path.join(libraryRoot, 'papers', 'sample-paper'))
  assert.throws(() => restoreLocked(moved.trashId, { libraryRoot }), { statusCode: 409 })
  assert.equal(listTrash({ libraryRoot }).length, 1)
})

test('trash supports object-shaped indexes', (t) => {
  const { libraryRoot } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  fs.writeFileSync(path.join(libraryRoot, 'index.json'), JSON.stringify({ version: 2, papers: [{ title: 'Sample', slug: 'sample-paper' }] }))
  const moved = moveLocked('sample-paper', { libraryRoot, now: 1_700_000_000_002 })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'))), { version: 2, papers: [] })
  restoreLocked(moved.trashId, { libraryRoot })
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'))).papers[0].slug, 'sample-paper')
})

test('trash move rolls the paper back when atomic index replacement fails', (t) => {
  const { libraryRoot, paperDir } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  const originalRename = fs.renameSync
  fs.renameSync = (source, target) => {
    if (path.basename(String(target)) === 'index.json') throw new Error('injected index failure')
    return originalRename(source, target)
  }
  try {
    assert.throws(() => moveLocked('sample-paper', { libraryRoot, now: 1_700_000_000_003 }), /injected index failure/)
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(fs.existsSync(paperDir), true)
  assert.equal(fs.existsSync(path.join(paperDir, '.codex-paper-trash.json')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'))).length, 1)
})

test('trash move rolls the paper back when tombstone creation fails', (t) => {
  const { libraryRoot, paperDir } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  const originalOpen = fs.openSync
  fs.openSync = (filePath, flags, mode) => {
    if (String(filePath).includes('.tombstone.json.') && String(filePath).endsWith('.tmp')) {
      const error = new Error('injected tombstone failure')
      error.code = 'ENOSPC'
      throw error
    }
    return originalOpen(filePath, flags, mode)
  }
  try {
    assert.throws(() => moveLocked('sample-paper', { libraryRoot, now: 1_700_000_000_005 }), /injected tombstone failure/)
  } finally {
    fs.openSync = originalOpen
  }
  assert.equal(fs.existsSync(paperDir), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'))).length, 1)
  assert.equal(fs.readdirSync(path.join(libraryRoot, '.trash')).length, 0)
})

test('restore rolls back to a valid trash entry when index replacement fails', (t) => {
  const { libraryRoot, paperDir } = fixture()
  t.after(() => fs.rmSync(libraryRoot, { recursive: true, force: true }))
  const moved = moveLocked('sample-paper', { libraryRoot, now: 1_700_000_000_006 })
  const originalRename = fs.renameSync
  fs.renameSync = (source, target) => {
    if (path.basename(String(target)) === 'index.json') throw new Error('injected restore index failure')
    return originalRename(source, target)
  }
  try {
    assert.throws(() => restoreLocked(moved.trashId, { libraryRoot }), /injected restore index failure/)
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(fs.existsSync(paperDir), false)
  assert.equal(listTrash({ libraryRoot })[0].trashId, moved.trashId)
  assert.equal(JSON.parse(fs.readFileSync(path.join(libraryRoot, 'index.json'))).length, 0)
})
