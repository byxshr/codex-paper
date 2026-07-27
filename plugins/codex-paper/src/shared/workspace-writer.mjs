import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveExplicitPackage, WORKSPACE_ID_PATTERN } from './paper-library.mjs'
import { resolveGenerationWorkspace, transitionWorkspaceToAuthoringLocked } from './generation-workspace.mjs'
import { atomicWriteFile, atomicWriteJson, fileWritePrecondition, readFileNoFollowBounded, withStorageLocksSync } from './storage-transaction.mjs'

const WRITE_POLICIES = Object.freeze({
  analysis: new Set(['analysis.json']),
  rendering: new Set(['README.md', 'quick-summary.md', 'summary.md', 'insights.md']),
  reasoning_scaffold: new Set(['reasoning-analysis.json', '.codex-paper/reasoning-review.md']),
  validation_report: new Set(['.codex-paper/validation-report.json']),
})

export function requireWritableWorkspace(input, options = {}) {
  const normalized = String(input || '').replace(/^~(?=$|\/)/, os.homedir())
  const descriptor = WORKSPACE_ID_PATTERN.test(normalized)
    ? resolveGenerationWorkspace(normalized, { libraryRoot: options.libraryRoot || process.env.PAPERS_DIR })
    : resolveExplicitPackage(normalized, { libraryRoot: options.libraryRoot || process.env.PAPERS_DIR })
  if (descriptor.mode === 'generation_workspace_v1' && descriptor.initializationResidue) {
    const error = new Error('WORKSPACE_INITIALIZATION_INCOMPLETE: initialization residues are read-only; inspect or abandon this workspace and run prepare again.')
    error.code = 'WORKSPACE_INITIALIZATION_INCOMPLETE'
    error.statusCode = 409
    throw error
  }
  if (descriptor.mode === 'generation_workspace_v1' && descriptor.publicationResidue) {
    const error = new Error('WORKSPACE_PUBLICATION_IN_PROGRESS: publication residues are read-only and must be recovered.')
    error.code = 'WORKSPACE_PUBLICATION_IN_PROGRESS'
    error.statusCode = 409
    throw error
  }
  if (descriptor.mode === 'generation_workspace_v1' && descriptor.workspace?.state === 'abandoned') {
    const error = new Error('WORKSPACE_ABANDONED: abandoned workspaces are read-only.')
    error.code = 'WORKSPACE_ABANDONED'
    error.statusCode = 409
    throw error
  }
  if (descriptor.mode !== 'generation_workspace_v1' || descriptor.readOnly) {
    const error = new Error('PUBLISHED_GENERATION_READ_ONLY: authoring writes require an exact active generation workspace; legacy and compatible packages remain LEGACY_LAYOUT_READ_ONLY/PACKAGE_VERSION_READ_ONLY.')
    error.code = 'PUBLISHED_GENERATION_READ_ONLY'
    error.statusCode = 409
    throw error
  }
  return descriptor
}

export function withWorkspaceMutationSync(input, operation, options = {}) {
  const descriptor = requireWritableWorkspace(input, options)
  return withStorageLocksSync(
    [descriptor.paperLockKey, descriptor.generationLockKey, descriptor.workspaceLockKey],
    (lockHandle) => {
      let refreshed = requireWritableWorkspace(descriptor.workspaceDir, options)
      if (!options.preserveValidationState && refreshed.workspace.state !== 'authoring') {
        refreshed = transitionWorkspaceToAuthoringLocked(refreshed, lockHandle, options)
      }
      return operation({ descriptor: refreshed, lockHandle })
    },
    { libraryRoot: descriptor.libraryRoot, timeoutMs: options.lockTimeoutMs ?? 10_000 }
  )
}

function assertWritePolicy(policy, relativePath) {
  if (!WRITE_POLICIES[policy]?.has(relativePath)) {
    const error = new Error('WORKSPACE_WRITE_PATH_FORBIDDEN: specialized workspace writers require an explicit approved output policy.')
    error.code = 'WORKSPACE_WRITE_PATH_FORBIDDEN'
    error.statusCode = 403
    throw error
  }
}

export function replaceWorkspaceFile({ descriptor, lockHandle, relativePath, data, policy, maxBytes = 16 * 1024 * 1024, mode = 0o600 }) {
  assertWritePolicy(policy, relativePath)
  const precondition = fileWritePrecondition(path.join(descriptor.packageDir, ...relativePath.split('/')), maxBytes)
  return atomicWriteFile({
    root: descriptor.packageDir, relativePath, data, lockHandle, requiredLock: descriptor.workspaceLockKey,
    maxBytes, mode, ...precondition
  })
}

export function replaceWorkspaceJson({ descriptor, lockHandle, relativePath, value, policy, maxBytes = 64 * 1024 * 1024 }) {
  assertWritePolicy(policy, relativePath)
  const precondition = fileWritePrecondition(path.join(descriptor.packageDir, ...relativePath.split('/')), maxBytes)
  return atomicWriteJson({
    root: descriptor.packageDir, relativePath, value, lockHandle, requiredLock: descriptor.workspaceLockKey,
    maxBytes, ...precondition
  })
}

export function fileSha256(filePath, maxBytes = 64 * 1024 * 1024) {
  return crypto.createHash('sha256').update(readFileNoFollowBounded(filePath, maxBytes)).digest('hex')
}
