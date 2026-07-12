import { initializeSecurity } from '../utils/sessionSecurity.mjs'

export default defineNitroPlugin(() => {
  if (!import.meta.prerender) initializeSecurity()
})
