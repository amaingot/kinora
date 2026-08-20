{{- /*
The one shared server environment block. The migrate initContainer MUST use it too:
packages/server/scripts/migrate.ts imports src/lib/env.ts, which validates the ENTIRE zod
schema (BASE_URL, AUTH_SECRET, the KINORA_DISABLE_PASSWORD_AUTH refine, ...) - not just the
POSTGRES_* vars it actually reads. A drifting env block means the migration crashes on boot.

Credentials are deliberately absent here. They arrive via envFrom (the chart's Secret, then
secrets.existingSecret), except for secrets.mappings which must be `env` entries. Kubernetes
resolves env over envFrom, and later envFrom over earlier, which is exactly the documented
precedence: mappings > existingSecret > inline. server.extraEnv is appended last so it wins.

Optional groups are emitted only when their non-secret anchor value is set, mirroring how the
server's own resolveOidc/resolveSmtp/resolveS3/resolveSlackApp gate themselves.
*/}}
{{- define "kinora.serverEnv" -}}
- name: NODE_ENV
  value: production
- name: PORT
  value: {{ .Values.server.containerPort | quote }}
{{- /* Single origin: getTrustedOrigins() returns [WEB_ORIGIN] only, and artifact URLs are built
     from BASE_URL, so these two must be the same externally reachable URL. */}}
- name: BASE_URL
  value: {{ include "kinora.publicUrl" . | quote }}
- name: WEB_ORIGIN
  value: {{ include "kinora.publicUrl" . | quote }}
{{- /* Cloud mode needs the four POLAR_* vars or the server refuses to boot; the chart does not
     model them, so this is pinned. POLAR_* and FEEDBACK_TRACKER_* are intentionally absent. */}}
- name: KINORA_CLOUD
  value: "false"
- name: INGEST_RATE_LIMIT
  value: {{ .Values.ingestRateLimit | quote }}
{{- if .Values.auth.cookieDomain }}
{{- /* auth.ts gates on truthiness, so an empty value is identical to unset - only emit it when
     there is something to say. */}}
- name: COOKIE_DOMAIN
  value: {{ .Values.auth.cookieDomain | quote }}
{{- end }}
{{- if .Values.demo }}
- name: KINORA_DEMO
  value: "true"
{{- end }}
- name: POSTGRES_HOST
  value: {{ include "kinora.postgres.host" . | quote }}
- name: POSTGRES_PORT
  value: {{ .Values.postgres.port | quote }}
- name: POSTGRES_USER
  value: {{ .Values.postgres.username | quote }}
- name: POSTGRES_DB
  value: {{ .Values.postgres.database | quote }}
{{- with .Values.postgres.sslMode }}
{{- /* kinora has no sslmode setting, but both drizzle and knex use node-postgres, and pg applies
     PGSSLMODE whenever the connection config omits `ssl` (connection-parameters.js:
     `typeof config.ssl === 'undefined' ? readSSLConfigFromEnvironment() : config.ssl`) - which
     it does. This is what makes RDS / Cloud SQL / Neon work with no code change. Note pg does
     NOT read PGSSLROOTCERT, so `require` verifies against Node's default CA bundle; managed
     providers with a private CA generally need `no-verify`. */}}
- name: PGSSLMODE
  value: {{ . | quote }}
{{- end }}
{{- if include "kinora.s3.enabled" . }}
{{- /* resolveS3() is all-or-nothing: any missing value silently falls back to local disk, which
     with no PVC means artifacts vanish on restart. validateValues enforces the full set. */}}
- name: S3_ENDPOINT
  value: {{ .Values.storage.s3.endpoint | quote }}
- name: S3_REGION
  value: {{ .Values.storage.s3.region | quote }}
- name: S3_BUCKET
  value: {{ .Values.storage.s3.bucket | quote }}
{{- else }}
{{- /* Absolute, unlike the app default ".data/artifacts", so STORAGE_DIR and the PVC mountPath
     are provably the same string. */}}
