{{- /* ------------------------------------------------------------------ names */}}

{{- define "kinora.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kinora.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "kinora.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- /* Each component is truncated independently so a long release name cannot produce an
     invalid (>63 char) Service name. */}}
{{- define "kinora.server.fullname" -}}
{{- printf "%s-server" (include "kinora.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kinora.web.fullname" -}}
{{- printf "%s-web" (include "kinora.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kinora.postgres.fullname" -}}
{{- printf "%s-postgres" (include "kinora.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kinora.secretName" -}}
{{- printf "%s-secrets" (include "kinora.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kinora.artifactsClaimName" -}}
{{- if .Values.storage.local.existingClaim -}}
{{- .Values.storage.local.existingClaim -}}
{{- else -}}
{{- printf "%s-artifacts" (include "kinora.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "kinora.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kinora.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- /* ----------------------------------------------------------------- labels */}}

{{- define "kinora.labels" -}}
helm.sh/chart: {{ include "kinora.chart" . }}
app.kubernetes.io/name: {{ include "kinora.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: kinora
{{- with .Chart.AppVersion }}
app.kubernetes.io/version: {{ . | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- /* Selectors carry the component so the three workloads can never cross-select, and the
     instance so two releases never adopt each other's pods. Immutable after install. */}}
{{- define "kinora.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kinora.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "kinora.componentLabels" -}}
{{ include "kinora.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- /* ----------------------------------------------------------------- images */}}

{{- define "kinora.server.image" -}}
{{- printf "%s:%s" .Values.server.image.repository (.Values.server.image.tag | default .Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "kinora.web.image" -}}
{{- printf "%s:%s" .Values.web.image.repository (.Values.web.image.tag | default .Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "kinora.postgres.image" -}}
{{- printf "%s:%s" .Values.postgres.image.repository .Values.postgres.image.tag -}}
{{- end -}}

{{- /* ------------------------------------------------------------- public URL */}}

{{- define "kinora.publicUrl" -}}
{{- .Values.publicUrl | trimSuffix "/" -}}
{{- end -}}

{{- /* Hostname only, port stripped - for Ingress/HTTPRoute defaults. */}}
{{- define "kinora.publicHost" -}}
{{- if .Values.ingress.host -}}
{{- .Values.ingress.host -}}
{{- else if .Values.publicUrl -}}
{{- regexReplaceAll ":[0-9]+$" (urlParse (include "kinora.publicUrl" .)).host "" -}}
{{- end -}}
{{- end -}}

{{- /* --------------------------------------------------------------- database */}}

{{- define "kinora.postgres.host" -}}
{{- if .Values.postgres.enabled -}}
{{- include "kinora.postgres.fullname" . -}}
{{- else -}}
{{- .Values.postgres.host -}}
{{- end -}}
{{- end -}}

{{- /* ---------------------------------------------------------------- storage */}}

{{- /* S3 is used when the three non-secret coordinates are set - which is exactly what the
     server's resolveS3() keys off. Credentials are deliberately not part of this test: they may
     arrive from an existing Secret, or not exist at all when the pod uses workload identity. */}}
{{- define "kinora.s3.enabled" -}}
{{- if and .Values.storage.s3.endpoint .Values.storage.s3.region .Values.storage.s3.bucket -}}true{{- end -}}
{{- end -}}

{{- define "kinora.localStorage.enabled" -}}
{{- if not (include "kinora.s3.enabled" .) -}}{{- if .Values.storage.local.enabled -}}true{{- end -}}{{- end -}}
{{- end -}}

{{- /* ---------------------------------------------------------------- secrets */}}

{{- /* Inline credentials, keyed by the LITERAL environment variable name so the Secret can be
     mounted wholesale with envFrom. Only non-empty entries are emitted, so the Secret (and the
     secretRef that mounts it) disappears entirely when every credential comes from elsewhere.
     toJson quoting round-trips any value byte-for-byte through fromYaml. */}}
{{- define "kinora.inlineSecretData" -}}
{{- with .Values.auth.secret }}
AUTH_SECRET: {{ . | toJson }}
{{- end }}
{{- with .Values.postgres.password }}
POSTGRES_PASSWORD: {{ . | toJson }}
{{- end }}
{{- with .Values.auth.google.clientSecret }}
GOOGLE_CLIENT_SECRET: {{ . | toJson }}
{{- end }}
{{- with .Values.auth.github.clientSecret }}
GITHUB_CLIENT_SECRET: {{ . | toJson }}
{{- end }}
{{- with .Values.auth.oidc.clientSecret }}
OIDC_CLIENT_SECRET: {{ . | toJson }}
{{- end }}
{{- with .Values.smtp.password }}
SMTP_PASS: {{ . | toJson }}
{{- end }}
{{- with .Values.slack.clientSecret }}
SLACK_CLIENT_SECRET: {{ . | toJson }}
{{- end }}
{{- with .Values.storage.s3.accessKeyId }}
S3_ACCESS_KEY_ID: {{ . | toJson }}
{{- end }}
{{- with .Values.storage.s3.secretAccessKey }}
S3_SECRET_ACCESS_KEY: {{ . | toJson }}
{{- end }}
{{- end -}}

{{- define "kinora.hasInlineSecrets" -}}
{{- if (include "kinora.inlineSecretData" . | fromYaml) -}}true{{- end -}}
{{- end -}}

{{- /* Does the named environment variable have a credential source anywhere across the four
     tiers? Used only by validateValues, so an existingSecret user is never blocked by a guard
     that cannot see inside their Secret. */}}
{{- define "kinora.hasSecret" -}}
{{- $ctx := .ctx -}}
{{- $found := "" -}}
{{- if .inline -}}{{- $found = "true" -}}{{- end -}}
{{- if $ctx.Values.secrets.existingSecret -}}{{- $found = "true" -}}{{- end -}}
{{- if hasKey $ctx.Values.secrets.mappings .key -}}{{- $found = "true" -}}{{- end -}}
{{- range $ctx.Values.server.extraEnv -}}
{{- if eq .name $.key -}}{{- $found = "true" -}}{{- end -}}
{{- end -}}
{{- if $ctx.Values.server.extraEnvFrom -}}{{- $found = "true" -}}{{- end -}}
{{- $found -}}
{{- end -}}

{{- /* --------------------------------------------------------------------- CSP */}}

{{- define "kinora.csp" -}}
{{- if .Values.web.nginx.contentSecurityPolicy -}}
{{- .Values.web.nginx.contentSecurityPolicy -}}
{{- else -}}
{{- $connect := list "'self'" -}}
{{- if include "kinora.s3.enabled" . -}}
{{- /* Presigned S3 artifact URLs live on the bucket's own origin and the trace viewer's service
     worker range-fetches them from the browser, so connect-src 'self' alone would block them.
     The bucket also needs CORS for GET + Range - see docs/self-hosting/storage.

     Which origin depends on the addressing style: path-style keeps the bucket in the path and
     the origin is just the endpoint, while virtual-hosted style moves the bucket INTO the
     hostname. Get this wrong and the dashboard renders perfectly while every trace fails to
     load, with the only evidence a CSP violation in the browser console. */}}
{{- $u := urlParse .Values.storage.s3.endpoint -}}
{{- if .Values.storage.s3.forcePathStyle -}}
{{- $connect = append $connect (printf "%s://%s" $u.scheme $u.host) -}}
{{- else -}}
{{- $connect = append $connect (printf "%s://%s.%s" $u.scheme .Values.storage.s3.bucket $u.host) -}}
{{- end -}}
{{- end -}}
{{- range .Values.web.nginx.extraConnectSrc -}}
{{- $connect = append $connect . -}}
{{- end -}}
{{- printf "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src %s; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'" (join " " $connect) -}}
{{- end -}}
{{- end -}}

{{/* ------------------------------------------------- bundled postgres secret */}}

{{- /*
The bundled Postgres container needs a concrete secretKeyRef rather than the server's blanket
envFrom - injecting AUTH_SECRET and every OAuth secret into the database container would be
gratuitous. Precedence matches the documented tiers: mappings > existingSecret > chart Secret.
*/}}
{{- define "kinora.postgres.passwordRef" -}}
{{- $m := index .Values.secrets.mappings "POSTGRES_PASSWORD" -}}
{{- if $m -}}
name: {{ $m.name }}
key: {{ $m.key }}
{{- else if .Values.secrets.existingSecret -}}
name: {{ .Values.secrets.existingSecret }}
key: POSTGRES_PASSWORD
{{- else -}}
name: {{ include "kinora.secretName" . }}
key: POSTGRES_PASSWORD
{{- end -}}
{{- end -}}
