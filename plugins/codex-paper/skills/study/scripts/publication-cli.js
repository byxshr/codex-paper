#!/usr/bin/env node

import { MAX_LOCK_TIMEOUT_MS } from '../../../src/shared/storage-transaction.mjs'
import { formatCliError } from '../../../src/shared/cli-error-format.mjs'
import {
  publishGenerationWorkspace,
  rebuildLibraryIndex,
  recoverPublications,
} from '../../../src/shared/generation-publication.mjs'

function argumentError(message) {
  return Object.assign(new Error(message), { code: 'ARGUMENT_INVALID', statusCode: 400 })
}

function parse(argv) {
  if (argv.filter((item) => item === '--json').length > 1 || argv.filter((item) => item === '--lock-timeout-ms').length > 1) {
    throw argumentError('common options may be specified only once')
  }
  const json = argv.includes('--json')
  const timeoutIndex = argv.indexOf('--lock-timeout-ms')
  if (timeoutIndex >= 0 && argv[timeoutIndex + 1] === undefined) throw argumentError('--lock-timeout-ms requires a value')
  const lockTimeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 10_000
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw argumentError(`--lock-timeout-ms must be an integer from 0 to ${MAX_LOCK_TIMEOUT_MS}`)
  }
  const remaining = argv.filter((item, index) => item !== '--json' && !(timeoutIndex >= 0 && (index === timeoutIndex || index === timeoutIndex + 1)))
  return { json, lockTimeoutMs, remaining }
}

function exitCode(error) {
  const code = String(error?.code || '')
  if (code === 'ARGUMENT_INVALID') return 2
  if (code.includes('LOCK') || code.startsWith('WORKSPACE_')) return 3
  return 1
}

async function main() {
  const command = process.argv[2]
  const { json, lockTimeoutMs, remaining } = parse(process.argv.slice(3))
  let result
  if (command === 'publish') {
    if (remaining.length !== 1) throw argumentError('publish requires exactly one workspace ID or path')
    result = await publishGenerationWorkspace(remaining[0], { lockTimeoutMs })
  } else if (command === 'recover') {
    if (remaining.length !== 0) throw argumentError('recover does not accept positional arguments')
    const transactions = await recoverPublications({ lockTimeoutMs })
    result = { recovered: transactions.filter((item) => item.success).length, failed: transactions.filter((item) => !item.success).length, transactions }
    if (result.failed > 0) process.exitCode = 1
  } else if (command === 'reindex') {
    if (remaining.length !== 0) throw argumentError('reindex does not accept positional arguments')
    const index = await rebuildLibraryIndex({ lockTimeoutMs })
    result = { rebuilt: true, entries: index.entries.length, diagnostics: index.diagnostics }
  } else throw argumentError('expected publish, recover, or reindex')
  process.stdout.write(`${JSON.stringify(result, null, json ? 2 : 0)}\n`)
}

main().catch((error) => {
  const code = String(error?.code || 'PUBLICATION_OPERATION_FAILED')
  console.error(formatCliError(error, 'PUBLICATION_OPERATION_FAILED'))
  process.exit(exitCode(error))
})
