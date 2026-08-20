# kinora

Self-hosted kinora - a dashboard for Playwright test reports across projects and over time, with an embedded trace viewer.

kinora tracks pass rates, trends and flaky tests across projects and over time, and opens the
full Playwright trace inline for any failure. This chart runs the whole thing on your own
cluster: the API server, the dashboard, and - if you want it - the database.

![Version: 0.2.0](https://img.shields.io/badge/Version-0.2.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.2.0](https://img.shields.io/badge/AppVersion-0.2.0-informational?style=flat-square)

## TL;DR

```bash
helm install kinora oci://ghcr.io/amaingot/charts/kinora \
  --namespace kinora --create-namespace \
  --set publicUrl=https://kinora.example.com \
  --set auth.secret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)" \
  --set ingress.enabled=true --set ingress.className=nginx
```

Then `helm test kinora -n kinora --logs` to confirm the install actually works end to end -
see [Verifying an install](#verifying-an-install).

## Prerequisites

- Kubernetes 1.28+
- Helm 3.8+ (OCI registry support)
- A default StorageClass, unless you set `storage.s3` and `postgres.enabled=false`
- An ingress controller or a Gateway API implementation, and a DNS name pointing at it

## What it deploys

```
Ingress | HTTPRoute
        |
        v
  web Service :80  ->  nginx: dashboard SPA, /trace/ viewer,
        |                    and a reverse proxy for /api, /trpc, /artifacts
        v
  server Service :3000  ->  Postgres :5432   (bundled StatefulSet, or your own)
        |
        +--> artifacts: a PersistentVolume, or any S3-compatible bucket
```

**Everything arrives on one hostname, and that is not a stylistic choice.** The dashboard is
served with a `connect-src 'self'` Content-Security-Policy and its session cookie is host-only,
so the API has to answer on the same origin as the app. nginx inside the web pod does that
split. Do not try to route `/api` to the server Service directly from your Ingress - it will
fail in ways that look like application bugs.

One consequence worth knowing: the published `kinora-web` image ships the *cloud* nginx config,
which has no API proxy at all. This chart mounts the self-host config as a ConfigMap. If you
replace it via `web.nginx.existingConfigMap`, you own that contract.

## `publicUrl` is the one value you must get right

It becomes both `BASE_URL` and `WEB_ORIGIN` on the server, and it must be the URL a **browser**
uses - not a cluster-internal Service name.

- Artifact download URLs are built from it and are fetched by the trace viewer's service worker
  from the browser. Get it wrong and the dashboard loads perfectly while no trace ever opens.
- It is the only trusted origin for sign-in, so a mismatch shows up as a login that silently
  fails CSRF.

For a local trial, port-forward and set it to match:

```bash
helm install kinora oci://ghcr.io/amaingot/charts/kinora -n kinora --create-namespace \
  --set publicUrl=http://localhost:8080 \
  --set auth.secret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)"
kubectl -n kinora port-forward svc/kinora-web 8080:80
```

## Secrets

The chart **never generates a credential**. A generated default is re-rendered on every
`helm upgrade`, which would roll `AUTH_SECRET` (signing out every user) and `POSTGRES_PASSWORD`
(which `initdb` already burned into the database). So you supply them, one of four ways - in
increasing precedence:

| Tier | Knob | Use when |
| --- | --- | --- |
| 1 | inline values (`auth.secret`, `postgres.password`, ...) | trying it out, or you already keep values in a private repo |
| 2 | `secrets.existingSecret` | you pre-created one Secret whose keys are the env var names |
| 3 | `secrets.mappings` | the Secret's key names are not yours to choose (CloudNativePG, External Secrets, Sealed Secrets) |
| 4 | `server.extraEnv` | anything else |

Precedence falls out of Kubernetes itself, not from anything the chart arbitrates: every `env`
entry beats every `envFrom` source regardless of order, and among `envFrom` sources a later one
beats an earlier one. Tiers 1 and 2 are `envFrom`; tiers 3 and 4 are `env`.

`server.extraEnvFrom` is **not** the top of that ladder. It is an `envFrom` source, rendered
after the chart's own Secret and after `secrets.existingSecret`, so it overrides tiers 1 and 2 -
and nothing else. Tiers 3 and 4 still win over it, as does every variable the chart renders as a
plain `env` entry (`BASE_URL`, `POSTGRES_HOST`, `S3_BUCKET`, ...). Use `server.extraEnv` when you
need the last word.

**Tier 2** - one Secret, keys named after the environment variables:

```bash
kubectl -n kinora create secret generic kinora-credentials \
  --from-literal=AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  --from-literal=OIDC_CLIENT_SECRET=...
```
```yaml
secrets:
  existingSecret: kinora-credentials
```

Recognised keys: `AUTH_SECRET`, `POSTGRES_PASSWORD`, `GOOGLE_CLIENT_SECRET`,
`GITHUB_CLIENT_SECRET`, `OIDC_CLIENT_SECRET`, `SMTP_PASS`, `SLACK_CLIENT_SECRET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.

**Tier 3** - against a CloudNativePG cluster, whose generated Secret uses `password`:

```yaml
secrets:
  mappings:
    POSTGRES_PASSWORD:
      name: kinora-pg-app
      key: password
```

> **Rotating `POSTGRES_PASSWORD` is not a values change.** With the bundled Postgres, that value
> is read once, by `initdb`, on first start. Editing it later rewrites the Secret but not the
> database, and the migration init container then fails authentication in a way that looks like
> a broken Secret mount. Run `ALTER ROLE kinora WITH PASSWORD '...'` inside the pod first, then
> upgrade.

## Common configurations

### An external database

```yaml
postgres:
  enabled: false
  host: kinora.abc123.us-east-1.rds.amazonaws.com
  username: kinora
  database: kinora
  password: ...
  sslMode: no-verify
```

kinora has no `DATABASE_URL` and no sslmode setting of its own, but node-postgres - which both
the query layer and the migrator use - honours `PGSSLMODE`, which is what `postgres.sslMode`
sets. It does **not** read `PGSSLROOTCERT`, so `require` verifies against Node's default CA
bundle; RDS and Cloud SQL certificates are not in it, which is why `no-verify` is usually the
setting that works. For a proper verified connection, or for IAM auth, run a proxy in
`server.sidecars` and point `postgres.host` at `127.0.0.1`.

### S3 artifact storage

```yaml
storage:
  local:
    enabled: false
  s3:
    endpoint: https://s3.us-east-1.amazonaws.com
    region: us-east-1
    bucket: kinora-artifacts
    accessKeyId: ...
    secretAccessKey: ...
server:
  replicaCount: 3
```

`endpoint`, `region` and `bucket` are required together - the server refuses to boot on a partial
set, so the chart refuses to render one. **No PersistentVolumeClaim is created**: with S3
configured, nothing about artifacts touches a disk inside the cluster.

Credentials are optional. Leave both empty to use the pod's **workload identity** - the AWS SDK's
default credential chain, which covers EKS IRSA, EKS Pod Identity and instance roles:

```yaml
storage:
  local:
    enabled: false
  s3:
    endpoint: https://s3.us-east-1.amazonaws.com
    region: us-east-1
    bucket: kinora-artifacts
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/kinora
```

Set both credentials or neither; one alone is refused at install time, because the server refuses
to boot on it. `serviceAccount.automountServiceAccountToken: false` does **not** interfere - the
EKS webhook projects its own separate token volume.

The bucket needs **CORS allowing `GET` and the `Range` header** from your `publicUrl`, and must be
reachable **from your users' browsers**: artifact URLs are presigned and the trace viewer's
service worker range-fetches `trace.zip` straight from the browser, so an in-cluster-only endpoint
cannot work. The chart adds the bucket's origin to the dashboard's `connect-src` for you - which
is why `forcePathStyle` is a chart value rather than something you set on the server: flipping it
moves that origin into the hostname, and the CSP follows.

S3 is also what unlocks more than one server replica - see [Scaling](#scaling).

### SSO

```yaml
auth:
  disablePasswordAuth: true
  oidc:
    issuerUrl: https://id.example.com/realms/main
    clientId: kinora
    clientSecret: ...
    providerName: Example ID
```

Register this redirect URI with your identity provider. The final path segment is fixed and not
configurable:

```
<publicUrl>/api/auth/oauth2/callback/oidc
```

Users are provisioned on first sign-in, and an e-mail that already has an account is linked
rather than duplicated. `disablePasswordAuth: true` with no provider configured is refused at
install time, because the server would refuse to boot.

### Retention

**The defaults keep every run and every trace forever.** Traces are what fill the disk. The
gentlest useful setting drops old trace files while keeping all your history and trends - old
runs simply lose their "View trace" link:

```yaml
retention:
  artifactDays: 30
```

`runDays` and `keepLastRuns` delete whole runs, history included.

The sweep runs inside the server process, once at boot and then daily. With several replicas
they each sweep independently: harmless (every delete is idempotent) but wasteful. To sweep
immediately:

```bash
kubectl -n kinora exec deploy/kinora-server -c server -- node dist/scripts/purge-expired-runs.mjs
```

### Scaling

`server.replicaCount` must stay `1` while artifacts are on a ReadWriteOnce volume: `/artifacts`
is served off local disk by whichever replica the Service happens to pick, so a second replica
returns 404 for every trace the first one stored. The Deployment is pinned to `strategy:
Recreate` for the same reason. The chart refuses to render a configuration that would break
this. Configure `storage.s3` (or a ReadWriteMany volume) first.

The web tier is stateless and scales freely.

## Verifying an install

```bash
helm test kinora -n kinora --logs
```

This is worth running, because the chart's characteristic failure is an install that looks
completely healthy and is not: if the nginx ConfigMap never mounts, every pod is Ready, the
dashboard renders, and every API call 404s. The test drives the web Service - so the proxy
itself is under test - and checks that `/healthcheck` returns `{"status":"ok"}` (which proves
the server booted, validated its whole environment, and reached the database), that the SPA and
trace viewer are served, that tRPC answers, and that `/artifacts/` is gated by a signature
rather than open or missing. Every assertion is a read, so it is safe against production.

## Upgrading

```bash
helm upgrade kinora oci://ghcr.io/amaingot/charts/kinora -n kinora \
  --reuse-values --version <chart-version> --atomic --timeout 10m
```

Three versions are in play and they move independently:

| | What it is |
| --- | --- |
| `Chart.yaml: version` | the chart's own version - what `--version` selects |
| `Chart.yaml: appVersion` | the kinora release the chart was tested against |
| `image.tag` | what actually runs. Empty means `appVersion`; pin a `sha-<commit>` to track main |

Migrations run as an init container on every rollout, so there is no separate step. But note
that a `helm rollback` across a migration does **not** roll the schema back - restore the
database if you need to go backwards through one.

## Uninstalling

```bash
helm uninstall kinora -n kinora
```

Both volumes deliberately survive: the artifacts PVC carries `helm.sh/resource-policy: keep`
(disable with `storage.local.retainOnDelete=false`), and the Postgres PVC belongs to the
StatefulSet controller, which Helm never deletes. To actually delete the data:

```bash
kubectl -n kinora delete pvc -l app.kubernetes.io/instance=kinora
kubectl -n kinora delete pvc data-kinora-postgres-0
```

A kept PVC means a later re-install has to either delete it first or use
`helm install --take-ownership`.

## Known limitations

- **No retention CronJob.** The purge is a no-op unless the retention variables are set, and
  setting them also starts the in-process sweeper - there is no way to have one without the
  other today, so the chart does not ship a CronJob that would silently do nothing.
- **Raising `web.nginx.clientMaxBodySize` above `100m` accomplishes nothing.** The server
  hardcodes a 100 MB limit on `/api/v1/*`; a larger upload is simply rejected one layer deeper.
- **The ingest rate limiter is per-process and in-memory**, so the effective ceiling is
  `server.replicaCount` x `ingestRateLimit`, and it keys on the leftmost `X-Forwarded-For` hop.
- **The bundled Postgres has no HA, no backups and no pooler.** It is a convenience, not a
  production database.
- **`KINORA_CLOUD` is pinned false.** The `POLAR_*` billing and feedback-tracker variables are
  intentionally unreachable; self-host has every feature unlimited anyway.
- **No NetworkPolicy templates** yet.

## Configuration

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| auth.cookieDomain | string | `""` | Share the session cookie across subdomains, e.g. `.example.com`. Leave EMPTY for the normal single-origin install - the cookie is then host-only, which is what you want. |
| auth.disablePasswordAuth | bool | `false` | SSO-only install: turn e-mail + password sign-in and sign-up off entirely. The server refuses to boot if this is true with no provider configured, so a typo cannot lock everyone out; the chart pre-checks the same rule at render time. |
| auth.github.clientId | string | `""` | GitHub OAuth client id. Both id and secret, or neither. |
| auth.github.clientSecret | string | `""` | GitHub OAuth client secret. |
| auth.google.clientId | string | `""` | Google OAuth client id. Both id and secret, or neither. |
| auth.google.clientSecret | string | `""` | Google OAuth client secret. |
| auth.oidc.clientId | string | `""` | OIDC client id. |
| auth.oidc.clientSecret | string | `""` | OIDC client secret. See `secrets.*` for the alternatives. |
| auth.oidc.discoveryUrl | string | `""` | Only needed when the document is not at `<issuerUrl>/.well-known/openid-configuration`. better-auth fetches this verbatim, so it must be the full document URL. |
| auth.oidc.issuerUrl | string | `""` | Generic OpenID Connect SSO: Okta, Keycloak, Entra ID, Authentik, Auth0, Google Workspace. Active once issuerUrl + clientId + clientSecret are all set. Register this redirect URI with your IdP: `<publicUrl>/api/auth/oauth2/callback/oidc` (the `oidc` segment is fixed and not configurable). Users are provisioned just-in-time, and an e-mail that already has an account is linked rather than duplicated. |
| auth.oidc.pkce | bool | `true` | Turn off only for an IdP that cannot do PKCE. |
| auth.oidc.providerName | string | `"SSO"` | Sign-in button label: "Continue with <name>". |
| auth.oidc.scopes | string | `"openid profile email"` | Space- or comma-separated. The callback rejects a sign-in missing `email`, `sub` or `name`, so do not narrow these without reason. |
| auth.secret | string | `""` | Session secret **and** the HMAC key that signs local-filesystem artifact URLs. Generate with `openssl rand -hex 32`. Required unless supplied via `secrets.*`. Rotating it signs everyone out and invalidates outstanding artifact links (1h TTL, so that half is harmless). |
| commonAnnotations | object | `{}` | Added to every object the chart creates. |
| commonLabels | object | `{}` | Added to every object the chart creates. |
| demo | bool | `false` | Public read-only demo mode: auto-session as a seeded demo user, all mutations and ingest rejected. You almost certainly want `false`. |
| fullnameOverride | string | `""` |  |
| httpRoute.annotations | object | `{}` |  |
| httpRoute.enabled | bool | `false` | Gateway API alternative to `ingress`. Requires the Gateway API CRDs. |
| httpRoute.extraRules | list | `[]` | Extra rules appended after the generated catch-all. Useful for splitting an auth policy across browser paths and the token-authenticated `/api/v1` ingest path. |
| httpRoute.hostnames | list | `[]` | Defaults to the host part of `publicUrl`. |
| httpRoute.parentRefs | list | `[]` | The Gateways to attach to. Required when enabled. |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.tag | string | `""` | Tag for BOTH the server and web images. Empty uses the chart's `appVersion`, which is the kinora release this chart version was tested against. Pin to a `sha-<commit>` to track main. |
| imagePullSecrets | list | `[]` | Applies to every pod in the release. |
| ingestRateLimit | int | `600` | Ingest requests per minute per client IP - a DoS backstop, not a quota. Two caveats: the counter is in-memory and per-process, so the real ceiling is `server.replicaCount` x this number; and it keys on the leftmost `X-Forwarded-For` hop, so a load balancer that does not set XFF collapses every client into one bucket. |
| ingress.annotations | object | `{}` | `nginx.ingress.kubernetes.io/proxy-body-size` and `proxy-read-timeout` are added automatically, derived from `web.nginx.*` so the two layers cannot disagree. Anything you set here wins. Add your cert-manager issuer here. |
| ingress.className | string | `""` |  |
| ingress.enabled | bool | `false` |  |
| ingress.extraHosts | list | `[]` | Additional `{host, path, pathType}` entries. `publicUrl` still governs the URLs the app generates. |
| ingress.host | string | `""` | Hostname. Defaults to the host part of `publicUrl`. |
| ingress.path | string | `"/"` |  |
| ingress.pathType | string | `"Prefix"` |  |
| ingress.tls.enabled | bool | `false` |  |
| ingress.tls.hosts | list | `[]` | Empty uses `ingress.host` plus every `extraHosts` entry. |
| ingress.tls.secretName | string | `""` | Empty auto-names it `<fullname>-tls`, which is what cert-manager will fill. |
| nameOverride | string | `""` |  |
| postgres.affinity | object | `{}` |  |
| postgres.dataDir | string | `"/var/lib/postgresql/18/docker"` | PGDATA, used by the fast-shutdown preStop hook. Postgres 18 moved this to `/var/lib/postgresql/<major>/docker`; the volume mounts one level up at `/var/lib/postgresql`. Bump it together with `image.tag` when you move major versions - it is a value precisely so that change is visible in review. |
| postgres.database | string | `"kinora"` | Database name. Created for you by the bundled Postgres; must already exist for an external one. |
| postgres.enabled | bool | `true` | Deploy the bundled single-replica Postgres StatefulSet. Fine for a team instance; set `false` and point `host` at a managed database (RDS, Cloud SQL, CloudNativePG) for anything you care about - the bundled one has no HA, no backups and no connection pooler. |
| postgres.extraArgs | list | `[]` | Extra arguments for the `postgres` process, e.g. `["-c", "max_connections=200"]`. |
| postgres.host | string | `""` | Database host. Ignored when `postgres.enabled` is true (the chart's own Service is used); required when it is false. |
| postgres.image.pullPolicy | string | `""` | Defaults to `image.pullPolicy`. |
| postgres.image.repository | string | `"postgres"` | Only used when `postgres.enabled` is true. |
| postgres.image.tag | string | `"18.1"` | Postgres 18 or newer. Changing the major version means changing `dataDir` too. |
| postgres.nodeSelector | object | `{}` |  |
| postgres.password | string | `""` | Database password. See `secrets.*` for the alternatives. With the bundled Postgres this is read only by `initdb`, on first start - changing it later rewrites the Secret but not the database. Rotate with `ALTER ROLE` first, then upgrade. |
| postgres.persistence.accessModes[0] | string | `"ReadWriteOnce"` |  |
| postgres.persistence.annotations | object | `{}` |  |
| postgres.persistence.enabled | bool | `true` | Turn off only for throwaway test installs; data is then lost on every pod restart. |
| postgres.persistence.size | string | `"20Gi"` | A StatefulSet volumeClaimTemplate is IMMUTABLE after first install. Changing this (or storageClass) later makes every subsequent `helm upgrade` fail; see the README. |
| postgres.persistence.storageClass | string | `""` | Empty uses the cluster default StorageClass. |
| postgres.podAnnotations | object | `{}` |  |
| postgres.podLabels | object | `{}` |  |
| postgres.podSecurityContext | object | `{}` | Deliberately empty: the official postgres image starts as root, chowns PGDATA, then drops to uid 999 itself. Setting `fsGroup` fights that chown on large volumes and `runAsNonRoot` breaks the entrypoint outright. This is the opposite of the server pod. |
| postgres.port | int | `5432` | Database port. |
| postgres.priorityClassName | string | `""` |  |
| postgres.resources.limits.memory | string | `"1Gi"` |  |
| postgres.resources.requests.cpu | string | `"100m"` |  |
| postgres.resources.requests.memory | string | `"256Mi"` |  |
| postgres.securityContext | object | `{}` |  |
| postgres.sslMode | string | `""` | TLS mode for an external database, passed through as `PGSSLMODE`. One of `disable`, `prefer`, `require`, `verify-ca`, `verify-full` or `no-verify`. kinora has no sslmode setting of its own, but node-postgres (used by both the query layer and the migrator) applies this env var because the connection config omits `ssl`. It does NOT read `PGSSLROOTCERT`, so `require` verifies against Node's default CA bundle - RDS and Cloud SQL, whose CAs are not in that bundle, generally need `no-verify`. |
| postgres.terminationGracePeriodSeconds | int | `120` | Postgres reads SIGTERM as a *smart* shutdown that waits for clients, so the chart also runs a `pg_ctl -m fast` preStop hook. This grace period covers that. |
| postgres.tolerations | list | `[]` |  |
| postgres.topologySpreadConstraints | list | `[]` |  |
| postgres.username | string | `"kinora"` | Database user. |
| publicUrl | string | `""` | The URL your users reach kinora at, scheme included, no trailing slash and no path. The single most important value. It becomes BOTH `BASE_URL` and `WEB_ORIGIN` on the server, because the web pod reverse-proxies /api, /trpc and /artifacts on its own origin - there is one origin, so there is no CORS and the session cookie stays host-only. It drives OAuth/OIDC callback URLs, e-mail links, and the absolute artifact URLs the trace viewer's service worker fetches **from the browser**. A cluster-internal URL renders the dashboard fine and then fails to load a single trace. |
| retention.artifactDays | int | `0` | Delete stored trace.zip files older than N days but KEEP the runs, so pass rates, trends and flaky history all survive - old runs just lose their "View trace" link. This is the knob to reach for first. 0 = never. |
| retention.keepLastRuns | int | `0` | Keep only the N newest runs per project, history included. 0 = unlimited. |
| retention.runDays | int | `0` | Delete whole runs older than N days, history included. 0 = never. |
| secrets.existingSecret | string | `""` | Name of a Secret you created yourself whose **keys are the literal environment variable names**: AUTH_SECRET, POSTGRES_PASSWORD, OIDC_CLIENT_SECRET, GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_SECRET, SLACK_CLIENT_SECRET, SMTP_PASS, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY. Mounted with `envFrom`, so any key present here overrides the matching inline value. One Secret covers every credential. Being an `envFrom` source it cannot override a variable the chart renders as a plain `env` entry, nor `secrets.mappings`. |
| secrets.mappings | object | `{}` | For Secrets whose key names you do not control - CloudNativePG's `password`, External Secrets, Sealed Secrets. Maps an environment variable to a specific Secret key, rendered as `env[].valueFrom.secretKeyRef`, which outranks the inline values, `existingSecret` and `server.extraEnvFrom` - an `env` entry beats every `envFrom` source. |
| sentryDsn | string | `""` | Sentry DSN for server-side error reporting. Empty disables it. |
| server.affinity | object | `{}` |  |
| server.args | list | `[]` |  |
| server.autoscaling.enabled | bool | `false` | Requires `storage.s3`. See `server.replicaCount`. |
| server.autoscaling.maxReplicas | int | `6` |  |
| server.autoscaling.minReplicas | int | `2` |  |
| server.autoscaling.targetCPUUtilizationPercentage | int | `75` |  |
| server.autoscaling.targetMemoryUtilizationPercentage | string | `nil` |  |
| server.command | list | `[]` | Override the container entrypoint. Empty uses the image default. |
| server.containerPort | int | `3000` | Wired to both `PORT` and the Service `targetPort`, so the two cannot drift. |
| server.extraEnv | list | `[]` | Raw `core/v1` EnvVar list, appended last so it overrides every other layer: it is the final `env` entry, and an `env` entry beats every `envFrom` source. `valueFrom` reaches any Secret or ConfigMap key, or the downward API. Use it for anything the chart does not model. |
| server.extraEnvFrom | list | `[]` | Raw `core/v1` EnvFromSource list - whole ConfigMaps or Secrets. Rendered as the last `envFrom` source, so it beats the chart's own Secret and `secrets.existingSecret` and nothing else: it cannot override `secrets.mappings`, `server.extraEnv`, or any variable the chart renders as a plain `env` entry. Use `server.extraEnv` to override those. |
| server.extraVolumeMounts | list | `[]` |  |
| server.extraVolumes | list | `[]` |  |
| server.image.repository | string | `"ghcr.io/amaingot/kinora-server"` | Change for a private mirror. |
| server.image.tag | string | `""` | Defaults to `image.tag`, then the chart's `appVersion`. |
| server.initContainers | list | `[]` | Extra init containers, run before the migration container. |
| server.livenessProbe.enabled | bool | `true` | A TCP check, NOT `/healthcheck`. That endpoint depends on the database, so an httpGet liveness probe would turn a 30-second Postgres blip into a server restart loop for a fault a restart cannot fix. Readiness already handles pulling the pod out of the Service. |
| server.livenessProbe.failureThreshold | int | `6` |  |
| server.livenessProbe.initialDelaySeconds | int | `30` |  |
| server.livenessProbe.periodSeconds | int | `20` |  |
| server.livenessProbe.timeoutSeconds | int | `3` |  |
| server.migrations.attempts | int | `30` | Bounded retry loop inside the container. This is deliberately not the pod's restart backoff (0/10/30/70/150/310s), which can blow a `helm install --atomic --timeout` window while Postgres is still coming up on a cold install. |
| server.migrations.enabled | bool | `true` | Run `node dist/scripts/migrate.mjs latest` as an initContainer before the server starts. Turn off only if you apply migrations out of band. |
| server.migrations.resources | object | `{}` | Defaults to `server.resources`. |
| server.migrations.retryDelaySeconds | int | `10` |  |
| server.nodeSelector | object | `{}` |  |
| server.pdb.enabled | bool | `false` | Pointless at one replica; useful once you are on S3 and scaled out. |
| server.pdb.maxUnavailable | string | `nil` |  |
| server.pdb.minAvailable | int | `1` |  |
| server.podAnnotations | object | `{}` |  |
| server.podLabels | object | `{}` |  |
| server.podSecurityContext.fsGroup | int | `1001` | The server image runs as uid 1001 and writes artifacts to the mounted volume; a freshly provisioned PV arrives root-owned, and fsGroup is what makes it writable. `OnRootMismatch` skips the recursive re-chown on every restart once the top-level directory already matches - which matters a lot on a volume full of traces. |
| server.podSecurityContext.fsGroupChangePolicy | string | `"OnRootMismatch"` |  |
| server.priorityClassName | string | `""` |  |
| server.readinessProbe.enabled | bool | `true` | `GET /healthcheck`, which round-trips Postgres and answers 503 when it is unreachable. Exactly right for readiness: a database outage takes the pod out of the Service. |
| server.readinessProbe.failureThreshold | int | `3` |  |
| server.readinessProbe.initialDelaySeconds | int | `5` |  |
| server.readinessProbe.periodSeconds | int | `10` |  |
| server.readinessProbe.timeoutSeconds | int | `3` |  |
| server.replicaCount | int | `1` | Must stay 1 while artifacts are on a ReadWriteOnce volume - /artifacts is served from local disk by whichever replica the Service picks. Configure `storage.s3`, or a ReadWriteMany volume, before raising this; the chart refuses to render otherwise. |
| server.resources.limits.memory | string | `"2Gi"` |  |
| server.resources.requests.cpu | string | `"200m"` |  |
| server.resources.requests.memory | string | `"512Mi"` |  |
| server.securityContext.allowPrivilegeEscalation | bool | `false` |  |
| server.securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| server.securityContext.readOnlyRootFilesystem | bool | `false` | Left false: `--enable-source-maps` and the S3 SDK both touch temporary paths. |
| server.securityContext.runAsGroup | int | `1001` |  |
| server.securityContext.runAsNonRoot | bool | `true` |  |
| server.securityContext.runAsUser | int | `1001` |  |
| server.securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| server.service.annotations | object | `{}` |  |
| server.service.nodePort | string | `nil` |  |
| server.service.port | int | `3000` | Also the port the web pod's nginx proxies to. |
| server.service.type | string | `"ClusterIP"` |  |
| server.sidecars | list | `[]` | Extra containers in the server pod. The intended use is a database proxy on 127.0.0.1 (cloud-sql-proxy, pgbouncer, stunnel) for a managed database that needs more than `postgres.sslMode` can express. |
| server.startupProbe.enabled | bool | `false` |  |
| server.startupProbe.failureThreshold | int | `30` |  |
| server.startupProbe.periodSeconds | int | `5` |  |
| server.terminationGracePeriodSeconds | int | `30` | The server closes its HTTP listener and drains the pg pool on SIGTERM, hard-exiting after 10s. |
| server.tolerations | list | `[]` |  |
| server.topologySpreadConstraints | list | `[]` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automountServiceAccountToken | bool | `false` | kinora never talks to the Kubernetes API. Leave this off - it suppresses only the default kube-api-access volume, and does NOT interfere with workload identity: the EKS pod identity webhook projects its own separate token volume when it sees an IRSA annotation here. |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| slack.clientId | string | `""` | The "Add to Slack" OAuth app. Without it, Slack alerts fall back to a manually pasted incoming-webhook URL, which works perfectly well. |
| slack.clientSecret | string | `""` |  |
| smtp.from | string | `""` | e.g. `kinora <no-reply@example.com>` |
| smtp.host | string | `""` | host, port and from are required together; user/password stay optional for unauthenticated relays. Leave `host` empty to disable every e-mail flow. |
| smtp.password | string | `""` |  |
| smtp.port | int | `587` |  |
| smtp.user | string | `""` |  |
| storage.local.accessModes | list | `["ReadWriteOnce"]` | ReadWriteOnce pins the server to a single replica: /artifacts is served off local disk by whichever replica the Service picks. Use ReadWriteMany, or S3, to scale out. |
| storage.local.annotations | object | `{}` |  |
| storage.local.enabled | bool | `true` | Store artifacts on a PersistentVolume. Ignored when `storage.s3` is fully configured. |
| storage.local.existingClaim | string | `""` | Use a PVC you created yourself instead of letting the chart create one. |
| storage.local.path | string | `"/app/.data/artifacts"` | Mount path and `STORAGE_DIR`, kept as one value so they cannot drift. The server image runs as uid 1001, which is what `server.podSecurityContext.fsGroup` arranges for. |
| storage.local.retainOnDelete | bool | `true` | Add `helm.sh/resource-policy: keep` so `helm uninstall` does not delete your traces. The trade-off: a later re-install must either delete the PVC first or use `helm install --take-ownership`. |
| storage.local.size | string | `"50Gi"` |  |
| storage.local.storageClass | string | `""` | Empty uses the cluster default StorageClass. |
| storage.s3.accessKeyId | string | `""` | Static credentials. OPTIONAL, and set both or neither: leaving both empty uses the AWS SDK's default credential chain, which is how EKS IRSA, EKS Pod Identity and instance roles work - annotate `serviceAccount.annotations` instead of storing a key. May also come from `secrets.*` rather than inline. |
| storage.s3.bucket | string | `""` |  |
| storage.s3.endpoint | string | `""` | Any S3-compatible store instead of a PersistentVolume: AWS S3, Cloudflare R2, MinIO, Hetzner. No PersistentVolumeClaim is created at all when this is set, and it is what unlocks more than one server replica. `endpoint`, `region` and `bucket` are required TOGETHER - the server refuses to boot on a partial set, and the chart refuses to render one. The bucket needs CORS allowing `GET` and the `Range` header from `publicUrl`, and must be reachable from your users browsers: the trace viewer's service worker range-fetches trace.zip straight from the browser, not through the server. |
| storage.s3.forcePathStyle | bool | `true` | Path-style URLs (`host/bucket/key`), which most S3-compatible providers (MinIO, Hetzner) require. Set false for the virtual-hosted style (`bucket.host/key`) that AWS prefers. This moves the origin of presigned artifact URLs, and the chart adjusts the dashboard's CSP `connect-src` to match. |
| storage.s3.region | string | `""` |  |
| storage.s3.secretAccessKey | string | `""` |  |
| tests.enabled | bool | `true` | Ship the `helm test` hook. Costs nothing unless you run `helm test`, and it is the only check that catches an install which is green but has no working API proxy. |
| tests.image.pullPolicy | string | `""` |  |
| tests.image.repository | string | `"curlimages/curl"` |  |
| tests.image.tag | string | `"8.11.1"` |  |
| tests.resources.limits.memory | string | `"64Mi"` |  |
| tests.resources.requests.cpu | string | `"10m"` |  |
| tests.resources.requests.memory | string | `"32Mi"` |  |
| web.affinity | object | `{}` |  |
| web.autoscaling.enabled | bool | `false` |  |
| web.autoscaling.maxReplicas | int | `6` |  |
| web.autoscaling.minReplicas | int | `2` |  |
| web.autoscaling.targetCPUUtilizationPercentage | int | `75` |  |
| web.autoscaling.targetMemoryUtilizationPercentage | string | `nil` |  |
| web.containerPort | int | `8080` | Above 1024 so the container can run unprivileged. The chart templates nginx's `listen` directive from this value. |
| web.extraEnv | list | `[]` |  |
| web.extraEnvFrom | list | `[]` |  |
| web.extraVolumeMounts | list | `[]` |  |
| web.extraVolumes | list | `[]` |  |
| web.image.repository | string | `"ghcr.io/amaingot/kinora-web"` |  |
| web.image.tag | string | `""` | Defaults to `image.tag`, then the chart's `appVersion`. |
| web.initContainers | list | `[]` |  |
| web.livenessProbe.enabled | bool | `true` |  |
| web.livenessProbe.failureThreshold | int | `3` |  |
| web.livenessProbe.initialDelaySeconds | int | `10` |  |
| web.livenessProbe.periodSeconds | int | `20` |  |
| web.livenessProbe.timeoutSeconds | int | `3` |  |
| web.nginx.clientMaxBodySize | string | `"100m"` | Largest trace.zip an ingest request may carry. Raising this above 100m accomplishes nothing: the server hardcodes a 100 MB body limit on `/api/v1/*`, so a bigger upload is rejected one layer further in. The Ingress body-size annotation is derived from this same value so the two cannot drift. |
| web.nginx.contentSecurityPolicy | string | `""` | Replace the generated Content-Security-Policy for the dashboard entirely. Empty generates one, which already appends the S3 endpoint origin to `connect-src` when `storage.s3` is configured. |
| web.nginx.existingConfigMap | string | `""` | Replace the whole generated config with a ConfigMap of your own, whose `default.conf` key is mounted at /etc/nginx/conf.d/default.conf. You are then responsible for proxying /api/, /trpc/, /artifacts/ and /healthcheck to the server Service, and for serving /trace/ and the SPA fallback. Read `charts/kinora/files/nginx.conf.tpl` first. |
| web.nginx.extraConnectSrc | list | `[]` | Extra origins appended to the generated `connect-src`. |
| web.nginx.extraServerConfig | string | `""` | Extra directives injected verbatim into the nginx `server {}` block - `real_ip` configuration, `limit_req` zones, additional locations. Rendered through `tpl`. |
| web.nginx.proxyReadTimeout | string | `"300s"` | Applied to `/artifacts/`. A large trace streaming to a slow client easily exceeds nginx's 60s default between reads. |
| web.nodeSelector | object | `{}` |  |
| web.pdb.enabled | bool | `false` |  |
| web.pdb.maxUnavailable | string | `nil` |  |
| web.pdb.minAvailable | int | `1` |  |
| web.podAnnotations | object | `{}` |  |
| web.podLabels | object | `{}` |  |
| web.podSecurityContext.fsGroup | int | `101` |  |
| web.priorityClassName | string | `""` |  |
| web.readinessProbe.enabled | bool | `true` | `GET /` - served from nginx's own disk. Never the proxied `/healthcheck`: that would take the static frontend down during a database outage, so users would get a connection error instead of the app's own error state. |
| web.readinessProbe.failureThreshold | int | `3` |  |
| web.readinessProbe.initialDelaySeconds | int | `2` |  |
| web.readinessProbe.periodSeconds | int | `10` |  |
| web.readinessProbe.timeoutSeconds | int | `3` |  |
| web.replicaCount | int | `2` | Stateless; scale freely. Two replicas keep the front door up during node rotation even though the server is pinned to one on the default storage path. |
| web.resources.limits.memory | string | `"256Mi"` |  |
| web.resources.requests.cpu | string | `"50m"` |  |
| web.resources.requests.memory | string | `"64Mi"` |  |
| web.securityContext.allowPrivilegeEscalation | bool | `false` |  |
| web.securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| web.securityContext.readOnlyRootFilesystem | bool | `true` |  |
| web.securityContext.runAsGroup | int | `101` |  |
| web.securityContext.runAsNonRoot | bool | `true` | The chart runs nginx unprivileged: `containerPort` is above 1024, and emptyDir volumes cover the paths the master process needs to write (`/var/cache/nginx`, `/tmp`), with the pid file relocated. uid 101 is `nginx` in the upstream image. |
| web.securityContext.runAsUser | int | `101` |  |
| web.securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| web.service.annotations | object | `{}` |  |
| web.service.nodePort | string | `nil` |  |
| web.service.port | int | `80` | The single public entrypoint. Ingress and HTTPRoute both target this. |
| web.service.type | string | `"ClusterIP"` |  |
| web.sidecars | list | `[]` |  |
| web.terminationGracePeriodSeconds | int | `30` |  |
| web.tolerations | list | `[]` |  |
| web.topologySpreadConstraints | list | `[]` |  |

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| amaingot |  | <https://github.com/amaingot> |

## Source Code

* <https://github.com/amaingot/kinora>
