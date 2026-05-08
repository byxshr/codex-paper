import { joinRelativeURL } from 'ufo'

const appConfig = {
  baseURL: process.env.NUXT_APP_BASE_URL || '/',
  buildAssetsDir: process.env.NUXT_APP_BUILD_ASSETS_DIR || '/_nuxt/',
  cdnURL: process.env.NUXT_APP_CDN_URL || ''
}

export function baseURL () {
  return appConfig.baseURL
}

export function buildAssetsDir () {
  return appConfig.buildAssetsDir
}

export function publicAssetsURL (...path) {
  const publicBase = appConfig.cdnURL || appConfig.baseURL
  return path.length ? joinRelativeURL(publicBase, ...path) : publicBase
}

export function buildAssetsURL (...path) {
  return joinRelativeURL(publicAssetsURL(), buildAssetsDir(), ...path)
}
