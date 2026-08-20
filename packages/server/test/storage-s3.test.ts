import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { s3Storage } from '../src/lib/storage'

// Exercises the real S3 path (lib-storage streaming Upload + presigned GET + delete) against the
// MinIO from the dev docker-compose (always up alongside Postgres). The global `storage` singleton
// stays on local FS (test-env keeps S3_* empty) so the FS path + signed /artifacts serving stay covered.
//
// What these tests CANNOT prove, because CI has no AWS account: that fromTokenFile actually reaches
// STS, that an IRSA role's trust policy is right, or that a real presigned URL carrying a session
// token returns 200. They cover the code we own - that `credentials` is omitted so the SDK's own
// chain runs, and that the presigner carries a session token through when one exists.
const config = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'kinora-test',
  accessKey: 'minio',
  secretKey: 'minio12345',
  forcePathStyle: true,
}

describe('s3 storage', () => {
  const storage = s3Storage(config)

  beforeAll(async () => {
    const client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      forcePathStyle: true,
    })
    try {
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }))
    }
    catch {
      // bucket already exists from a previous run
    }
  })

  it('streams a Readable body up and back down byte-for-byte via the presigned url', async () => {
    const bytes = Buffer.from('PK\x03\x04 streamed-via-lib-storage-multipart')
    const key = `test/${randomUUID()}-stream.zip`
    await storage.put(key, Readable.from([bytes]))
    const res = await fetch(await storage.url(key))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    await storage.delete(key)
  })

  it('accepts a Buffer body too (the seed path)', async () => {
    const bytes = Buffer.from('buffer-body-path')
    const key = `test/${randomUUID()}-buf.zip`
    await storage.put(key, bytes)
    const res = await fetch(await storage.url(key))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    await storage.delete(key)
  })

  it('delete removes the object', async () => {
    const key = `test/${randomUUID()}-del.zip`
    await storage.put(key, Buffer.from('x'))
    await storage.delete(key)
    const res = await fetch(await storage.url(key))
    expect(res.ok).toBe(false)
  })

  it('puts the bucket in the path, or in the host with forcePathStyle off', async () => {
    const key = 'test/path-style.zip'
    expect(await s3Storage(config).url(key)).toContain('localhost:9000/kinora-test/')
    expect(await s3Storage({ ...config, forcePathStyle: false }).url(key))
      .toContain('kinora-test.localhost:9000/')
  })
})

// The workload-identity path: no accessKey/secretKey on the config at all, so s3Storage omits the
// SDK's `credentials` option and the default provider chain resolves them instead. fromEnv is the
// first link of that chain and fromTokenFile (IRSA) is a later link of the SAME chain, so pointing
// AWS_* at MinIO exercises the exact production code path with no AWS account involved.
describe('s3 storage without static credentials', () => {
  afterEach(() => vi.unstubAllEnvs())

  // Everything a developer's machine might otherwise resolve from: a stray ~/.aws, an AWS_PROFILE
  // (which makes the chain skip fromEnv entirely), or a 1s IMDS timeout on a non-EC2 host.
  const isolateChain = (): void => {
    vi.stubEnv('AWS_PROFILE', undefined)
    vi.stubEnv('AWS_SESSION_TOKEN', undefined)
    vi.stubEnv('AWS_WEB_IDENTITY_TOKEN_FILE', undefined)
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', undefined)
    vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', undefined)
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  }

  const keyless = { endpoint: config.endpoint, region: config.region, bucket: config.bucket, forcePathStyle: true }

  it('round-trips an artifact using credentials from the default chain', async () => {
    isolateChain()
    vi.stubEnv('AWS_ACCESS_KEY_ID', config.accessKey)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', config.secretKey)
    // Built AFTER the stubs on purpose: the SDK memoizes the resolved provider per client, so a
    // client constructed earlier would have cached the wrong answer.
    const storage = s3Storage(keyless)
    const bytes = Buffer.from('resolved-by-the-default-credential-chain')
    const key = `test/${randomUUID()}-chain.zip`
    await storage.put(key, bytes)
    const res = await fetch(await storage.url(key))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    await storage.delete(key)
  })

  it('hoists a session token into the presigned url, as IRSA credentials carry one', async () => {
    isolateChain()
    vi.stubEnv('AWS_ACCESS_KEY_ID', config.accessKey)
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', config.secretKey)
    vi.stubEnv('AWS_SESSION_TOKEN', 'FAKE-SESSION-TOKEN')
    // URL shape only - MinIO would reject this token, and the point is that SigV4 presigning
    // carries temporary credentials through at all.
    const url = await s3Storage(keyless).url('test/sts.zip')
    expect(url).toContain('X-Amz-Security-Token=FAKE-SESSION-TOKEN')
  })
})
