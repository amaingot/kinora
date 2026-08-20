---
title: Environment variables
section: Reference
description: Every environment variable the kinora server reads, with defaults and when each is required.
---

This is the full reference for the **server process** environment. If you run the self-host Docker
Compose bundle, you configure a friendlier subset (`PUBLIC_URL`, `WEB_PORT`, ...) that maps onto
these internally - see [Configuration](/self-hosting/configuration/). The
[Helm chart](/self-hosting/kubernetes/) exposes the same set as chart values. Run the server
directly and these are the variables it reads.

Config is validated at startup (zod); a missing required variable, or `KINORA_CLOUD=true` without
its Polar variables, stops the server from booting.

## Core

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | - | `development` or `production`. |
| `PORT` | yes | - | Port the server listens on. |
| `BASE_URL` | yes | - | The server's own public URL. Drives auth callbacks and absolute links. |
| `WEB_ORIGIN` | yes | - | The dashboard origin. Used to build run URLs and email links. |
| `AUTH_SECRET` | yes | - | Session secret. Generate one: `openssl rand -hex 32`. |
| `KINORA_CLOUD` | no | `false` | Cloud mode (enables Polar billing). `false` = self-host, every feature unlimited. |
| `KINORA_DEMO` | no | `false` | Public read-only demo: auto-session as the seeded demo user, no mutations/ingest. |
| `INGEST_RATE_LIMIT` | no | `600` | Ingest requests per minute per client IP (DoS backstop). Raise for pathological suites. |

## Cookies

| Variable | Required | Notes |
| --- | --- | --- |
| `COOKIE_DOMAIN` | conditional | Share the session cookie across subdomains (e.g. `.kinora.dev` for `app.`/`api.`). Leave unset for single-origin self-host (host-only cookie). **Required** when `KINORA_CLOUD=true` in production. |

## Database (Postgres)

| Variable | Required | Notes |
| --- | --- | --- |
| `POSTGRES_HOST` | yes | Database host. |
| `POSTGRES_PORT` | yes | Database port. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | yes | Credentials and database name. |

## Artifact storage

Leave the `S3_*` variables unset to store artifacts on local disk. Set **all five** to use an
S3-compatible store instead. See [Storage & artifacts](/self-hosting/storage/).

| Variable | Default | Notes |
| --- | --- | --- |
| `STORAGE_DIR` | `.data/artifacts` | Local directory for artifacts when S3 is not configured. |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` | - | S3-compatible endpoint, region, bucket. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | - | S3 credentials. |

## Social login (optional)

A provider is enabled only when **both** its id and secret are set. Leave empty for email +
password only.

| Variable | Notes |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth. |

## Single sign-on (OIDC, optional)

Point kinora at any OpenID Connect provider - Okta, Keycloak, Entra ID, Authentik, Auth0,
Google Workspace. Enabled once `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are
all set; the dashboard then shows a **Continue with &lt;name&gt;** button as the first sign-in option.

Register this redirect URL with your IdP:

```
${BASE_URL}/api/auth/oauth2/callback/oidc
```

Users are provisioned **just-in-time**: a first sign-in creates the account and its personal
workspace. If the email already belongs to a kinora account, the SSO identity is linked to it
instead of creating a duplicate, so existing users can move onto SSO without losing their
projects.

| Variable | Default | Notes |
| --- | --- | --- |
| `OIDC_ISSUER_URL` | - | Issuer URL, e.g. `https://sso.example.com/realms/acme`. Empty disables SSO. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | - | Credentials for a **confidential** client. |
| `OIDC_PROVIDER_NAME` | `SSO` | Button label: "Continue with ...". |
| `OIDC_SCOPES` | `openid profile email` | Space- or comma-separated. Sign-in fails if the IdP returns no `email` or `sub`, so don't narrow these without reason. A `name` claim is optional - kinora falls back to `preferred_username`, `given_name`, or the email local part. |
| `OIDC_DISCOVERY_URL` | *(derived)* | Only if the document isn't at `<issuer>/.well-known/openid-configuration`. |
| `OIDC_PKCE` | `true` | Turn off only for an IdP that can't do PKCE. |
| `KINORA_DISABLE_PASSWORD_AUTH` | `false` | `true` turns off email + password sign-in and sign-up entirely. |

`KINORA_DISABLE_PASSWORD_AUTH=true` requires `OIDC_*` or a social provider to be configured - the
server refuses to boot otherwise, so a typo can't lock every user out. In that mode the sign-up
and password-reset pages redirect to the login page, and an invited teammate must sign in through
the IdP before they can accept the invitation.

**Troubleshooting.** A wrong `OIDC_ISSUER_URL` surfaces as a generic `400` on sign-in; the real
cause (a failed discovery fetch) is in the server log. A sign-in that bounces back with
`email_is_missing` means the IdP isn't releasing an `email` claim - fix the scope or claim mapping
on the IdP side. A missing `name` claim is fine: kinora derives a display name from
`preferred_username`, `given_name`, or the email local part.

## Email (SMTP, optional)

`SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM` together enable email (verification, password reset,
invitations, and alert emails). Leave `SMTP_HOST` empty to disable all email flows.

| Variable | Notes |
| --- | --- |
| `SMTP_HOST` | SMTP server host. Empty disables email. |
| `SMTP_PORT` | SMTP port. |
| `SMTP_USER` / `SMTP_PASS` | Credentials (optional; some relays need none). |
| `SMTP_FROM` | From address, e.g. `kinora <no-reply@example.dev>`. |

## Slack (optional)

| Variable | Notes |
| --- | --- |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | The "Add to Slack" OAuth app. Without it, Slack alerts fall back to a manually pasted webhook URL. |

## Cloud billing (Polar)

Required when `KINORA_CLOUD=true`; unused on self-host. The server refuses to boot in cloud mode
without all four.

| Variable | Notes |
| --- | --- |
| `POLAR_ACCESS_TOKEN` | Polar API token. |
| `POLAR_WEBHOOK_SECRET` | Verifies Polar webhooks. |
| `POLAR_PRODUCT_TEAM_ID` / `POLAR_PRODUCT_PRO_ID` | Polar product ids for the paid plans. |

## Observability (optional)

| Variable | Notes |
| --- | --- |
| `SENTRY_DSN` | Server error reporting. Empty disables it. |

## Feedback tracker (cloud-only)

Powers the in-app "Send feedback" form. Cloud-only: a self-host instance never posts to the Kinora
issue tracker, so these are ignored unless `KINORA_CLOUD=true`.

| Variable | Notes |
| --- | --- |
| `FEEDBACK_TRACKER_API_KEY` / `FEEDBACK_TRACKER_PROJECT_ID` / `FEEDBACK_TRACKER_WORKSPACE_ID` / `FEEDBACK_TRACKER_API_URL` | Private task tracker credentials and endpoint. Leave empty for self-host. |
