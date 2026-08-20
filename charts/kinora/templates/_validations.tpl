{{- /*
Every check here mirrors a rule the server enforces at boot (zod parses process.env at import
time and crashes the process) or a topology invariant that fails silently rather than loudly.
Failing at `helm install` turns a CrashLoopBackOff - or worse, a green install that quietly
serves 404s - into a message that says what to do.

Each guard consults all four credential tiers before failing, so users who keep secrets outside
Helm (secrets.existingSecret / secrets.mappings / extraEnvFrom) are never blocked by a check
that cannot see inside their Secret.
*/}}
{{- define "kinora.validateValues" -}}

{{- if not .Values.publicUrl }}
{{- fail "\nkinora: publicUrl is required.\n\nIt becomes both BASE_URL and WEB_ORIGIN on the server, which drive auth callbacks, e-mail\nlinks, and the HMAC-signed artifact URLs the trace viewer fetches from the browser.\n\n  --set publicUrl=https://kinora.example.com\n" }}
{{- end }}
{{- if not (regexMatch "^https?://[^/]+$" (include "kinora.publicUrl" .)) }}
{{- fail (printf "\nkinora: publicUrl must be an absolute origin with no path (got %q).\n\nThe server validates BASE_URL with zod .url() and refuses to boot otherwise.\nExample: https://kinora.example.com\n" .Values.publicUrl) }}
{{- end }}

{{- if not (include "kinora.hasSecret" (dict "ctx" . "key" "AUTH_SECRET" "inline" .Values.auth.secret)) }}
{{- fail "\nkinora: no source for AUTH_SECRET.\n\nIt signs sessions and the artifact download URLs. The chart deliberately does NOT generate\none: a generated default would be re-rolled on every `helm upgrade`, signing out every user.\n\nGenerate one and pass it:\n\n  --set auth.secret=\"$(openssl rand -hex 32)\"\n\nor keep it outside Helm with secrets.existingSecret / secrets.mappings.AUTH_SECRET.\n" }}
{{- end }}

{{- if not .Values.postgres.enabled }}
{{- if not .Values.postgres.host }}
{{- fail "\nkinora: postgres.enabled=false requires postgres.host.\n\nThere is no DATABASE_URL - the server reads five discrete POSTGRES_* variables. Set\npostgres.host / .port / .username / .database, and the password via postgres.password or\nsecrets.existingSecret. For a managed database that requires TLS, set postgres.sslMode\n(`no-verify` for RDS / Cloud SQL, whose CAs are not in Node's default bundle).\n" }}
{{- end }}
{{- end }}
{{- if .Values.postgres.enabled }}
{{- if not (or .Values.postgres.password .Values.secrets.existingSecret (hasKey .Values.secrets.mappings "POSTGRES_PASSWORD")) }}
{{- fail "\nkinora: the bundled Postgres needs a resolvable POSTGRES_PASSWORD.\n\nIt is initialised from a secretKeyRef, so server.extraEnvFrom alone is not enough - the\ndatabase container cannot read the server's environment. Use postgres.password,\nsecrets.existingSecret, or secrets.mappings.POSTGRES_PASSWORD.\n" }}
{{- end }}
{{- end }}
{{- if not (include "kinora.hasSecret" (dict "ctx" . "key" "POSTGRES_PASSWORD" "inline" .Values.postgres.password)) }}
{{- fail "\nkinora: no source for POSTGRES_PASSWORD.\n\nSet postgres.password, or supply it via secrets.existingSecret / secrets.mappings.\nNote: with the bundled Postgres this value is only read by initdb, on first start. Changing\nit later rewrites the Secret but not the database - rotate with ALTER ROLE first.\n" }}
{{- end }}

{{- /* resolveS3() returns null unless all five are set, silently falling back to local disk. A
     half-configured bucket is therefore invisible until someone looks for a trace. */}}
{{- $s3 := .Values.storage.s3 }}
{{- $s3any := or $s3.endpoint $s3.region $s3.bucket $s3.accessKeyId $s3.secretAccessKey }}
{{- if and $s3any (not (include "kinora.s3.enabled" .)) }}
{{- $missing := list }}
{{- if not $s3.endpoint }}{{- $missing = append $missing "storage.s3.endpoint" }}{{- end }}
{{- if not $s3.region }}{{- $missing = append $missing "storage.s3.region" }}{{- end }}
{{- if not $s3.bucket }}{{- $missing = append $missing "storage.s3.bucket" }}{{- end }}
{{- fail (printf "\nkinora: S3 storage is partially configured - missing %s.\n\nThe server needs all of endpoint, region, bucket and both credentials; with any one missing\nit silently falls back to local disk, so artifacts would land somewhere you did not\nprovision. Set them all, or none.\n" (join ", " $missing)) }}
{{- end }}
{{- if include "kinora.s3.enabled" . }}
{{- if not (include "kinora.hasSecret" (dict "ctx" . "key" "S3_ACCESS_KEY_ID" "inline" $s3.accessKeyId)) }}
{{- fail "\nkinora: storage.s3 is configured but there is no source for S3_ACCESS_KEY_ID.\n\nSet storage.s3.accessKeyId, or supply it via secrets.existingSecret / secrets.mappings.\n" }}
{{- end }}
{{- if not (include "kinora.hasSecret" (dict "ctx" . "key" "S3_SECRET_ACCESS_KEY" "inline" $s3.secretAccessKey)) }}
{{- fail "\nkinora: storage.s3 is configured but there is no source for S3_SECRET_ACCESS_KEY.\n\nSet storage.s3.secretAccessKey, or supply it via secrets.existingSecret / secrets.mappings.\n" }}
{{- end }}
{{- end }}

