# P3.1-W02-B Vendor catalog lifecycle backend: P3_1_W02_B_VENDOR_LIFECYCLE_LOCAL_PASS_AWAITING_T0_REVIEW

Branch `feature/p3-1-w02b-vendor-lifecycle`. Base `origin/main@09376b8ed44bc304b827f099f9597a4b82980ff0` ->
final (this commit). Fast-forward only; no Production query/apply/deploy, no browser or UAT work, no new
dependency, no merge of `main`.

## Delta

- NEW `supabase/migrations/20261009110000_p3_1_w02b_vendor_lifecycle.sql` (#75, append-only; #1-#74
  byte-identical): Vendor master `list/get/create/update/set-active` over the existing canonical
  `public.vendors` from #41. It reuses the single #68 guard `direct_entry_assert_catalog_operator`
  (legacy Full Admin triple **or** `catalog_master_manage`, both at effective `all` scope), defines no
  second catalog guard, and records the authority actually used in the audit event (`entry_admin` or
  `catalog_master_manage`, scope `all`).
- One atomic canonical Vendor aggregate on create: exactly one `public.vendors` row, one representation
  `public.recruiters` row and one `public.recruiter_provider_memberships` row (`provider_type='vendor'`,
  `vendor_id`, explicit operator-supplied `valid_from`). Never a team, team membership, scope or
  capability grant, app-user link or account: the closing self-check bans those tokens from all three
  write RPC bodies, and the lane asserts the aggregate shape plus the zero-residue boundaries.
- Vendor identity contract: `vendor_id` is an immutable business key whose shape mirrors the #41 check
  exactly (`^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$`) and is rejected with a bounded `22023` before the raw
  `23514`; `display_name` is the only update field; `active` has its own mutation path, so a generic
  update can never reach either identity or state.
- Revision contract: new append-only `public.direct_entry_vendor_revisions` table (forced RLS, revoked
  from every role, immutable trigger, `unique (vendor_id, version)`) plus an audit `vendor_revision_id`
  binding column. Every action writes one revision with the same fixed four-key snapshot
  (`vendor_id`, `display_name`, `active`, `version`) and one audit event bound to the revision it
  produced. The version-bump helper derives the after-snapshot from the bumped row itself, so a
  revision can never record a version the vendor row does not carry.
- Reserved namespace: `__system_vendor__` is excluded by canonical string comparison, never by a
  hard-coded UUID and never through the system-team helper. Create rejects it with `22023`; get, update
  and set-active fail closed with `P0002`, and the lane proves the #41 check forbids the row outright.
- Fail-closed deactivation: the Vendor's canonical representation recruiter (the recruiter whose only
  provider membership is this vendor membership, in force today) follows the Vendor active flag in the
  same transaction, so the existing `direct_entry_validate_new_entry` trigger raises `23514`
  ('recruiter is not active') for a new Direct Entry row and an inactive Vendor disappears from the
  list unless inactive rows are requested. Nothing is deleted, no interval is closed, and reactivation
  restores exactly the same representation rows.
- Error taxonomy and atomicity: `42501` authorization, `22023` validation (bounded reason, canonical
  key, create `expected_version = 0`), `23505` duplicate, `P0002` unknown or reserved, `40001` OCC
  conflict; one bounded reason, one expected version, one idempotency key per mutation, with exact
  replay served from the stored result and any failure leaving zero residue.
- Server layer, no UI: `vendor-catalog-contract.ts` (fail-closed projections), `vendor-catalog-repository.ts`
  (the five canonical RPCs, SQLSTATE to sanitized kinds), `vendor-catalog-api.ts` and three
  `/api/admin/catalog/vendors` routes (feature gate, same-origin, bounded JSON, recursive client
  authority rejection, session-only actor, `no-store`, sanitized taxonomy).
- Ledger bookkeeping: migration counts 74 -> 75, the pinned slot offsets, the derived function inventory
  183/84/99 -> 194/89/105, the alias-backfill pre-hotfix tail list and the "newest migration" statements
  (35 files), following the same convention as #66-#74. Lane `test:p3-1-w02b-vendor-catalog` is
  registered exactly once in `package.json` and once in the `pnpm test` chain.
- Out of scope and untouched: personnel catalog, team catalog and membership, leader lifecycle, project
  operations, labor type, accounts/grants/links, W04 UI and all Production state.

## Evidence

The focused lane `test:p3-1-w02b-vendor-catalog` is 25/25 (15 PGlite DB tests + 10 API/repository
tests) and is green again after the mutation pass.

