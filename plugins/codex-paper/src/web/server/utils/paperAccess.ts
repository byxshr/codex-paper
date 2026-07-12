import fs from 'node:fs'
import {
  LIMITS,
  readJsonPath,
} from './librarySecurity.mjs'

export function readJsonFile(filePath: string, label: string) {
  return readJsonPath(filePath, label, LIMITS.internalJsonBytes)
}

export function readOptionalJson(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) return null
  return readJsonFile(filePath, label)
}
