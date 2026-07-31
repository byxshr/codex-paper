#!/usr/bin/env node

import {
  commitGenerationMigration,
  inspectGenerationMigration,
  recoverGenerationMigrations,
  rollbackGenerationMigration,
  rollforwardGenerationMigration,
  startGenerationMigration,
} from '../../../src/shared/generation-migration.mjs'
import { MAX_LOCK_TIMEOUT_MS } from '../../../src/shared/storage-transaction.mjs'
import { cliExitCode, formatCliError } from '../../../src/shared/cli-error-format.mjs'

function argumentError(message) {
  return Object.assign(new Error(message), { code: 'ARGUMENT_INVALID', statusCode: 400 })
}

function parseCommon(argv) {
  if (argv.filter((item) => item === '--json').length > 1
    || argv.filter((item) => item === '--lock-timeout-ms').length > 1) {
    throw argumentError('Common options may be specified only once.')
  }
  const json = argv.includes('--json')
  const timeoutIndex = argv.indexOf('--lock-timeout-ms')
  if (timeoutIndex >= 0 && argv[timeoutIndex + 1] === undefined) throw argumentError('--lock-timeout-ms requires a value.')
  const lockTimeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 10_000
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw argumentError(`--lock-timeout-ms must be an integer from 0 to ${MAX_LOCK_TIMEOUT_MS}.`)
  }
  const remaining = argv.filter((item, index) => item !== '--json'
    && !(timeoutIndex >= 0 && (index === timeoutIndex || index === timeoutIndex + 1)))
  return { json, lockTimeoutMs, remaining }
}

function takeOption(argv, name) {
  const indexes = argv.map((item, index) => item === name ? index : -1).filter((index) => index >= 0)
  if (indexes.length > 1) throw argumentError(`${name} may be specified only once.`)
  if (indexes.length === 0) return { value: null, remaining: argv }
  const index = indexes[0]
  if (!argv[index + 1]) throw argumentError(`${name} requires a value.`)
  return { value: argv[index + 1], remaining: argv.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1) }
}

async function main() {
  const command = process.argv[2]
  const parsed = parseCommon(process.argv.slice(3))
  let result
  if (command === 'start') {
    const backup = takeOption(parsed.remaining, '--backup-id')
    if (!backup.value || backup.remaining.length !== 1) throw argumentError('migration-start requires one paper reference and --backup-id.')
    result = await startGenerationMigration(backup.remaining[0], backup.value, { lockTimeoutMs: parsed.lockTimeoutMs })
  } else if (command === 'inspect') {
    if (parsed.remaining.length !== 1) throw argumentError('migration-inspect requires one migration ID or workspace.')
    result = inspectGenerationMigration(parsed.remaining[0])
  } else if (command === 'commit') {
    if (parsed.remaining.length !== 1) throw argumentError('migration-commit requires one migration ID or workspace.')
    result = await commitGenerationMigration(parsed.remaining[0], { lockTimeoutMs: parsed.lockTimeoutMs })
  } else if (command === 'recover') {
    if (parsed.remaining.length !== 0) throw argumentError('migration-recover does not accept positional arguments.')
    result = await recoverGenerationMigrations({ lockTimeoutMs: parsed.lockTimeoutMs })
    if (result.failed > 0) process.exitCode = 1
  } else if (command === 'rollback') {
    const expected = takeOption(parsed.remaining, '--expected-current-manifest-hash')
    if (!expected.value || expected.remaining.length !== 1) {
      throw argumentError('migration-rollback requires one migration ID and --expected-current-manifest-hash.')
    }
    result = await rollbackGenerationMigration(expected.remaining[0], expected.value, { lockTimeoutMs: parsed.lockTimeoutMs })
  } else if (command === 'rollforward') {
    if (parsed.remaining.length !== 1) throw argumentError('migration-rollforward requires one migration ID.')
    result = await rollforwardGenerationMigration(parsed.remaining[0], { lockTimeoutMs: parsed.lockTimeoutMs })
  } else {
    throw argumentError('Expected start, inspect, commit, recover, rollback, or rollforward.')
  }
  process.stdout.write(`${JSON.stringify(result, null, parsed.json ? 2 : 0)}\n`)
}

main().catch((error) => {
  console.error(formatCliError(error, 'MIGRATION_OPERATION_FAILED'))
  process.exit(cliExitCode(error))
})
