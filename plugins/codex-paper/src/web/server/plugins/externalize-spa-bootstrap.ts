export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (htmlContext) => {
    htmlContext.bodyAppend = htmlContext.bodyAppend.map((chunk) => chunk.replace(
      /<script>window\.__NUXT__=\{\};window\.__NUXT__\.config=[\s\S]*?<\/script>/,
      '<script src="/__codex-paper-spa-bootstrap.js"></script>'
    ))
  })
})
