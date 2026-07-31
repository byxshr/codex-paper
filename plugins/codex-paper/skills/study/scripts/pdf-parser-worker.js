#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePdfDetailedWorkerInternal } from './parse-pdf.js'
import { PDF_SECURITY_POLICY, validateParsedPdf } from './pdf-security.js'

const __filename = fileURLToPath(import.meta.url)

async function main() {
  if (process.env.CODEX_PAPER_PARSER_WORKER !== '1' || process.argv.length !== 5) {
    throw new Error('PDF parser worker must be started by the bounded supervisor.')
  }
  const [, , inputPath, outputPath, sourceFilename] = process.argv
  const result = validateParsedPdf(await parsePdfDetailedWorkerInternal(inputPath, { sourceFilename }))
  const payload = `${JSON.stringify(result)}\n`
  if (Buffer.byteLength(payload) > PDF_SECURITY_POLICY.parserOutputBytes) {
    const error = new Error(`PDF parser output exceeds ${PDF_SECURITY_POLICY.parserOutputBytes} bytes.`)
    error.code = 'parser_output_limit'
    throw error
  }
  fs.writeFileSync(outputPath, payload, { flag: 'wx', mode: 0o600 })
  fs.chmodSync(outputPath, 0o600)
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    process.stderr.write(`${error.code || 'pdf_parse_failed'}: ${String(error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 2048)}\n`)
    process.exit(1)
  })
}
