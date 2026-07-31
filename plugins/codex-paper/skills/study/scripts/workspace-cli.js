#!/usr/bin/env node

import fs from 'node:fs'
import {
  abandonGenerationWorkspace,
  listGenerationWorkspaces,
  resolveWorkspaceAuthoringEvent,
  resolveGenerationWorkspace,
  setWorkspaceTags,
  writeWorkspaceAuthoring,
} from '../../../src/shared/generation-workspace.mjs'
import { MAX_LOCK_TIMEOUT_MS, readFileNoFollowBounded, storageCliExitCode } from '../../../src/shared/storage-transaction.mjs'
import { formatCliError } from '../../../src/shared/cli-error-format.mjs'

function usage() {
  console.error('Usage: workspace-cli.js <list|inspect|write|resolve-event|tags|abandon> ...')
}

function parseCommon(argv) {
  if (argv.filter((item) => item === '--json').length > 1 || argv.filter((item) => item === '--lock-timeout-ms').length > 1) {
    throw Object.assign(new Error('common options may be specified only once'), { code: 'ARGUMENT_INVALID' })
  }
  const json = argv.includes('--json')
  const timeoutIndex = argv.indexOf('--lock-timeout-ms')
  if (timeoutIndex >= 0 && argv[timeoutIndex + 1] === undefined) throw Object.assign(new Error('--lock-timeout-ms requires a value'), { code: 'ARGUMENT_INVALID' })
  const lockTimeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 10_000
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > MAX_LOCK_TIMEOUT_MS) throw Object.assign(new Error(`--lock-timeout-ms must be an integer from 0 to ${MAX_LOCK_TIMEOUT_MS}`), { code: 'ARGUMENT_INVALID' })
  const remaining = argv.filter((_, index) => argv[index] !== '--json' && !(timeoutIndex >= 0 && (index === timeoutIndex || index === timeoutIndex + 1)))
  return { json, lockTimeoutMs, remaining }
}

function publicWorkspace(item) {
  return {
    workspaceId: item.workspaceId,
    state: item.workspace.state,
    paperKey: item.paperKey,
    paperId: item.paperId,
    sourceRevisionId: item.sourceRevisionId,
    generationId: item.generationId,
    routeSlug: item.routeSlug,
    workspaceDir: item.workspaceDir,
    paperDir: item.packageDir,
    createdAt: item.workspace.createdAt,
    updatedAt: item.workspace.updatedAt,
    lastSuccessfulStep: item.workspace.lastSuccessfulStep,
    diagnostics: item.workspace.diagnostics,
    publishIntent: item.workspace.publishIntent,
  }
}

async function main() {
  const command = process.argv[2]
  const { json, lockTimeoutMs, remaining } = parseCommon(process.argv.slice(3))
  let result
  if (command === 'list') {
    if (remaining.length !== 0) throw Object.assign(new Error('list does not accept positional arguments'), { code: 'ARGUMENT_INVALID' })
    result = listGenerationWorkspaces().map(publicWorkspace)
  }
  else if (command === 'inspect') {
    if (remaining.length !== 1) throw Object.assign(new Error('inspect requires exactly one workspace ID or path'), { code: 'ARGUMENT_INVALID' })
    result = publicWorkspace(resolveGenerationWorkspace(remaining[0]))
  } else if (command === 'write') {
    const [workspace, relativePath, ...flags] = remaining
    if (!workspace || !relativePath) throw Object.assign(new Error('write requires a workspace and relative path'), { code: 'ARGUMENT_INVALID' })
    let stdin = false
    let fromFile = null
    let absent = false
    let expectedSha256 = null
    let actor = 'unknown'
    let actorSet = false
    const dependencies = []
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index]
      if (flag === '--stdin' && !stdin) stdin = true
      else if (flag === '--from-file' && fromFile === null && flags[index + 1] && !flags[index + 1].startsWith('--')) fromFile = flags[++index]
      else if (flag === '--expect-absent' && !absent) absent = true
      else if (flag === '--expected-sha256' && expectedSha256 === null && flags[index + 1] && !flags[index + 1].startsWith('--')) expectedSha256 = flags[++index]
      else if (flag === '--actor' && !actorSet) {
        const value = flags[index + 1]
        if (!['codex', 'human', 'unknown'].includes(value)) {
          throw Object.assign(new Error('--actor must be codex, human, or unknown'), { code: 'ARGUMENT_INVALID' })
        }
        actor = value
        index += 1
        actorSet = true
      }
      else if (flag === '--depends-on' && flags[index + 1] && !flags[index + 1].startsWith('--')) dependencies.push(flags[++index])
      else throw Object.assign(new Error('write contains an unknown, duplicate, or incomplete option'), { code: 'ARGUMENT_INVALID' })
    }
    if (stdin === (fromFile !== null)) throw Object.assign(new Error('choose exactly one of --stdin or --from-file'), { code: 'ARGUMENT_INVALID' })
    if (absent === (expectedSha256 !== null)) throw Object.assign(new Error('choose exactly one of --expect-absent or --expected-sha256'), { code: 'ARGUMENT_INVALID' })
    if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw Object.assign(new Error('--expected-sha256 requires a lowercase SHA-256'), { code: 'ARGUMENT_INVALID' })
    const data = stdin ? fs.readFileSync(0) : readFileNoFollowBounded(fromFile)
    result = await writeWorkspaceAuthoring(workspace, relativePath, data, absent ? { expectAbsent: true } : { expectedSha256 }, { lockTimeoutMs, actor, dependencies })
  } else if (command === 'resolve-event') {
    const [workspace, flag, eventId] = remaining
    if (!workspace || flag !== '--adopt-current' || !eventId || remaining.length !== 3) {
      throw Object.assign(new Error('resolve-event requires <workspace> --adopt-current <event-id>'), { code: 'ARGUMENT_INVALID' })
    }
    result = await resolveWorkspaceAuthoringEvent(workspace, eventId, { lockTimeoutMs })
  } else if (command === 'tags') {
    const workspace = remaining[0]
    const tags = []
    for (let index = 1; index < remaining.length; index += 1) {
      if (remaining[index] !== '--tag' || !remaining[index + 1]) throw Object.assign(new Error('tags accepts repeated --tag <value>'), { code: 'ARGUMENT_INVALID' })
      tags.push(remaining[index + 1]); index += 1
    }
    result = publicWorkspace(await setWorkspaceTags(workspace, tags, { lockTimeoutMs }))
  } else if (command === 'abandon') {
    if (remaining.length !== 1) throw Object.assign(new Error('abandon requires exactly one workspace ID or path'), { code: 'ARGUMENT_INVALID' })
    result = publicWorkspace(await abandonGenerationWorkspace(remaining[0], { lockTimeoutMs }))
  } else {
    usage()
    process.exit(2)
  }
  process.stdout.write(`${JSON.stringify(result, null, json ? 2 : 0)}\n`)
}

main().catch((error) => {
  console.error(formatCliError(error, 'WORKSPACE_OPERATION_FAILED'))
  process.exit(storageCliExitCode(error))
})
