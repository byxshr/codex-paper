import { homedir } from 'os'
import { getLibraryPaths } from '../../utils/librarySecurity.mjs'

export default defineEventHandler(() => {
  return {
    homedir: homedir(),
    libraryRoot: getLibraryPaths().libraryRoot,
  }
})
