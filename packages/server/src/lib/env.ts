import { existsSync } from 'node:fs'
import process from 'node:process'
import { z } from 'zod'

if (existsSync('.env'))
  process.loadEnvFile()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']),
  PORT: z.coerce.number(),
  BASE_URL: z.url(),
  WEB_ORIGIN: z.string(),
  // Share the session cookie across subdomains (e.g. .kinora.dev for app/api). Unset = host-only (single-origin self-host).
  COOKIE_DOMAIN: z.string().optional(),
  AUTH_SECRET: z.string(),
  POSTGRES_USER: z.string(),
  POSTGRES_PASSWORD: z.string(),
  POSTGRES_HOST: z.string(),
  POSTGRES_PORT: z.coerce.number(),
  POSTGRES_DB: z.string(),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GITHUB_CLIENT_ID: z.string().default(''),
  GITHUB_CLIENT_SECRET: z.string().default(''),
  // Generic OIDC SSO (self-host): any provider exposing a discovery document.
  OIDC_ISSUER_URL: z.union([z.literal(''), z.url()]).default(''),
  OIDC_CLIENT_ID: z.string().default(''),
  OIDC_CLIENT_SECRET: z.string().default(''),
  // Shown on the sign-in button: "Continue with <name>".
  OIDC_PROVIDER_NAME: z.string().default('SSO'),
  // Space- or comma-separated. `openid profile email` is the minimum: the callback rejects a
  // sign-in missing email, sub or name.
  OIDC_SCOPES: z.string().default('openid profile email'),
  // Override when the document isn't at <issuer>/.well-known/openid-configuration.
  OIDC_DISCOVERY_URL: z.union([z.literal(''), z.url()]).default(''),
  OIDC_PKCE: z.stringbool().default(true),
  // SSO-only installs: turn off email + password sign-in and sign-up entirely.
  KINORA_DISABLE_PASSWORD_AUTH: z.stringbool().default(false),
  KINORA_CLOUD: z.stringbool().default(false),
  // Public demo instance: auto-session as the seeded demo user + read-only (no mutations/ingest/auth writes).
  KINORA_DEMO: z.stringbool().default(false),
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),
  POLAR_PRODUCT_TEAM_ID: z.string().optional(),
  POLAR_PRODUCT_PRO_ID: z.string().optional(),
  // Ingest requests per minute per client IP (DoS backstop; sharded CI spreads across IPs). Raise for pathological suites.
  INGEST_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  // Self-host retention. 0 = keep forever; ignored in cloud, where the plan tier drives it.
  KINORA_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  KINORA_KEEP_LAST_RUNS: z.coerce.number().int().nonnegative().default(0),
  KINORA_ARTIFACT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  STORAGE_DIR: z.string().default('.data/artifacts'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  // Optional: leave both unset to use the AWS SDK's default credential chain (IRSA / EKS Pod
  // Identity / instance role). Set together or not at all - see the refine below.
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  // Path-style URLs (host/bucket/key), which most S3-compatible providers (MinIO, Hetzner)
  // require. false gives virtual-hosted style (bucket.host/key), which AWS prefers - note that
  // moves the ORIGIN of presigned artifact URLs, so the dashboard CSP has to follow.
  S3_FORCE_PATH_STYLE: z.stringbool().default(true),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  FEEDBACK_TRACKER_API_KEY: z.string().optional(),
  FEEDBACK_TRACKER_PROJECT_ID: z.string().optional(),
  FEEDBACK_TRACKER_WORKSPACE_ID: z.string().optional(),
  FEEDBACK_TRACKER_API_URL: z.union([z.literal(''), z.url()]).optional(),
}).refine(
  e => !e.KINORA_CLOUD || Boolean(e.POLAR_ACCESS_TOKEN && e.POLAR_WEBHOOK_SECRET && e.POLAR_PRODUCT_TEAM_ID && e.POLAR_PRODUCT_PRO_ID),
  { message: 'KINORA_CLOUD=true requires POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_PRODUCT_TEAM_ID and POLAR_PRODUCT_PRO_ID' },
).refine(
  // Cross-subdomain cookies are a prod concern (app./api.); dev runs on localhost where
  // the two ports already share host-only cookies, so COOKIE_DOMAIN can stay empty there.
  e => !(e.KINORA_CLOUD && e.NODE_ENV === 'production') || Boolean(e.COOKIE_DOMAIN),
  { message: 'KINORA_CLOUD=true in production requires COOKIE_DOMAIN (e.g. .kinora.dev)' },
).refine(
  // Disabling password auth with no external provider configured would lock every user out.
  e => !e.KINORA_DISABLE_PASSWORD_AUTH
    || Boolean(e.OIDC_ISSUER_URL && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET)
    || Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET)
    || Boolean(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET),
  { message: 'KINORA_DISABLE_PASSWORD_AUTH=true requires OIDC_* or a social provider to be configured' },
).refine(
  // A half-configured bucket used to fall back to local disk in silence, which on Kubernetes
  // means artifacts written to a container filesystem nobody provisioned. Fail at boot instead.
  (e) => {
    const set = [e.S3_ENDPOINT, e.S3_REGION, e.S3_BUCKET].filter(Boolean).length
    return set === 0 || set === 3
  },
  { message: 'S3 artifact storage needs S3_ENDPOINT, S3_REGION and S3_BUCKET together, or none of them' },
).refine(
  // Credentials are optional (the default chain covers IRSA and friends), but exactly one of
  // the pair is always a typo, and the SDK would silently ignore the lone one.
  e => Boolean(e.S3_ACCESS_KEY_ID) === Boolean(e.S3_SECRET_ACCESS_KEY),
  { message: 'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together, or both left unset to use the AWS default credential chain (IRSA, EKS Pod Identity, instance role)' },
)

