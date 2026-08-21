import { afterEach, describe, expect, it, vi } from 'vitest'

// env.ts parses process.env once, at import, so each case stubs the S3_* vars and re-imports the
// module fresh. These are the rules the Helm chart mirrors in templates/_validations.tpl - the
// point of every one of them is that a half-configured bucket used to fall back to local disk in
// silence, which on Kubernetes means writing traces to a container filesystem nobody provisioned.
async function loadEnv(vars: Record<string, string>): Promise<typeof import('../src/lib/env')> {
  for (const [key, value] of Object.entries(vars))
    vi.stubEnv(key, value)
  vi.resetModules()
  return import('../src/lib/env')
}

const COORDS = {
  S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'kinora-artifacts',
}

describe('resolveS3', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is null when nothing is configured, which is the local-disk default', async () => {
    const { resolveS3 } = await loadEnv({})
    expect(resolveS3()).toBeNull()
  })

  it('returns static credentials when both are set', async () => {
    const { resolveS3 } = await loadEnv({
      ...COORDS,
      S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      S3_SECRET_ACCESS_KEY: 'secret',
    })
    expect(resolveS3()).toMatchObject({
      bucket: 'kinora-artifacts',
      accessKey: 'AKIAEXAMPLE',
      secretKey: 'secret',
      forcePathStyle: true,
    })
  })

  it('activates on the three coordinates alone, leaving credentials to the SDK chain', async () => {
    const { resolveS3 } = await loadEnv(COORDS)
    const config = resolveS3()
    expect(config).toMatchObject({ bucket: 'kinora-artifacts' })
    // Absent, not empty: s3Storage() keys off this to omit the SDK's `credentials` option.
    expect(config?.accessKey).toBeUndefined()
    expect(config?.secretKey).toBeUndefined()
  })

  it('carries S3_FORCE_PATH_STYLE through', async () => {
    const { resolveS3 } = await loadEnv({ ...COORDS, S3_FORCE_PATH_STYLE: 'false' })
    expect(resolveS3()?.forcePathStyle).toBe(false)
  })

  it('refuses a partial set of coordinates instead of falling back to local disk', async () => {
    await expect(loadEnv({ S3_ENDPOINT: COORDS.S3_ENDPOINT, S3_BUCKET: COORDS.S3_BUCKET }))
      .rejects
      .toThrow(/S3_ENDPOINT, S3_REGION and S3_BUCKET together/)
  })

  it('refuses exactly one half of the credential pair', async () => {
    await expect(loadEnv({ ...COORDS, S3_ACCESS_KEY_ID: 'AKIAEXAMPLE' }))
      .rejects
      .toThrow(/must be set together/)
  })
})
