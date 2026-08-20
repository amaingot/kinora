import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const ci = !!process.env.CI

// Same self-booted, disposable stack in dev and CI: dedicated ports + a kinora_e2e DB,
// so locally the dev stack (3000/5173, dev DB) keeps running untouched. `db:reset:e2e`
// (run by the test:e2e script, before playwright) prepares the DB.
const SERVER_PORT = 3399
const WEB_PORT = 5399
const serverUrl = `http://localhost:${SERVER_PORT}`
const baseURL = `http://localhost:${WEB_PORT}`

// A second stack in SSO-only mode (KINORA_DISABLE_PASSWORD_AUTH=true + OIDC configured), because
// the deployment mode is fixed at boot and can't be toggled per-test. Shares the kinora_e2e DB;
// the sso-only specs never sign in, so the issuer below is never dialled.
const SSO_SERVER_PORT = 3398
const SSO_WEB_PORT = 5398
const ssoServerUrl = `http://localhost:${SSO_SERVER_PORT}`
const ssoBaseURL = `http://localhost:${SSO_WEB_PORT}`

// Single source for the server URL; e2e helpers read it for direct tRPC probes.
process.env.E2E_SERVER_URL = serverUrl

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  webServer: [
    {
      // Inline env so it reliably reaches the spawned process. .env file (dev) / job env (CI) fills the rest.
      // Dummy OAuth creds so the login page renders the social buttons (they're hidden when a provider is unconfigured).
      command: `PORT=${SERVER_PORT} BASE_URL=${serverUrl} WEB_ORIGIN=${baseURL} POSTGRES_DB=kinora_e2e KINORA_CLOUD=false GOOGLE_CLIENT_ID=e2e GOOGLE_CLIENT_SECRET=e2e GITHUB_CLIENT_ID=e2e GITHUB_CLIENT_SECRET=e2e pnpm --filter @kinora/server start`,
      url: `${serverUrl}/healthcheck`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `VITE_KINORA_SERVER_URL=${serverUrl} pnpm --filter @kinora/web exec vite --port ${WEB_PORT} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // SSO-only: no social creds, so the login page renders the OIDC button and nothing else.
      command: `PORT=${SSO_SERVER_PORT} BASE_URL=${ssoServerUrl} WEB_ORIGIN=${ssoBaseURL} POSTGRES_DB=kinora_e2e KINORA_CLOUD=false KINORA_DISABLE_PASSWORD_AUTH=true OIDC_ISSUER_URL=http://localhost:9/realms/e2e OIDC_CLIENT_ID=e2e OIDC_CLIENT_SECRET=e2e OIDC_PROVIDER_NAME='E2E SSO' pnpm --filter @kinora/server start`,
      url: `${ssoServerUrl}/healthcheck`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `VITE_KINORA_SERVER_URL=${ssoServerUrl} pnpm --filter @kinora/web exec vite --port ${SSO_WEB_PORT} --strictPort`,
      url: ssoBaseURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /sso-only\.spec\.ts/ },
    { name: 'sso-only', use: { ...devices['Desktop Chrome'], baseURL: ssoBaseURL }, testMatch: /sso-only\.spec\.ts/ },
  ],
})
