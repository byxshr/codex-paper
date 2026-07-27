// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },

  devServer: {
    host: '127.0.0.1',
    port: 5815
  },

  modules: ['@nuxt/content'],

  nitro: {
    externals: {
      inline: [/package-compatibility\.mjs$/, /paper-library\.mjs$/, /generation-manifest\.mjs$/, /storage-transaction\.mjs$/]
    }
  },

  app: {
    head: {
      title: 'Codex Paper Library',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Interactive research paper study library' }
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }
      ]
    }
  }
})