{{- if and (not (include "kinora.s3.enabled" .)) (not .Values.storage.local.enabled) }}
{{- fail "\nkinora: no artifact storage configured.\n\nEither leave storage.local.enabled=true (a PersistentVolume) or configure all five\nstorage.s3.* values. With neither, traces are written to the container filesystem and lost\non every restart.\n" }}
{{- end }}

{{- /* /artifacts is served from local disk by whichever replica the Service picks, so a second
     replica with an RWO volume serves 404s for anything the first one stored. */}}
{{- $wantsMulti := or (gt (int .Values.server.replicaCount) 1) .Values.server.autoscaling.enabled }}
{{- if and $wantsMulti (include "kinora.localStorage.enabled" .) }}
{{- if not (has "ReadWriteMany" .Values.storage.local.accessModes) }}
{{- fail "\nkinora: more than one server replica needs shared artifact storage.\n\nArtifacts are served off local disk by whichever replica the Service picks, so with a\nReadWriteOnce volume a second replica returns 404 for every trace the first one stored.\n(The Deployment is also pinned to strategy: Recreate for the same reason.)\n\nEither configure storage.s3, or set storage.local.accessModes to include ReadWriteMany.\n" }}
{{- end }}
{{- end }}

{{- /* Mirrors the zod refine in packages/server/src/lib/env.ts - disabling password auth with no
     external provider would lock every user out, so the server refuses to boot. */}}
{{- if .Values.auth.disablePasswordAuth }}
{{- $hasProvider := or .Values.auth.oidc.issuerUrl .Values.auth.google.clientId .Values.auth.github.clientId }}
{{- if and (not $hasProvider) (not .Values.secrets.existingSecret) (not .Values.server.extraEnvFrom) }}
{{- fail "\nkinora: auth.disablePasswordAuth=true requires an external sign-in provider.\n\nConfigure one of auth.oidc (issuerUrl + clientId + clientSecret), auth.google, or\nauth.github. The server enforces this with a zod refine and will not start - failing here\ngives you the message at install time instead of a CrashLoopBackOff.\n" }}
{{- end }}
{{- end }}

{{- if .Values.auth.oidc.issuerUrl }}
{{- if not .Values.auth.oidc.clientId }}
{{- fail "\nkinora: auth.oidc.issuerUrl is set but auth.oidc.clientId is empty.\n\nresolveOidc() needs issuerUrl + clientId + clientSecret; with any missing, SSO is silently\noff and the sign-in button never appears.\n" }}
{{- end }}
{{- if not (include "kinora.hasSecret" (dict "ctx" . "key" "OIDC_CLIENT_SECRET" "inline" .Values.auth.oidc.clientSecret)) }}
{{- fail "\nkinora: auth.oidc.issuerUrl is set but there is no source for OIDC_CLIENT_SECRET.\n\nSet auth.oidc.clientSecret, or supply it via secrets.existingSecret / secrets.mappings.\n" }}
{{- end }}
{{- end }}

{{- if .Values.smtp.host }}
{{- if not .Values.smtp.from }}
{{- fail "\nkinora: smtp.host is set but smtp.from is empty.\n\nresolveSmtp() needs host + port + from; with any missing, every e-mail flow (verification,\npassword reset, invitations, alert e-mails) stays silently disabled.\n" }}
{{- end }}
{{- if not .Values.smtp.port }}
{{- fail "\nkinora: smtp.host is set but smtp.port is empty. resolveSmtp() needs host + port + from.\n" }}
{{- end }}
{{- end }}

{{- if .Values.ingress.enabled }}
{{- if not (include "kinora.publicHost" .) }}
{{- fail "\nkinora: ingress.enabled=true needs a hostname.\n\nSet ingress.host, or a publicUrl the chart can derive it from.\n" }}
{{- end }}
{{- end }}
{{- if .Values.httpRoute.enabled }}
{{- if not .Values.httpRoute.parentRefs }}
{{- fail "\nkinora: httpRoute.enabled=true needs httpRoute.parentRefs - the Gateway to attach to.\n\n  httpRoute:\n    parentRefs:\n      - name: my-gateway\n        namespace: gateway-system\n" }}
{{- end }}
{{- end }}

{{- end -}}
