#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import {
  readManifestBoundFile,
  verifyGenerationManifest,
} from '../../../src/shared/generation-manifest.mjs'
import {
  readProvenanceDraft,
  reportIntrinsicHash,
  sha256,
  validateProvenanceDraft,
} from '../../../src/shared/generation-provenance.mjs'
import {
  WORKSPACE_ID_PATTERN,
  resolveExplicitPackage,
} from '../../../src/shared/paper-library.mjs'
import { resolveGenerationWorkspace } from '../../../src/shared/generation-workspace.mjs'
import { readFileNoFollowBounded } from '../../../src/shared/storage-transaction.mjs'
import { formatCliError } from '../../../src/shared/cli-error-format.mjs'

function parse(argv) {
  const command = argv[0]
  const input = argv[1]
  const json = argv.slice(2).includes('--json')
  if (!['inspect', 'verify'].includes(command) || !input || argv.slice(2).some((item) => item !== '--json')) {
    const error = new Error('Usage: provenance-cli.js <inspect|verify> <paper-or-workspace> [--json]')
    error.code = 'ARGUMENT_INVALID'
    error.exitCode = 2
    throw error
  }
  return { command, input, json }
}

function postSealEvents(descriptor) {
  if (!descriptor.overlayDir || !descriptor.generationId || !descriptor.manifest) return []
  const generationDir = descriptor.generationId.replaceAll(':', '-')
  const executionRoot = path.join(descriptor.overlayDir, 'execution-reports')
  const root = path.join(executionRoot, generationDir)
  if (!fs.existsSync(executionRoot)) return []
  for (const directory of [executionRoot, root]) {
    if (!fs.existsSync(directory)) return []
    const stats = fs.lstatSync(directory)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw Object.assign(new Error('Post-seal execution report registry is unsafe.'), { code: 'PROVENANCE_EXECUTION_INVALID' })
    }
  }
  const output = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
      throw Object.assign(new Error('Post-seal execution report registry is unsafe.'), { code: 'PROVENANCE_EXECUTION_INVALID' })
    }
    const bytes = readFileNoFollowBounded(path.join(root, entry.name), 8 * 1024 * 1024)
    let report
    try {
      report = JSON.parse(bytes)
    } catch {
      throw Object.assign(new Error('Post-seal execution report is invalid JSON.'), { code: 'PROVENANCE_EXECUTION_INVALID' })
    }
    const binding = report?.generationBinding
    if (binding?.phase !== 'published'
      || binding.manifestId !== descriptor.manifest.manifestId
      || binding.manifestHash !== descriptor.manifest.manifestHash
      || binding.manifestFileSha256 !== descriptor.integrity?.manifestFileSha256
      || report?.reportHash?.algorithm !== 'sha256'
      || report.reportHash.value !== reportIntrinsicHash(report)) {
      throw Object.assign(new Error('Post-seal execution report binding is invalid.'), { code: 'PROVENANCE_EXECUTION_INVALID' })
    }
    output.push({
      executionId: report.executionId,
      generatedAt: report.generatedAt,
      outcome: report.outcome,
      reportHash: report.reportHash.value,
      fileSha256: sha256(bytes),
      path: `execution-reports/${generationDir}/${entry.name}`,
    })
  }
  return output
}

function inspect(input) {
  const descriptor = WORKSPACE_ID_PATTERN.test(input)
    ? resolveGenerationWorkspace(input)
    : resolveExplicitPackage(input)
  if (descriptor.mode === 'generation_workspace_v1') {
    const draft = validateProvenanceDraft(readProvenanceDraft(descriptor), { workspaceId: descriptor.workspaceId })
    return {
      mode: 'workspace_draft',
      verified: true,
      authoritative: false,
      workspaceId: descriptor.workspaceId,
      manifestId: draft.manifestId,
      generationId: draft.generationId,
      source: draft.source,
      runtime: draft.runtime,
      software: draft.software,
      authoringEventCount: draft.authoringEvents.length,
      pendingEventCount: draft.authoringEvents.filter((event) => event.state === 'pending').length,
      pendingEvents: draft.authoringEvents
        .filter((event) => event.state === 'pending')
        .map((event) => ({
          eventId: event.eventId,
          path: event.path,
          state: event.state,
          intendedSha256: event.afterSha256,
        })),
      diagnostics: draft.software.diagnostics,
      postSealEvents: [],
    }
  }
  if (!descriptor.manifest) {
    return {
      mode: 'unsupported',
      verified: false,
      authoritative: false,
      diagnostics: [{ code: 'GENERATION_MANIFEST_MISSING', message: 'No authoritative generation manifest is available.' }],
      postSealEvents: [],
    }
  }
  const verified = verifyGenerationManifest(descriptor.packageDir, {
    manifestId: descriptor.manifest.manifestId,
    manifestHash: descriptor.manifest.manifestHash,
    manifestFileSha256: descriptor.integrity?.manifestFileSha256,
    paperKey: descriptor.paperKey,
    generationId: descriptor.generationId,
  })
  const mode = verified.manifest.schemaVersion === '2.0.0' ? 'native_2_0' : 'compatible_1_0'
  const validation = JSON.parse(readManifestBoundFile(
    descriptor.packageDir,
    verified.manifest,
    '.codex-paper/validation-report.json',
    8 * 1024 * 1024,
  ).toString('utf8'))
  return {
    mode,
    verified: true,
    authoritative: true,
    manifestId: verified.manifest.manifestId,
    manifestHash: verified.manifest.manifestHash,
    manifestFileSha256: verified.manifestFileSha256,
    generationId: verified.manifest.generationId,
    source: verified.manifest.source || { sha256: verified.manifest.sourceSha256 },
    runtime: verified.manifest.runtime || null,
    software: verified.manifest.software || null,
    validation: {
      status: validation.status,
      reportHash: validation.reportHash?.value,
    },
    authoring: verified.manifest.authoring || null,
    executionsAtSeal: verified.manifest.executions?.atSeal || [],
    diagnostics: verified.manifest.diagnostics || [{
      code: 'PROVENANCE_COMPATIBILITY_LIMITED',
      message: 'Generation Manifest 1.0 contains only the minimal P0 provenance contract.',
    }],
    postSealEvents: postSealEvents({ ...descriptor, manifest: verified.manifest, integrity: { manifestFileSha256: verified.manifestFileSha256 } }),
  }
}

try {
  const args = parse(process.argv.slice(2))
  let result
  try {
    result = inspect(args.input)
  } catch (error) {
    if (error?.code !== 'GENERATION_MANIFEST_VERSION_UNSUPPORTED') throw error
    result = {
      mode: 'unsupported',
      verified: false,
      authoritative: false,
      diagnostics: [{
        code: 'GENERATION_MANIFEST_VERSION_UNSUPPORTED',
        message: 'The generation manifest version is unsupported and was not modified.',
      }],
      postSealEvents: [],
    }
  }
  if (args.command === 'verify' && !result.verified) process.exitCode = 1
  process.stdout.write(`${JSON.stringify(result, null, args.json ? 2 : 0)}\n`)
} catch (error) {
  const code = String(error?.code || 'PROVENANCE_VERIFY_FAILED')
  console.error(formatCliError(error, 'PROVENANCE_VERIFY_FAILED', 1200))
  process.exit(error?.exitCode || (
    code === 'ARGUMENT_INVALID' || code.includes('CONFIG') || code.includes('SCHEMA')
      ? 2
      : code.includes('UNAVAILABLE')
        ? 3
        : 1
  ))
}
