function serializeForScript(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export default defineEventHandler((event) => {
  const runtimeConfig = useRuntimeConfig(event)
  const clientConfig = {
    public: runtimeConfig.public,
    app: runtimeConfig.app,
  }
  setHeader(event, 'Content-Type', 'application/javascript; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-store')
  return `window.__NUXT__={};window.__NUXT__.config=${serializeForScript(clientConfig)};`
})
