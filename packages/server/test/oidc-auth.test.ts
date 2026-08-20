import type { OidcConfig } from '../src/lib/env'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The OIDC config is env-derived at module load, so pin one and re-import the graph with it.
const OIDC: OidcConfig = {
  issuerUrl: 'https://idp.test',
  discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
  clientId: 'kinora',
  clientSecret: 'shhh',
  name: 'Acme SSO',
  scopes: ['openid', 'profile', 'email'],
  pkce: true,
}

vi.mock('../src/lib/env', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/lib/env')>()),
  oidc: OIDC,
}))
vi.resetModules()

const { auth } = await import('../src/lib/auth')
const { db } = await import('../src/db')
const { account, member, organization, user } = await import('../src/db/schemas/index')
const { appRouter } = await import('../src/router/index')
const { resetDb } = await import('./helpers')

beforeEach(resetDb)

const DISCOVERY = {
  issuer: OIDC.issuerUrl,
  authorization_endpoint: `${OIDC.issuerUrl}/authorize`,
  token_endpoint: `${OIDC.issuerUrl}/token`,
  userinfo_endpoint: `${OIDC.issuerUrl}/userinfo`,
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

// Stand in for the IdP: discovery + token + userinfo. No id_token, so better-auth takes the
// userinfo path and we avoid having to sign a JWT.
function stubIdp(profile: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith(OIDC.discoveryUrl))
      return json(DISCOVERY)
    if (url.startsWith(DISCOVERY.token_endpoint))
      return json({ access_token: 'at_1', token_type: 'bearer', expires_in: 3600, scope: 'openid profile email' })
    if (url.startsWith(DISCOVERY.userinfo_endpoint))
      return json(profile)
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

// Drive the full authorize -> callback handshake and hand back the callback's redirect target.
// kinora runs without secondary storage, so better-auth keeps the OAuth state in an encrypted
// `oauth_state` cookie rather than the verification table - the callback needs it echoed back.
async function signInThroughIdp(profile: Record<string, unknown>): Promise<string> {
  stubIdp(profile)
  const authorize = await auth.api.signInWithOAuth2({
    body: { providerId: 'oidc', callbackURL: 'http://localhost:5173' },
    asResponse: true,
  })
  const { url } = await authorize.json() as { url: string }
  const state = new URL(url).searchParams.get('state')
  expect(state).toBeTruthy()

  const cookie = authorize.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  const res = await auth.api.oAuth2Callback({
    params: { providerId: 'oidc' },
    query: { code: 'auth_code', state: state! },
    headers: new Headers({ cookie }),
    asResponse: true,
  })
  return res.headers.get('location') ?? ''
}

afterEach(() => vi.unstubAllGlobals())

describe('oidc capability plumbing', () => {
  it('advertises the provider to the dashboard', async () => {
    const cfg = await appRouter.createCaller({ user: null, organizationId: null, req: new Request('http://test') }).config.get()
    expect(cfg.oidcEnabled).toBe(true)
    expect(cfg.oidcProviderName).toBe('Acme SSO')
    // Untouched by OIDC: the default suite still runs with password auth on.
    expect(cfg.passwordAuthEnabled).toBe(true)
  })
})

describe('oidc sign-in', () => {
  it('provisions a new user just-in-time, with a personal workspace', async () => {
    const location = await signInThroughIdp({
      sub: 'idp-user-1',
      email: 'newhire@acme.test',
      email_verified: true,
      name: 'New Hire',
    })
    expect(location).toContain('localhost:5173')

    const created = await db.query.user.findFirst({ where: eq(user.email, 'newhire@acme.test') })
    expect(created).toBeTruthy()

    // The identity is stored against our fixed provider id, not a social one.
    const acct = await db.query.account.findFirst({ where: eq(account.userId, created!.id) })
    expect(acct?.providerId).toBe('oidc')
    expect(acct?.accountId).toBe('idp-user-1')

    // The JIT payoff: the user.create.after hook gave them a workspace they own.
    const m = await db.query.member.findFirst({ where: eq(member.userId, created!.id) })
    expect(m?.role).toBe('owner')
    const org = await db.query.organization.findFirst({ where: eq(organization.id, m!.organizationId) })
    expect(org).toBeTruthy()
  })

  it('falls back to preferred_username when the IdP sends no name claim', async () => {
    // better-auth rejects the callback outright ("name_is_missing") without our mapProfileToUser.
    await signInThroughIdp({
      sub: 'idp-user-2',
      email: 'noname@acme.test',
      email_verified: true,
      preferred_username: 'noname',
    })
    const created = await db.query.user.findFirst({ where: eq(user.email, 'noname@acme.test') })
    expect(created?.name).toBe('noname')
  })

  it('links into an existing unverified password account instead of duplicating it', async () => {
    // A no-SMTP self-host never verifies emails, so this is the normal migration case.
    const existing = await auth.api.signUpEmail({
      body: { email: 'veteran@acme.test', password: 'password123', name: 'Veteran' },
    })
    expect(existing.user.emailVerified).toBe(false)

    await signInThroughIdp({
      sub: 'idp-user-3',
      email: 'veteran@acme.test',
      email_verified: true,
      name: 'Veteran',
    })

    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, 'veteran@acme.test'))
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(existing.user.id)

    // Same user, now carrying both a credential and an oidc account.
    const accounts = await db.select({ providerId: account.providerId }).from(account).where(eq(account.userId, existing.user.id))
    expect(accounts.map(a => a.providerId).sort()).toEqual(['credential', 'oidc'])
  })
})

