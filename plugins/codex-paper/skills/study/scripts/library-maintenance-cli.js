#!/usr/bin/env node

import {
  buildMigrationPlan,
  createPaperBackup,
  inspectBackup,
  inspectLibrary,
  listBackups,
  recoverBackupRestores,
  restorePaperBackup,
  verifyBackup,
} from '../../../src/shared/library-maintenance.mjs'
import { MAX_LOCK_TIMEOUT_MS } from '../../../src/shared/storage-transaction.mjs'
import { cliExitCode, formatCliError } from '../../../src/shared/cli-error-format.mjs'

function argumentError(message) {
  return Object.assign(new Error(message), { code: 'ARGUMENT_INVALID', statusCode: 400 })
}

function parseCommon(argv, { lock = false } = {}) {
  if (argv.filter((item) => item === '--json').length > 1
    || argv.filter((item) => item === '--lock-timeout-ms').length > 1) {
    throw argumentError('Common options may be specified only once.')
  }
  const json = argv.includes('--json')
  const timeoutIndex = argv.indexOf('--lock-timeout-ms')
  if (!lock && timeoutIndex >= 0) throw argumentError('--lock-timeout-ms is not accepted by read-only commands.')
  if (timeoutIndex >= 0 && argv[timeoutIndex + 1] === undefined) throw argumentError('--lock-timeout-ms requires a value.')
  const lockTimeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 10_000
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) {
    throw argumentError(`--lock-timeout-ms must be an integer from 0 to ${MAX_LOCK_TIMEOUT_MS}.`)
  }
  const remaining = argv.filter((item, index) => item !== '--json'
    && !(timeoutIndex >= 0 && (index === timeoutIndex || index === timeoutIndex + 1)))
  return { json, lockTimeoutMs, remaining }
}

function publicBackupInspection(inspection) {
  return {
    backupId: inspection.manifest.backupId,
    target: inspection.manifest.target,
    index: inspection.manifest.index,
    snapshotHash: inspection.manifest.snapshotHash,
    files: inspection.manifest.files.length,
    bytes: inspection.manifest.totalBytes,
    createdAt: inspection.manifest.createdAt,
    integrity: inspection.manifest.integrity,
  }
}

async function main() {
  const command = process.argv[2]
  let result
  let json = false
  if (command === 'inventory' || command === 'doctor') {
    const parsed = parseCommon(process.argv.slice(3))
    json = parsed.json
    if (parsed.remaining.length !== 0) throw argumentError(`${command} does not accept positional arguments.`)
    result = inspectLibrary({ verifyBackupPayloads: command === 'doctor' })
    if (command === 'doctor' && result.status === 'errors') process.exitCode = 1
  } else if (command === 'backup-list') {
    const parsed = parseCommon(process.argv.slice(3))
    json = parsed.json
    if (parsed.remaining.length !== 0) throw argumentError('backup-list does not accept positional arguments.')
    result = listBackups()
  } else if (command === 'backup-inspect') {
    const parsed = parseCommon(process.argv.slice(3))
    json = parsed.json
    if (parsed.remaining.length !== 1) throw argumentError('backup-inspect requires exactly one backup ID.')
    result = publicBackupInspection(inspectBackup(parsed.remaining[0]))
  } else if (command === 'backup-verify') {
    const parsed = parseCommon(process.argv.slice(3))
    json = parsed.json
    if (parsed.remaining.length !== 1) throw argumentError('backup-verify requires exactly one backup ID.')
    result = verifyBackup(parsed.remaining[0])
  } else if (command === 'backup-create') {
    const parsed = parseCommon(process.argv.slice(3), { lock: true })
    json = parsed.json
    if (parsed.remaining.length !== 1) throw argumentError('backup-create requires exactly one paper reference.')
    result = await createPaperBackup(parsed.remaining[0], { lockTimeoutMs: parsed.lockTimeoutMs })
  } else if (command === 'backup-restore') {
    const parsed = parseCommon(process.argv.slice(3), { lock: true })
    json = parsed.json
    if (parsed.remaining.length !== 1) throw argumentError('backup-restore requires exactly one backup ID.')
    result = await restorePaperBackup(parsed.remaining[0], { lockTimeoutMs: parsed.lockTimeoutMs })
  } else if (command === 'backup-recover') {
    const parsed = parseCommon(process.argv.slice(3), { lock: true })
    json = parsed.json
    if (parsed.remaining.length !== 0) throw argumentError('backup-recover does not accept positional arguments.')
    result = await recoverBackupRestores({ lockTimeoutMs: parsed.lockTimeoutMs })
    if (result.failed > 0) process.exitCode = 3
  } else if (command === 'migration-dry-run') {
    const parsed = parseCommon(process.argv.slice(3))
    json = parsed.json
    const backupIndex = parsed.remaining.indexOf('--backup-id')
    let backupId = null
    let remaining = parsed.remaining
    if (backupIndex >= 0) {
      if (!parsed.remaining[backupIndex + 1] || parsed.remaining.filter((item) => item === '--backup-id').length > 1) {
        throw argumentError('--backup-id requires exactly one value.')
      }
      backupId = parsed.remaining[backupIndex + 1]
      remaining = parsed.remaining.filter((_, index) => index !== backupIndex && index !== backupIndex + 1)
    }
    if (remaining.length !== 1) throw argumentError('migration-dry-run requires exactly one paper reference.')
    result = buildMigrationPlan(remaining[0], { backupId })
  } else {
    throw argumentError('Expected inventory, doctor, backup-list, backup-inspect, backup-create, backup-verify, backup-restore, backup-recover, or migration-dry-run.')
  }
  process.stdout.write(`${JSON.stringify(result, null, json ? 2 : 0)}\n`)
}

main().catch((error) => {
  console.error(formatCliError(error, 'LIBRARY_MAINTENANCE_FAILED'))
  process.exit(cliExitCode(error))
})
