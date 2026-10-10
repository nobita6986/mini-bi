# P3.1-W01D-A1b1 — Team leader read authority

> Base: `cd972cd67ddc38173e1cd09527cfa93e584ff925`
> Implementation commit: `05e8a03` (`feat(p3.1-w01d-a1b1): add leader read RPCs`)
> Scope: DB read authority, three bounded read RPCs, regression/mutation checks, and inventory rebaseline. No leader write lifecycle or application surface.

## Contract

The sole new resolver is `direct_entry_assert_team_leader_read_authority`. It first validates the auth-subject/app-user mapping, then delegates catalog authority to the canonical `direct_entry_assert_catalog_operator`. Only a canonical authority-denied SQLSTATE may fall through to leader evaluation; other errors propagate. Catalog operators can filter any business team, including inactive history. Unknown and reserved team filters stay bounded to zero matching business rows.

The leader path requires the effective `team_manager_assign` capability, exactly one effective team scope, exactly one verified effective recruiter link, active recruiter, exactly one canonical HRP provider identity, exactly one effective membership matching the scoped team, an active non-reserved team, and exactly one matching effective leader assignment. Ambiguous, missing, expired, future, disabled, unmapped, mismatched, and cross-team authority fails closed with `42501`. Zero-length markers are inert in authority predicates.

The resolver is revoked from `public`, `anon`, `authenticated`, and `service_role`. All three RPCs are `SECURITY DEFINER`, pin `search_path = pg_catalog, public`, and grant `EXECUTE` only to `service_role`:

- `direct_entry_list_team_leaders_current`
- `direct_entry_list_team_leaders_scheduled`
- `direct_entry_list_team_leader_history`

Each returns `authorization_date`, `page`, `page_size`, `total`, and bounded `leaders`. Current, scheduled, and history predicates are disjoint. Cancellation markers appear only in history; cancelled future markers never appear as scheduled/current. All projections reuse the fixed leader projection and exclude the reserved Vendor team.

## Evidence

- `scripts/p3-1-w01d-a1b1-leader-read.test.mjs` applies all 71 migrations in disposable PGlite and verifies catalog/admin/leader allow/deny behavior, corrupt/ambiguous identity and interval cases, bounded filters/paging/sorting, projection shape, ACL/search path, source authority, reserved-team isolation, migration count, and byte identity of migrations #1–#70.
- Focused lane: 1/1 passing. Adjacent lanes: A1a 17/17, W01C-B 34/34, W01C-A 25/25, W01B 29/29, W01A 9/9.
- Mutation sensitivity: all eight intended mutations made the focused lane red (one failing test per mutation): same-team check, leader-assignment check, active-team check, marker-in-current, reserved-team filter, authenticated EXECUTE, `personnel_position` authority reference, and cross-team denial-to-empty. Mutations were applied in memory while loading #71; the checked-in SQL was never overwritten. Final unmutated focused run passed.
- Migration and lane SHA-256:
  - #71: `5e188460d5df932e3c4faef2e9b65b20950397f0a31255b588d3f286994e0c2a`
  - Focused lane: `67d1f48debb6ad627d04fbcccc4c8094d9eb57794a3ed4a0e66dd9e7ce8dfb94`
- Ledger remains 71 migrations, with #71 last; no #72. #1–#70 are byte-identical to the base commit.

## Gates and inventory

- `pnpm test` — PASS, including the A1b1 lane immediately after A1a.
- `pnpm exec next typegen`, `pnpm typecheck`, `pnpm lint`, `pnpm build` — PASS.
- `pnpm docs:check`, `pnpm secrets:check`, `pnpm db:migrate -- --offline`, `git diff --check` — PASS.
- Lint reports 0 errors and 15 existing warnings, with no warning in the new lane.
- Build required a temporary `turbopack.root = "C:\\CodeApp"` because the preserved `node_modules` junction resolves outside the worktree. The build passed with that temporary setting; `next.config.ts` was restored, and the junction was not changed.
- Measured function inventory: before #71, 162 total / 76 service-role / 86 internal; after #71, 169 / 79 / 90. The existing A1a adds three internal helpers; A1b1 adds one internal resolver and three service-role RPCs. Inventory assertions now use the measured totals.
- Fixed only the stale W02 migration-count message from #1–#68 to #1–#71.

## Not included

No designate/replace/revoke write RPC, legacy transition, seed revocation, TypeScript/API/UI, Production query/apply, deployment, or browser UAT. A1b2/A1b3/A2 remain out of scope.