export type Env = z.infer<typeof envSchema>

export const env = envSchema.parse(process.env)

export interface CloudConfig {
  accessToken: string
  webhookSecret: string
  teamProductId: string
  proProductId: string
}

function resolveCloud(): CloudConfig | null {
  if (!env.KINORA_CLOUD)
    return null

  const { POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_PRODUCT_TEAM_ID, POLAR_PRODUCT_PRO_ID } = env
  if (!POLAR_ACCESS_TOKEN || !POLAR_WEBHOOK_SECRET || !POLAR_PRODUCT_TEAM_ID || !POLAR_PRODUCT_PRO_ID)
    throw new Error('KINORA_CLOUD=true requires all POLAR_* env vars')

  return {
    accessToken: POLAR_ACCESS_TOKEN,
    webhookSecret: POLAR_WEBHOOK_SECRET,
    teamProductId: POLAR_PRODUCT_TEAM_ID,
    proProductId: POLAR_PRODUCT_PRO_ID,
  }
}

export const cloud = resolveCloud()

export const demo = env.KINORA_DEMO

export interface RetentionPolicy {
  runDays: number
  keepLastRuns: number
  artifactDays: number
}

// null = nothing to sweep, which also gates the in-process sweeper (cloud sweeps via its own cron).
function resolveRetention(): RetentionPolicy | null {
  if (env.KINORA_CLOUD)
    return null

  const policy = {
    runDays: env.KINORA_RETENTION_DAYS,
    keepLastRuns: env.KINORA_KEEP_LAST_RUNS,
    artifactDays: env.KINORA_ARTIFACT_RETENTION_DAYS,
  }
  return policy.runDays || policy.keepLastRuns || policy.artifactDays ? policy : null
}

export const retentionPolicy = resolveRetention()

// Social login is enabled per provider only when both its id and secret are set.
export const googleOauthEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
export const githubOauthEnabled = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)

// Fixed, not env-configurable: it is also the callback path segment, the account.providerId value,
// and what the dashboard's "Last used" badge compares against.
export const OIDC_PROVIDER_ID = 'oidc'

