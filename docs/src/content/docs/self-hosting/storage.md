---
title: Storage & artifacts
description: 'Where kinora stores trace.zip artifacts: a local volume by default, or any S3-compatible store.'
---

kinora stores binary artifacts (`trace.zip`, screenshots, videos) through a storage interface
with two backends. Test metadata always lives in Postgres; this page is only about the binary
artifacts.

## Local volume (default)

With the `S3_*` variables empty, artifacts are written to a local directory, mounted as the
`kinora-artifacts` named volume in the self-host compose. This is the zero-config default and
keeps everything on your box.

Back it up like any Docker volume - see [Upgrading & backups](/self-hosting/upgrading/).

### On Kubernetes

The [Helm chart](/self-hosting/kubernetes/) uses a PersistentVolumeClaim instead of a named
volume, configured under `storage.local` (`size`, `storageClass`, or `existingClaim` to bring
your own). It is `ReadWriteOnce` by default, which is why the chart pins the server to a single
replica: `/artifacts` is served from local disk by whichever replica the Service picks. Configure
S3, or a `ReadWriteMany` volume, before scaling out.

## S3-compatible store

Set `S3_ENDPOINT`, `S3_REGION` and `S3_BUCKET` to store artifacts in any S3-compatible object
store instead of the local volume. Works with AWS S3, Cloudflare R2, MinIO, and Hetzner Object
Storage.

```bash
S3_ENDPOINT=https://s3.example.com
S3_REGION=auto
S3_BUCKET=kinora-artifacts
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Those three are required **together**. Setting only some of them stops the server from booting
with an explicit message, rather than quietly falling back to the local volume.

The credentials are optional, and must be set together or not at all - see
[Workload identity](#workload-identity) for what happens when you omit them.

In S3 mode the server is not in the download path at all: it hands out **presigned URLs** and the
browser fetches artifacts straight from your bucket. That is what makes the
[CORS](#cors) configuration below mandatory rather than optional.

### On Kubernetes

The [Helm chart](/self-hosting/kubernetes/) exposes the same settings under `storage.s3`, and
creates **no PersistentVolumeClaim** when they are set - nothing about artifacts touches a disk
inside the cluster:

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
```

This is also what lets you run more than one server replica. Pair it with
`postgres.enabled: false` and an external database, and the release provisions no cluster storage
whatsoever.

### Workload identity

Leave `accessKeyId` and `secretAccessKey` empty and kinora falls back to the AWS SDK's default
credential chain, which resolves credentials in this order: environment variables, SSO, the
shared config file, a credential process, the **web identity token file** (EKS IRSA), the
**container credentials endpoint** (EKS Pod Identity), and finally the instance metadata service.

On EKS that means no stored key at all - just annotate the ServiceAccount:

```yaml
storage:
  local:
    enabled: false
  s3:
    endpoint: https://s3.us-east-1.amazonaws.com
    region: us-east-1
    bucket: kinora-artifacts
    forcePathStyle: false
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/kinora
```

The role needs `s3:GetObject`, `s3:PutObject`, `s3:AbortMultipartUpload` and `s3:DeleteObject` on
`arn:aws:s3:::kinora-artifacts/*`. Leave `serviceAccount.automountServiceAccountToken` at its
default `false`: it only suppresses the Kubernetes API token, and the EKS webhook projects its
own separate token volume for the role.

A missing or misconfigured role does **not** fail at startup. It surfaces as a
`CredentialsProviderError` on the first artifact upload, so a green install proves nothing here -
upload a run and read the server logs.

**On GKE and AKS**, their own workload identity gives you Google or Azure credentials, not AWS
ones, so it does not apply directly. What works is AWS IAM OIDC federation: project a service
account token into the pod and set `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` yourself,
using the chart's `server.extraVolumes`, `server.extraVolumeMounts` and `server.extraEnv`. The
same `fromTokenFile` provider then does the rest. Note that none of this makes Google Cloud
Storage or Azure Blob Storage work - kinora speaks the S3 API only, and GCS needs its
interoperability HMAC keys, set as `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`.

### CORS

The dashboard's embedded trace viewer fetches `trace.zip` from the presigned artifact URL via a
service worker, using **range requests**. So the bucket needs CORS that both allows the `Range`
request header and *exposes* the response headers a partial response carries - without
`Content-Range` and friends the service worker cannot read the response, and traces fail to open
even though the dashboard works perfectly.

```json
[
  {
    "AllowedOrigins": ["https://kinora.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

`AllowedOrigins` is your `PUBLIC_URL` (or the chart's `publicUrl`). Apply it once:

```bash
# AWS S3, Cloudflare R2, Hetzner, any S3 API
aws s3api put-bucket-cors --bucket kinora-artifacts --cors-configuration file://cors.json

# MinIO
mc cors set myminio/kinora-artifacts cors.json
```

### Gotchas

Each of these produces the same symptom - the dashboard loads fine and traces never open - so
they are worth ruling out in order.

- **`S3_ENDPOINT` is a service endpoint, not a bucket URL.** kinora uses path-style addressing by
  default, so it must be `https://s3.us-east-1.amazonaws.com`, never
  `https://kinora-artifacts.s3.amazonaws.com` - the latter produces URLs with the bucket in twice.
  Set `S3_FORCE_PATH_STYLE=false` (chart: `storage.s3.forcePathStyle`) for virtual-hosted style,
  which is what AWS prefers for buckets created recently.
- **The bucket has to be reachable from your users' browsers.** Artifact URLs are presigned and
  fetched client-side, so an in-cluster MinIO on `http://minio.minio.svc.cluster.local:9000`
  cannot work no matter how well the server can reach it. Expose it and use the external URL.
- **Bucket lifecycle rules are not a substitute for retention.** kinora deletes expired artifacts
  from the bucket itself (`KINORA_ARTIFACT_RETENTION_DAYS`, chart `retention.artifactDays`).
  Objects deleted behind its back leave runs whose "View trace" link points at nothing. Use one
  or the other, and prefer kinora's.
- **Presigned URLs live up to an hour, and less under workload identity.** A temporary session
  expires the URL with it, so links minted from an IRSA session are good for somewhere between
  five and sixty minutes. Harmless in practice - the dashboard mints a fresh URL every time it
  answers - but do not bookmark one.
- **Off EC2, set `AWS_EC2_METADATA_DISABLED=true`.** With no resolvable credentials the chain
  walks all the way to the instance metadata service and only fails after a timeout, which turns
  a clear error into a slow one.
