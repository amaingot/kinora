import { describe, expect, it, vi } from 'vitest'

// An SSO-only self-host: KINORA_DISABLE_PASSWORD_AUTH=true. passwordAuthEnabled is env-derived at
// module load, so pin it and re-import the auth graph with it.
vi.mock('../src/lib/env', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/lib/env')>()),
  passwordAuthEnabled: false,
  oidc: {
    issuerUrl: 'https://idp.test',
    discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
    clientId: 'kinora',
    clientSecret: 'shhh',
    name: 'Acme SSO',
    scopes: ['openid', 'profile', 'email'],
    pkce: true,
  },
}))
vi.resetModules()

const { auth } = await import('../src/lib/auth')
const { appRouter } = await import('../src/router/index')
const { resetDb } = await import('./helpers')

await resetDb()

describe('sso-only install', () => {
  it('refuses email sign-up and sign-in', async () => {
    await expect(auth.api.signUpEmail({
      body: { email: 'nope@acme.test', password: 'password123', name: 'Nope' },
    })).rejects.toThrow()

    await expect(auth.api.signInEmail({
      body: { email: 'nope@acme.test', password: 'password123' },
    })).rejects.toThrow()
  })

  it('leaves no password-reset path open', async () => {
    // /forget-password is gated on the sendResetPassword callback, never on `enabled` - so
    // omitting the callback is what actually closes it. Without that, /reset-password would
    // happily mint a credential account on an install that has no password login at all.
    await expect(auth.api.requestPasswordReset({
      body: { email: 'nope@acme.test', redirectTo: 'http://localhost:5173/reset-password' },
    })).rejects.toThrow()
  })

  it('tells the dashboard to hide the password UI', async () => {
    const cfg = await appRouter.createCaller({ user: null, organizationId: null, req: new Request('http://test') }).config.get()
    expect(cfg.passwordAuthEnabled).toBe(false)
    expect(cfg.oidcEnabled).toBe(true)
  })
})
