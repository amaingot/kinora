# Single-origin self-host: serve the dashboard + trace viewer, and reverse-proxy the API to the
# server Service so everything is one origin (no CORS, no cross-subdomain cookie).
#
# This is a templated copy of selfhost/nginx.conf. It has to live in the chart because Helm
# cannot read files outside the chart directory, and it has to be mounted at all because the
# published ghcr.io/<owner>/kinora-web image bakes packages/web/nginx.conf - the CLOUD config,
# which serves the SPA but has no /api/ proxy whatsoever.
#
# Keep it in sync with selfhost/nginx.conf; .github/workflows/helm.yml diffs the two.
server {
  listen {{ .Values.web.containerPort }};
  server_name _;
  client_max_body_size {{ .Values.web.nginx.clientMaxBodySize }}; # trace.zip uploads

  # API (ingest, auth, slack), tRPC, and artifacts -> server Service.
  # The upstream is templated so two releases can coexist in one namespace.
  location /api/ {
    proxy_pass http://{{ include "kinora.server.fullname" . }}:{{ .Values.server.service.port }};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location /trpc/ {
    proxy_pass http://{{ include "kinora.server.fullname" . }}:{{ .Values.server.service.port }};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location /artifacts/ {
    proxy_pass http://{{ include "kinora.server.fullname" . }}:{{ .Values.server.service.port }};
    proxy_set_header Host $host;
    proxy_buffering off; # stream trace.zip + honor Range
    # A large trace streaming to a slow client easily exceeds nginx's 60s default between reads.
    proxy_read_timeout {{ .Values.web.nginx.proxyReadTimeout }};
  }
  location = /healthcheck {
    proxy_pass http://{{ include "kinora.server.fullname" . }}:{{ .Values.server.service.port }};
  }

  # Bare /trace -> /trace/ (the viewer is served with base /trace/).
  location = /trace {
    return 301 /trace/;
  }

  # Embedded trace viewer (built with base /trace/: its own index, assets, sw).
  location /trace/ {
    root /usr/share/nginx/html;
    try_files $uri $uri/ /trace/index.html;
    # Viewer renders untrusted recorded content in sandboxed iframes + a SW that range-fetches
    # the trace zip; resource directives stay open, only harden the rest.
    add_header Content-Security-Policy "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" always;
  }

  # Web hashed assets - immutable, long cache.
  location /assets/ {
    root /usr/share/nginx/html;
    try_files $uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  # Web SPA - vue-router history fallback.
  location / {
    root /usr/share/nginx/html;
    try_files $uri $uri/ /index.html;
    # Single origin: API is proxied same-origin (connect 'self'). img https: = social-login avatars.
    add_header Content-Security-Policy "{{ include "kinora.csp" . }}" always;
  }
{{- with .Values.web.nginx.extraServerConfig }}

  # web.nginx.extraServerConfig
{{ tpl . $ | indent 2 }}
{{- end }}
}
