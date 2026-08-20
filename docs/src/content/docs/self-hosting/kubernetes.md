---
title: Kubernetes (Helm)
description: Run kinora on your own cluster with the official Helm chart - server, dashboard, and optionally Postgres.
---

The Helm chart runs the same stack as the Docker Compose bundle - the server, the dashboard, and
optionally Postgres - on your own cluster. It is published to GitHub Container Registry as an OCI
artifact, and every self-host setting is a chart value.

## Quickstart

```bash
helm install kinora oci://ghcr.io/amaingot/charts/kinora \
  --namespace kinora --create-namespace \
  --set publicUrl=https://kinora.example.com \
  --set auth.secret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)" \
  --set ingress.enabled=true --set ingress.className=nginx
```

Then confirm it actually works:

```bash
helm test kinora -n kinora --logs
```

Open `publicUrl` and create your account. The first user owns their workspace; invite teammates
from Settings.

## What the chart deploys

- **web** - nginx serving the dashboard and the embedded trace viewer, and reverse-proxying
  `/api`, `/trpc` and `/artifacts` to the server. This is the only thing your Ingress points at.
- **server** - the API, with a migration init container that runs before it starts.
- **postgres** - a single-replica StatefulSet, on by default. Turn it off with
  `postgres.enabled=false` and point `postgres.host` at a managed database.
- **artifacts** - a PersistentVolumeClaim by default, or any S3-compatible bucket.

Everything is **one origin**, exactly as in the Compose bundle: the dashboard's
Content-Security-Policy is `connect-src 'self'` and its session cookie is host-only, so the API
has to answer on the same hostname as the app. Do not route `/api` from your Ingress straight to
the server Service - nginx inside the web pod does that split.

## The one value you must get right

`publicUrl` becomes both `BASE_URL` and `WEB_ORIGIN`, and it must be the URL a **browser** uses.
Trace artifacts are fetched by the viewer's service worker from the browser, so a
cluster-internal URL gives you a dashboard that loads perfectly and never opens a trace.

Trying it locally? Match the two:

```bash
helm install kinora oci://ghcr.io/amaingot/charts/kinora -n kinora --create-namespace \
  --set publicUrl=http://localhost:8080 \
  --set auth.secret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)"

kubectl -n kinora port-forward svc/kinora-web 8080:80
```

## Secrets

The chart never generates a credential - a generated default would be re-rendered on every
`helm upgrade`, signing out every user and breaking the database password. Supply them inline,
or keep them outside Helm entirely:

```yaml
secrets:
  # One Secret whose keys are the environment variable names: AUTH_SECRET,
  # POSTGRES_PASSWORD, OIDC_CLIENT_SECRET, SMTP_PASS, S3_ACCESS_KEY_ID, ...
  existingSecret: kinora-credentials

  # Or, for Secrets whose key names you do not control:
  mappings:
    POSTGRES_PASSWORD:
      name: kinora-pg-app
      key: password
```

The [chart README](https://github.com/amaingot/kinora/tree/main/charts/kinora) has the full table
and a worked example for each tier.

## Exposure

Pick one:

```yaml
# A standard Ingress. The chart derives the hostname from publicUrl, and sets the
# proxy body-size annotation from the same value nginx uses, so the two cannot disagree.
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  tls:
    enabled: true
```

```yaml
# Or Gateway API.
httpRoute:
  enabled: true
  parentRefs:
    - name: public-gateway
      namespace: gateway-system
```

Leave both off to bring your own load balancer, and point it at the `kinora-web` Service.

## Before you call it production

- **Use a real database.** The bundled Postgres has no HA, no backups and no connection pooler.
  Set `postgres.enabled=false` and point at RDS, Cloud SQL, or CloudNativePG. kinora has no
  sslmode setting of its own, but `postgres.sslMode` passes `PGSSLMODE` through to the driver -
  usually `no-verify` for managed providers, whose CAs are not in Node's default bundle.
- **Set retention.** The defaults keep every run and every trace forever. `retention.artifactDays: 30`
  drops old trace files while keeping all your history and trends.
- **Consider S3.** It is also what lets you run more than one server replica - with artifacts on
  a ReadWriteOnce volume the chart pins the server to one, because `/artifacts` is served from
  whichever replica the Service picks.
- **Check the trace viewer, not just the dashboard.** `helm test` does this for you.

See [Storage & artifacts](/self-hosting/storage/) for the S3 bucket CORS requirement.

## Upgrading

```bash
helm upgrade kinora oci://ghcr.io/amaingot/charts/kinora -n kinora \
  --reuse-values --version <chart-version> --atomic --timeout 10m
```

Migrations run as an init container on every rollout, so there is no separate step. Note that a
`helm rollback` across a migration does not roll the schema back.

`image.tag` is what actually runs; leave it empty to get the chart's `appVersion`, or pin a
`sha-<commit>` to track `main`.

## Uninstalling

Both volumes survive on purpose. To actually delete the data:

```bash
helm uninstall kinora -n kinora
kubectl -n kinora delete pvc -l app.kubernetes.io/instance=kinora
kubectl -n kinora delete pvc data-kinora-postgres-0
```

## Next

- [Chart README](https://github.com/amaingot/kinora/tree/main/charts/kinora): every value, with defaults.
- [Environment variables](/reference/environment/): what each value maps to on the server.
- [Storage & artifacts](/self-hosting/storage/): PersistentVolume vs S3-compatible store.
