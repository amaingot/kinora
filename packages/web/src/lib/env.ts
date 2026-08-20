import { DEFAULT_KINORA_URL } from '@kinora/core'

// Build-time config from VITE_KINORA_* env (see .env.example / docker build args).
const DEV = import.meta.env.DEV

export const env = {
  // Unset = same origin as the page. The published self-host web image leaves it unset: its nginx
  // reverse-proxies /api, /trpc and /artifacts to the server, so one image fits any PUBLIC_URL.
  // (No `location` outside a browser, e.g. unit tests: '' keeps the URLs relative.)
  serverUrl: import.meta.env.VITE_KINORA_SERVER_URL || globalThis.location?.origin || '',
  // Trace viewer: own dev server in dev, served under /trace/ in prod.
  viewerBaseUrl: import.meta.env.VITE_KINORA_VIEWER_URL || (DEV ? 'http://localhost:5174/' : '/trace/'),
  sentryDsn: import.meta.env.VITE_KINORA_SENTRY_DSN,
}

export const isSelfHost = env.serverUrl !== DEFAULT_KINORA_URL
