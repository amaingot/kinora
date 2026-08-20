import { afterEach, describe, expect, it, vi } from 'vitest'

// env.ts reads import.meta.env at module load, so each case stubs then re-imports a fresh copy.
async function loadEnv(serverUrl: string | undefined) {
  vi.resetModules()
  vi.stubEnv('VITE_KINORA_SERVER_URL', serverUrl)
  vi.stubGlobal('location', { origin: 'https://kinora.example.com' })
  return import('@/lib/env')
}

describe('env.serverUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('uses VITE_KINORA_SERVER_URL when set', async () => {
    const { env, isSelfHost } = await loadEnv('https://api.kinora.dev')
    expect(env.serverUrl).toBe('https://api.kinora.dev')
    expect(isSelfHost).toBe(false)
  })

  it('falls back to the page origin when unset (single-origin self-host image)', async () => {
    const { env, isSelfHost } = await loadEnv(undefined)
    expect(env.serverUrl).toBe('https://kinora.example.com')
    expect(isSelfHost).toBe(true)
  })

  it('treats an empty value like unset (Dockerfile mirrors an omitted ARG as an empty ENV)', async () => {
    const { env } = await loadEnv('')
    expect(env.serverUrl).toBe('https://kinora.example.com')
  })
})
