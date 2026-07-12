const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-attr 'none'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "worker-src 'none'",
  "form-action 'self'"
].join('; ')

export default defineEventHandler((event) => {
  const pathname = getRequestURL(event).pathname
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'X-DNS-Prefetch-Control', 'off')
  setHeader(event, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()')

  if (pathname.startsWith('/api/')) {
    setHeader(event, 'Cache-Control', 'no-store')
    return
  }

  setHeader(event, 'Content-Security-Policy', APP_CSP)
  setHeader(event, 'X-Frame-Options', 'DENY')
  setHeader(event, 'Cross-Origin-Opener-Policy', 'same-origin')
})
