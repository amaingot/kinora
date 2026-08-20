---
title: Configuration
description: Every environment variable for a self-hosted kinora, copied from selfhost/.env.example.
---

Self-host is configured entirely through `.env` (read by `docker-compose.yml`). Copy
`.env.example` to `.env` and edit it. Below is every variable.

## Required

| Variable | Notes |
| --- | --- |
| `PUBLIC_URL` | The URL users reach kinora at. Drives links, cookies, and artifact URLs. Default `http://localhost:8080`. Baked into the web image at build time. |
| `AUTH_SECRET` | Session secret. Generate one: `openssl rand -hex 32`. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Database credentials. |

## Server & networking

| Variable | Default | Notes |
| --- | --- | --- |
| `WEB_PORT` | `8080` | Host port the web container binds to. Match `PUBLIC_URL`. |
| `POSTGRES_PORT` | `5432` | Postgres port. `POSTGRES_HOST` is set to the compose service automatically. |
| `KINORA_CLOUD` | `false` | Keep `false` for self-host: no billing, every feature unlimited. |
| `COOKIE_DOMAIN` | *(empty)* | Leave empty for single-origin (host-only cookie). |

## Email (optional)

Enables email verification, password reset, invitations, and alert emails. Any SMTP provider
works (Resend, Brevo, SES, self-hosted). Leave `SMTP_HOST` empty to disable all email flows.

| Variable | Default | Notes |
| --- | --- | --- |
| `SMTP_HOST` | *(empty)* | SMTP server host. Empty disables email. |
| `SMTP_PORT` | `587` | SMTP port. |
| `SMTP_USER` / `SMTP_PASS` | *(empty)* | SMTP credentials. |
| `SMTP_FROM` | *(example)* | From address, e.g. `kinora <no-reply@example.dev>`. |

## Social login (optional)

Leave empty to use email + password only.

| Variable | Notes |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth. |

## Single sign-on (OIDC, optional)

Use your own identity provider - Okta, Keycloak, Entra ID, Authentik, Auth0, Google Workspace, or
anything else that speaks OpenID Connect. Set the three required variables and restart; no rebuild
is needed, the server reads them at boot.

| Variable | Notes |
| --- | --- |
| `OIDC_ISSUER_URL` | Issuer URL, e.g. `https://sso.example.com/realms/acme`. Empty disables SSO. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Credentials for a **confidential** client. |
| `OIDC_PROVIDER_NAME` | Button label: "Continue with ...". Defaults to `SSO`. |
| `OIDC_SCOPES` | Defaults to `openid profile email`. The IdP must release `email`, `sub` and `name`. |
| `OIDC_DISCOVERY_URL` | Only if the document isn't at `<issuer>/.well-known/openid-configuration`. |
| `OIDC_PKCE` | Defaults to `true`. Turn off only for an IdP that can't do PKCE. |
| `KINORA_DISABLE_PASSWORD_AUTH` | `true` turns off email + password entirely (SSO-only). |

In your IdP, create a confidential client with this redirect URL:

```
${PUBLIC_URL}/api/auth/oauth2/callback/oidc
```

Worked example, Keycloak realm `acme` on `https://sso.example.com`:

```bash
OIDC_ISSUER_URL=https://sso.example.com/realms/acme
OIDC_CLIENT_ID=kinora
OIDC_CLIENT_SECRET=<from the Credentials tab>
OIDC_PROVIDER_NAME=Acme SSO
```

Users are created **just-in-time** on first sign-in, each with their own workspace. If the email
already belongs to a kinora account, the SSO identity links to that account rather than creating a
duplicate - so existing users keep their projects when you switch to SSO.

To require SSO, set `KINORA_DISABLE_PASSWORD_AUTH=true`. The server refuses to boot if no provider
is configured, so a typo can't lock everyone out; recovery is editing `.env` and restarting. Note
that invited teammates must then sign in through the IdP before accepting an invitation.

## Artifact storage (optional)

Leave the `S3_*` variables empty to store `trace.zip` on a local volume (the default). Set all
five to use an S3-compatible store instead. See [Storage & artifacts](/self-hosting/storage/).

| Variable | Notes |
| --- | --- |
| `S3_ENDPOINT` | S3-compatible endpoint URL. |
| `S3_REGION` | Region. |
| `S3_BUCKET` | Bucket name. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Credentials. |
