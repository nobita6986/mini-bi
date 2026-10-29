# BI Red automatic UAT deployment

Every successful `main` push CI run builds the exact tested SHA and deploys it to
`bi.hrpvietnam.com`. Production Blue/Green workflows and databases are not used.

## GitHub Environment

Create an Environment named `red` without a required reviewer. Add variables:

- `RED_NEXT_PUBLIC_SUPABASE_URL=https://spbase.hrpvietnam.com`
- `RED_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Add secrets:

- `RED_HOST`
- `RED_USER` (`bi-deploy`, not root)
- `RED_SSH_PRIVATE_KEY`
- `RED_KNOWN_HOSTS`

## One-time VPS installation

Install these repository files as root:

```text
deploy/red/compose.yaml                 -> /opt/bi-test/current/compose.yaml (0644)
deploy/red/bi-red-release               -> /usr/local/sbin/bi-red-release (0755)
deploy/red/bi-red-migrate               -> /usr/local/sbin/bi-red-migrate (0755)
deploy/red/sudoers.d/bi-red-deploy      -> /etc/sudoers.d/bi-red-deploy (0440)
deploy/red/supabase-resources.yaml      -> /opt/supabase/docker-compose.resources.yml (0644)
```

Validate the sudoers file with `visudo -cf /etc/sudoers.d/bi-red-deploy`.
The `bi-deploy` SSH account must not be able to edit these root-owned files.

Keep the existing `/etc/bi-test/production.env` root-owned at mode `0600`.
Create `/etc/bi-test/migration.env`, also root-owned at mode `0600`, with the
Supabase settings required by `scripts/apply-migrations.mjs`. Its
`SUPABASE_DB_URL` hostname must be `supabase-db`, and its public URL must be
`https://spbase.hrpvietnam.com`. Set `SUPABASE_DB_SSL_MODE=disable` because this
Docker-internal PostgreSQL endpoint does not provide TLS; both wrappers reject
any other DB target or SSL mode.

Keep the Supabase resource override in `COMPOSE_FILE`:

```dotenv
COMPOSE_FILE=docker-compose.yml:docker-compose.local-only.yml:docker-compose.resources.yml
```

The Red allocation is 3 GiB / 2 CPU for PostgreSQL and 2 GiB / 1.5 CPU for BI.
The remaining host capacity stays available to the other Supabase services and
Ubuntu. PostgreSQL itself uses `shared_buffers=512MB`,
`effective_cache_size=2GB`, `work_mem=8MB`, and `maintenance_work_mem=256MB`.

Before the first automated release, preserve the currently healthy image as the
rollback target:

```bash
docker inspect --format 'BI_IMAGE={{.Image}}' bi-test-app > /opt/bi-test/current/.release.env
chmod 640 /opt/bi-test/current/.release.env
```

## Behavior

- CI failure means no Red deployment.
- A pending or checksum-mismatched migration stops the app deployment before the
  active container changes. Run **Apply BI Red migrations**, type `MIGRATE_RED`,
  then re-run the failed Red deployment.
- A failed container or endpoint health check restores the previous app image.
- Cleanup runs only after health checks pass. It retains only the current healthy
  Red app image, removes older Red app/migration images, and prunes only dangling images.
- The scripts never call `docker system prune`, `docker volume prune`, or any
  command that deletes Supabase volumes.