// The env module itself: resolution + the boot guard. Re-imported fresh per case, so these
// deliberately bypass the module-level mock above.
async function loadEnv(overrides: Record<string, string>) {
  vi.resetModules()
  vi.doUnmock('../src/lib/env')
  for (const [k, v] of Object.entries(overrides))
    vi.stubEnv(k, v)
  return import('../src/lib/env')
}

describe('oidc env resolution', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('stays null unless issuer, id and secret are all set', async () => {
    expect((await loadEnv({ OIDC_ISSUER_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' })).oidc).toBeNull()
    expect((await loadEnv({ OIDC_ISSUER_URL: 'https://idp.test', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: '' })).oidc).toBeNull()
  })

  it('derives the discovery URL from the issuer and trims a trailing slash', async () => {
    const { oidc } = await loadEnv({
      OIDC_ISSUER_URL: 'https://idp.test/realms/acme/',
      OIDC_CLIENT_ID: 'a',
      OIDC_CLIENT_SECRET: 'b',
    })
    expect(oidc?.issuerUrl).toBe('https://idp.test/realms/acme')
    expect(oidc?.discoveryUrl).toBe('https://idp.test/realms/acme/.well-known/openid-configuration')
  })

  it('honors an explicit discovery URL override', async () => {
    const { oidc } = await loadEnv({
      OIDC_ISSUER_URL: 'https://idp.test',
      OIDC_CLIENT_ID: 'a',
      OIDC_CLIENT_SECRET: 'b',
      OIDC_DISCOVERY_URL: 'https://idp.test/oauth/.well-known/openid-config',
    })
    expect(oidc?.discoveryUrl).toBe('https://idp.test/oauth/.well-known/openid-config')
  })

  it('splits scopes on spaces or commas', async () => {
    const base = { OIDC_ISSUER_URL: 'https://idp.test', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b' }
    expect((await loadEnv({ ...base, OIDC_SCOPES: 'openid  profile email' })).oidc?.scopes).toEqual(['openid', 'profile', 'email'])
    expect((await loadEnv({ ...base, OIDC_SCOPES: 'openid,profile,groups' })).oidc?.scopes).toEqual(['openid', 'profile', 'groups'])
  })

  it('refuses to boot when password auth is disabled with no provider configured', async () => {
    await expect(loadEnv({
      KINORA_DISABLE_PASSWORD_AUTH: 'true',
      OIDC_ISSUER_URL: '',
      OIDC_CLIENT_ID: '',
      OIDC_CLIENT_SECRET: '',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
    })).rejects.toThrow()
  })

  it('boots SSO-only when OIDC is configured, and turns password auth off', async () => {
    const { passwordAuthEnabled, oidc } = await loadEnv({
      KINORA_DISABLE_PASSWORD_AUTH: 'true',
      OIDC_ISSUER_URL: 'https://idp.test',
      OIDC_CLIENT_ID: 'a',
      OIDC_CLIENT_SECRET: 'b',
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
    })
    expect(passwordAuthEnabled).toBe(false)
    expect(oidc).not.toBeNull()
  })
})
