import { readLibraryIndex } from '../utils/librarySecurity.mjs'
import { sanitizePaperIndexEntry } from '../utils/activeContentSecurity.mjs'

export default defineEventHandler(() => readLibraryIndex().papers.map(sanitizePaperIndexEntry))