- name: STORAGE_DIR
  value: {{ .Values.storage.local.path | quote }}
{{- end }}
{{- if .Values.retention.runDays }}
- name: KINORA_RETENTION_DAYS
  value: {{ .Values.retention.runDays | quote }}
{{- end }}
{{- if .Values.retention.keepLastRuns }}
- name: KINORA_KEEP_LAST_RUNS
  value: {{ .Values.retention.keepLastRuns | quote }}
{{- end }}
{{- if .Values.retention.artifactDays }}
- name: KINORA_ARTIFACT_RETENTION_DAYS
  value: {{ .Values.retention.artifactDays | quote }}
{{- end }}
{{- with .Values.auth.google.clientId }}
- name: GOOGLE_CLIENT_ID
  value: {{ . | quote }}
{{- end }}
{{- with .Values.auth.github.clientId }}
- name: GITHUB_CLIENT_ID
  value: {{ . | quote }}
{{- end }}
{{- if .Values.auth.oidc.issuerUrl }}
{{- /* resolveOidc() needs issuer + clientId + clientSecret. The callback path is fixed at
     ${BASE_URL}/api/auth/oauth2/callback/oidc - NOTES.txt prints it for the IdP registration. */}}
- name: OIDC_ISSUER_URL
  value: {{ .Values.auth.oidc.issuerUrl | quote }}
- name: OIDC_CLIENT_ID
  value: {{ .Values.auth.oidc.clientId | quote }}
{{- with .Values.auth.oidc.providerName }}
- name: OIDC_PROVIDER_NAME
  value: {{ . | quote }}
{{- end }}
{{- with .Values.auth.oidc.scopes }}
- name: OIDC_SCOPES
  value: {{ . | quote }}
{{- end }}
{{- with .Values.auth.oidc.discoveryUrl }}
- name: OIDC_DISCOVERY_URL
  value: {{ . | quote }}
{{- end }}
{{- if not .Values.auth.oidc.pkce }}
- name: OIDC_PKCE
  value: "false"
{{- end }}
{{- end }}
{{- if .Values.auth.disablePasswordAuth }}
- name: KINORA_DISABLE_PASSWORD_AUTH
  value: "true"
{{- end }}
{{- if .Values.smtp.host }}
{{- /* resolveSmtp() needs host + port + from; user/pass stay optional for unauthenticated relays. */}}
- name: SMTP_HOST
  value: {{ .Values.smtp.host | quote }}
- name: SMTP_PORT
  value: {{ .Values.smtp.port | quote }}
- name: SMTP_FROM
  value: {{ .Values.smtp.from | quote }}
{{- with .Values.smtp.user }}
- name: SMTP_USER
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .Values.slack.clientId }}
{{- /* The "Add to Slack" OAuth app. Without it, Slack alerts fall back to a manually pasted
     incoming-webhook URL, which works fine. */}}
- name: SLACK_CLIENT_ID
  value: {{ . | quote }}
{{- end }}
{{- with .Values.sentryDsn }}
- name: SENTRY_DSN
  value: {{ . | quote }}
{{- end }}
{{- /* Tier 3: credentials from Secrets whose key names you do not control. */}}
{{- range $name, $ref := .Values.secrets.mappings }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ $ref.name }}
      key: {{ $ref.key }}
{{- end }}
{{- /* Tier 4: last word on everything. */}}
{{- with .Values.server.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}
{{- /*
envFrom for the server + migrate containers. Order matters: the chart's own Secret first, then
secrets.existingSecret (which therefore overrides it), then the raw escape hatch.
*/}}
{{- define "kinora.serverEnvFrom" -}}
{{- if include "kinora.hasInlineSecrets" . }}
- secretRef:
    name: {{ include "kinora.secretName" . }}
{{- end }}
{{- with .Values.secrets.existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- with .Values.server.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end -}}
