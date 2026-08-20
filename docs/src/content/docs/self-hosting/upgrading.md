---
title: Upgrading & backups
description: Pull the latest kinora images, pin or roll back, and back up your data volumes.
---

## Upgrading

```bash
docker compose pull && docker compose up -d
```

Migrations apply automatically on start (the one-shot `migrate` service runs before the server).
There is no separate migration step to run. `git pull` is only needed when `docker-compose.yml`
or `nginx.conf` change.

Images are published on every commit to `main` as `latest` and `sha-<commit>`. To pin a version
or roll back, set the tag in `.env` and bring the stack up again:

```bash
KINORA_IMAGE_TAG=sha-44b6925
```

If you build from source (`docker-compose.build.yml`), add `--build` to the `up` command instead
of pulling.

## Backups

Two named volumes hold all state:

- `kinora-db` - the Postgres database (projects, runs, tests, users).
- `kinora-artifacts` - uploaded `trace.zip`, screenshots, and videos (when using local storage;
  with an [S3 store](/self-hosting/storage/) the artifacts live in your bucket instead).

Back them up with your usual volume backup workflow, or `pg_dump` for the database:

```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > kinora-backup.sql
```

Restore by piping a dump back into `psql` on a fresh database, then bring the stack up.
