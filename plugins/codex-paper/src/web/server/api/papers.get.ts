import { readLibraryIndex } from '../utils/librarySecurity.mjs'

export default defineEventHandler(() => readLibraryIndex().papers)
