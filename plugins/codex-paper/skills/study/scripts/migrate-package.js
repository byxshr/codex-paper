#!/usr/bin/env node

import { buildMigrationPlan } from '../../../src/shared/library-maintenance.mjs'
import { cliExitCode, formatCliError } from '../../../src/shared/cli-error-format.mjs'

function argumentError(message) {
  return Object.assign(new Error(message), { code: 'ARGUMENT_INVALID', statusCode: 400 })
}

function parse(argv) {
  const json = argv.includes('--json')
  const dryRun = argv.includes('--dry-run')
  const backupIndex = argv.indexOf('--backup-id')
  if (!dryRun) {
    const error = new Error('In-place migration is frozen. Use migration-dry-run now and the verified-backup P1-2b migration workflow when available.')
    error.code = 'MIGRATION_EXECUTION_DEFERRED'
    error.statusCode = 409
    error.exitCode = 2
    throw error
  }
  if (argv.filter((item) => item === '--dry-run').length !== 1
    || argv.filter((item) => item === '--json').length > 1
    || argv.filter((item) => item === '--backup-id').length > 1) {
    throw argumentError('Migration dry-run options may be specified only once.')
  }
  let backupId = null
  const consumed = new Set(argv.flatMap((item, index) => {
    if (item === '--dry-run' || item === '--json') return [index]
    if (item === '--backup-id') {
      if (!argv[index + 1]) throw argumentError('--backup-id requires a value.')
      backupId = argv[index + 1]
      return [index, index + 1]
    }
    return []
  }))
  const remaining = argv.filter((_, index) => !consumed.has(index))
  if (remaining.length !== 1) throw argumentError('Usage: migrate-package.js <paper-ref> --dry-run [--backup-id <id>] [--json]')
  return { input: remaining[0], backupId, json }
}

try {
  const args = parse(process.argv.slice(2))
  const plan = buildMigrationPlan(args.input, { backupId: args.backupId })
  process.stdout.write(`${JSON.stringify(plan, null, args.json ? 2 : 0)}\n`)
} catch (error) {
  console.error(formatCliError(error, 'MIGRATION_PLAN_FAILED'))
  process.exit(cliExitCode(error))
}