- Ledger: exact #75 addition, `#1-#74` byte-identical, reserved-namespace string boundary and no
  hard-coded UUID, additive-only DDL (one table, one audit column, one trigger, 11 functions, five
  service-role grants), and the `git` worktree check that no earlier migration is modified.
- Authority: both catalog paths (Full Admin triple and `catalog_master_manage`, both at effective `all`
  scope) can read and write; entry-admin-without-`all`, catalog-without-`all`, leader, staff, disabled
  actors are denied with `42501` before any input is inspected, with zero residue.
- Atomic create: exactly one vendor row, one representation recruiter row, one `provider_type='vendor'`
  membership with the operator-supplied `valid_from`, one revision and one audit event; duplicate
  vendor id `23505`; malformed key, reserved key, missing `valid_from`, missing reason, missing
  idempotency key and a non-zero create version all `22023`; a fault-injected late failure rolls the
  whole aggregate back with zero residue.
- Update and set-active: display_name-only update under OCC with `vendor_id` immutable and `active`
  unreachable; stale version `40001`, no-op `22023`, unknown or reserved `P0002`; the revision history
  keeps the create revision and appends exactly one revision per applied change with the fixed four-key
  before/after snapshots; the audit event carries the authority used, the bounded reason and the
  revision id.
- Fail-closed deactivation: the representation recruiter follows the Vendor state in the same
  transaction, the Direct Entry identity gate then raises `23514` ('recruiter is not active'), an
  inactive Vendor disappears from the list unless inactive rows are requested, the membership interval
  row and every stored fact survive, and reactivation restores exactly the same representation rows.
- Bounded read: list total and order are derived from the database and never drift, page/page_size are
  bounded (1..1000 / 1..100), pages partition the deterministic order without overlap, search matches
  display_name or vendor_id, the no-match case is empty, and the envelope/item/revision key sets are
  exact.
- Idempotency: an exact replay returns the stored result and writes nothing new, a reused key with
  different input is a `22023` conflict, and every rejected call leaves zero residue.
- ACL/RLS: `service_role` is the only role that can execute the five RPCs; no role holds write DML on
  the catalog tables and no role can read the revision history (asserted both by catalog query and by a
  `set local role` session); the revision table is RLS + FORCE RLS; every RPC and helper is
  `SECURITY DEFINER` with `search_path = pg_catalog, public`; the reserved namespace can never even be
  inserted into `public.vendors` (`23514`).
- API layer: the feature gate runs before session and repository, same-origin is enforced before the
  session on mutations, content-type/body/recursive client-authority fields are rejected first, the
  request projections are strict (create requires `expected_version = 0` and a canonical key; PATCH
  cannot reach `vendor_id`, `active` or `valid_from`), the actor only ever comes from the session,
  idempotency header mismatches are rejected before the repository, responses are projected and
  `no-store`, and no raw DB message can leak.

Mutation evidence (13 in-memory mutations, lane must go red, migration restored byte-for-byte):

| Mutation | Result |
|---|---|
| Reserved-namespace check removed from create | Red |
| Create skips the catalog-operator guard | Red |
| Create stops writing the representation recruiter | Red |
| Create writes a team membership (catalog boundary crossed) | Red |
| Create writes the audit event with outcome DENIED | Red |
| Fixed four-key vendor snapshot gains a fifth key | Red |
| Update response inverts `active` | Red |
| Set-active stops following the representation recruiter | Red |
| Version bump no longer increments | Red |
| Vendor lock drops the OCC check | Red |
| Create drops the idempotency replay | Red |
| Revision records the wrong version in the after snapshot | Red |
| Create RPC granted to `authenticated` | Red |

## Gates

| Gate | Result |
|---|---|
| `test:p3-1-w02b-vendor-catalog` (focused) | Pass, 25/25 (15 DB + 10 API) |
| Canonical `pnpm test` | Pass, 68 lanes, 2403 tests, 0 failures |
| `pnpm exec next typegen` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass, 0 errors / 15 pre-existing warnings |
| `pnpm exec next build --webpack` | Pass, exit 0, "Compiled successfully in 20.3s" |
| `pnpm docs:check` | Pass, 6/6 examples |
| `pnpm secrets:check` | Pass, 1148 files scanned, no secret found |
| `pnpm db:migrate -- --offline` | Pass, 75 migrations valid, W02-B last |
| `git diff --check` | Pass |
| Mutation evidence | Pass, 13/13 red, migration restored byte-for-byte |

Plain `pnpm build` (Turbopack) cannot run inside this worktree because `node_modules` is a junction
pointing outside the project root; the documented Webpack opt-out was used instead, as in #74.

## Scope limit

Backend only, local only: no UI, no Production grant/apply, no deploy, no browser or UAT work, and no
modification of any earlier migration.
