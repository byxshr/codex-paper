import { acquireStorageLocks } from '../../../plugins/codex-paper/src/shared/storage-transaction.mjs'

const handle = await acquireStorageLocks([process.argv[2]], { libraryRoot: process.env.PAPERS_DIR, timeoutMs: 0 })
process.stdout.write('ready\n')
process.stdin.resume()
process.stdin.once('data', () => {
  handle.release()
  process.exit(0)
})