export interface OidcConfig {
  issuerUrl: string
  discoveryUrl: string
  clientId: string
  clientSecret: string
  name: string
  scopes: string[]
  pkce: boolean
}

// Generic OIDC SSO; null unless issuer + id + secret are all set, mirroring the social providers.
function resolveOidc(): OidcConfig | null {
  const { OIDC_ISSUER_URL, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret } = env
  if (!OIDC_ISSUER_URL || !clientId || !clientSecret)
    return null

  const issuerUrl = OIDC_ISSUER_URL.replace(/\/+$/, '')
  return {
    issuerUrl,
    // better-auth fetches this verbatim, so it must be the full document URL.
    discoveryUrl: env.OIDC_DISCOVERY_URL || `${issuerUrl}/.well-known/openid-configuration`,
    clientId,
    clientSecret,
    name: env.OIDC_PROVIDER_NAME,
    scopes: env.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean),
    pkce: env.OIDC_PKCE,
  }
}

export const oidc = resolveOidc()

// SSO-only installs flip this off; the refine above guarantees a provider exists when they do.
export const passwordAuthEnabled = !env.KINORA_DISABLE_PASSWORD_AUTH

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  // Absent means "resolve them yourself": s3Storage() then omits the SDK's `credentials` option
  // so it falls back to the default provider chain - env vars, shared config, the web identity
  // token file (IRSA), the container credentials endpoint (EKS Pod Identity), IMDS.
  accessKey?: string
  secretKey?: string
  forcePathStyle: boolean
}

// Exported for the tests; the refines above guarantee the three coordinates are all-or-nothing
// and that the credential pair is never half-set, so this stays a total function.
export function resolveS3(): S3Config | null {
  const {
    S3_ENDPOINT: endpoint,
    S3_REGION: region,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: accessKey,
    S3_SECRET_ACCESS_KEY: secretKey,
  } = env
  if (!endpoint || !region || !bucket)
    return null
  // `|| undefined` because both .env.example files ship these as empty strings, and an absent
  // credential is what s3Storage() keys off to omit the SDK's `credentials` option entirely.
  return {
    endpoint,
    region,
    bucket,
    accessKey: accessKey || undefined,
    secretKey: secretKey || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  }
}

export const s3 = resolveS3()

export interface SlackAppConfig {
  clientId: string
  clientSecret: string
}

// "Add to Slack" OAuth app; null falls back to the manual webhook-URL paste
function resolveSlackApp(): SlackAppConfig | null {
  const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: clientSecret } = env
  if (!clientId || !clientSecret)
    return null
  return { clientId, clientSecret }
}

export const slackApp = resolveSlackApp()

export interface SmtpConfig {
  host: string
  port: number
  user?: string
  pass?: string
  from: string
}

// Generic SMTP so self-hosters can plug any provider; null disables email flows.
function resolveSmtp(): SmtpConfig | null {
  const { SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user, SMTP_PASS: pass, SMTP_FROM: from } = env
  if (!host || !port || !from)
    return null
  return { host, port, user, pass, from }
}

export const smtp = resolveSmtp()

export interface FeedbackTrackerConfig {
  apiKey: string
  projectId: string
  workspaceId: string
  apiUrl: string
}

// User feedback -> private task tracker. Cloud-only: self-host instances must not post to our tracker.
function resolveFeedbackTracker(): FeedbackTrackerConfig | null {
  if (!env.KINORA_CLOUD)
    return null
  const {
    FEEDBACK_TRACKER_API_KEY: apiKey,
    FEEDBACK_TRACKER_PROJECT_ID: projectId,
    FEEDBACK_TRACKER_WORKSPACE_ID: workspaceId,
    FEEDBACK_TRACKER_API_URL: apiUrl,
  } = env
  if (!apiKey || !projectId || !workspaceId || !apiUrl)
    return null
  return { apiKey, projectId, workspaceId, apiUrl }
}

export const feedbackTrackerConfig = resolveFeedbackTracker()
