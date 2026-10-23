# BI VPS release

The app uses the existing external Docker network `hrp-edge`; Caddy must already
join that network. `bi.hrpartner.vn` remains on Vercel until its DNS and Caddy
route are changed during the production cutover.

## GitHub configuration

Create a GitHub Environment named `production`, allow deployments from `main`,
and require an approval reviewer. Add these environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Add these environment secrets:

- `VPS_HOST`
- `VPS_USER` (the restricted `bi-deploy` account)
- `VPS_SSH_PRIVATE_KEY`
- `VPS_KNOWN_HOSTS` (the VPS host key, verified out of band)

VPS 2 uses separate build variables so its image cannot silently reuse VPS 1's
Supabase project:

- `VPS2_NEXT_PUBLIC_SUPABASE_URL`
- `VPS2_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

It also requires environment secrets `VPS2_HOST`, `VPS2_USER`,
`VPS2_SSH_PRIVATE_KEY`, and `VPS2_KNOWN_HOSTS`. Use the restricted `bi-deploy`
account, not root SSH. The VPS 2 workflow refuses the VPS 1 host and project,
and tags its images with `-vps2` to prevent GHCR tag collisions.

Protect `main` with pull requests and require the exact status check
`Quality (typecheck · lint · tests · build)` before merging. Block force-pushes
and branch deletion.

Actions publishes private GHCR images with `GITHUB_TOKEN`; the VPS wrapper logs
in only while pulling and logs out afterward. The SSH user can invoke only the
two root-owned release wrappers in `sudoers.d/bi-deploy`.

## VPS files

Install the files as root with mode `0755`: `compose.yaml` at
`/opt/bi/compose.yaml`, `deploy-production.sh` at
`/opt/bi/deploy-production.sh`, `bi-release` at `/usr/local/sbin/bi-release`,
and `bi-migrate` at `/usr/local/sbin/bi-migrate`. Keep `/opt/bi` and these files
root-owned and not writable by `bi-deploy`. Install the sudoers file as
`/etc/sudoers.d/bi-deploy` with mode `0440` and validate it with
`visudo -cf /etc/sudoers.d/bi-deploy`.

Create `/etc/bi/production.env` with the exact runtime values currently used by
Vercel, including the Supabase URL, publishable key, and server-only
`SUPABASE_SECRET_KEY`. The production release guard requires these entries
exactly once:

```dotenv
DIRECT_ENTRY_API_ENABLED=true
DIRECT_ENTRY_UI_ENABLED=true
WORK_REPORTS_API_ENABLED=true
ATTENDANCE_ENABLED=true
ATTENDANCE_TIME_TOKEN_SECRET=<dedicated-random-secret>
DOCUMENT_STORAGE_ENVIRONMENT=production
R2_ACCOUNT_ID=<account-id>
R2_BUCKET_NAME=hrp-bi-product
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
```

`ATTENDANCE_TIME_TOKEN_SECRET` must be a dedicated printable ASCII value of
32–512 characters with at least eight distinct characters. It must not reuse a
Supabase, R2, AI, or other `*_SECRET`/`*_TOKEN` value. The deploy script checks
the environment before changing the image and verifies that the anonymous
attendance endpoints return authentication/CSRF responses after deployment.
It never prints secret values. Keep `/etc/bi/production.env` root-owned with
mode `0600`; deploys reuse this file instead of recreating it.

Create `/etc/bi/migration.env` with the values required by
`scripts/lib/load-supabase-config.mjs`: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
`SUPABASE_DB_URL`, and, when required, `SUPABASE_POOLER_HOST` and
`SUPABASE_POOLER_PORT`. This points to the same Supabase project used by Vercel.
Keep it root-owned with mode `0600`; it is mounted read-only only into the
one-shot migration container.

Configure VPS 2's runtime and migration env files independently for its own
Supabase project. Do not copy VPS 1's production or migration environment.

## Release behavior

- PRs and pushes to `main` run typecheck, lint, `pnpm test` (including the
  real-PostgreSQL concurrency regression), offline migration validation,
  production build, secret scan, and docs check. CI uses dummy credentials and
  does not connect to Supabase.
- A successful `main` CI run builds and publishes an app image and a matching
  migration image, both tagged by the full commit SHA. GitHub Environment review
  gates the VPS release.
- Before deploying, the root wrapper checks the live Supabase migration ledger.
  Any pending or checksum-mismatched migration stops the app release. No
  migration runs as part of a normal deployment.
- To apply migrations, run **Apply BI production migrations** with a SHA on
  `main`, confirm a current Supabase recovery point with
  `BACKUP_CONFIRMED`, and type `MIGRATE_PRODUCTION`. The migration runner applies
  each SQL file transactionally and checks that no migration remains pending.
- Migrations affect the same database currently used by Vercel. Keep them
  backward-compatible while Vercel and VPS both serve traffic; destructive or
  incompatible changes require a separate cutover plan.
- The VPS deploy script waits for container health and restores the previous
  image digest if a new image fails its health check.

## Proxy cutover

Add `Caddyfile.snippet` to the existing Caddy configuration and reload Caddy
when ready to move `bi.hrpartner.vn`. Do not change DNS until the app is healthy
on `hrp-edge` and the public HTTPS smoke check is planned.
