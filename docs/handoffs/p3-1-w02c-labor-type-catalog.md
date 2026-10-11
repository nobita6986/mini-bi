# P3.1-W02-C Labor type catalog backend: P3_1_W02_C_LABOR_TYPE_CATALOG_LOCAL_PASS_AWAITING_T0_REVIEW

Branch `feature/p3-1-w02c-labor-type-catalog`. Base `origin/main@5f41caf689dbfd52bb889744f227aa659da393db`
-> final (this commit). Fast-forward only; no Production query/apply/deploy, no browser or UAT work, no new
dependency, no merge of `main`.

## Delta

- NEW `supabase/migrations/20261011120000_p3_1_w02c_labor_type_catalog.sql` (#79, append-only; #1-#78
  byte-identical). The labor-type vocabulary stops being a closed set in source and becomes a canonical
  catalog the database owns.
- Catalog aggregate: `public.direct_entry_labor_types` (canonical `labor_type_key` primary key with the
  contract shape `^[A-Z][A-Z0-9_]{0,63}$`, `display_name`, unique catalog-owned `reporting_key`,
  `sort_order`, `active`, `version`, timestamps) plus the append-only
  `public.direct_entry_labor_type_revisions` (unique `(labor_type_key, version)`, immutable trigger) and
  the audit binding column `labor_type_revision_id`. Both tables are RLS + FORCE RLS and are granted to
  no role; only `service_role` reaches them through the RPCs.
- Exactly three seeds: `TEMPORARY`/"Thời vụ"/`thời vụ`/10, `PERMANENT`/"Chính thức"/`chính thức`/20,
  `OUTSOURCED`/"Gia công"/`gia công`/30, all active at version 1. The migration never backfills and never
  guesses: the seed set is exactly the retired closed set, and nothing else is invented.
- Immutability: `direct_entry_labor_types_immutable_guard` raises `55000` if `labor_type_key` or
  `reporting_key` is ever updated. Only `display_name`, `sort_order` and `active` are mutable, and
  `reporting_key` is generated server-side as the lower-cased key, so a client can never send one. There
  is no hard delete.
- Legacy verification before the cutover: after the seeds are inserted the migration resolves every
  existing `direct_entries.labor_type` against the catalog and aborts the whole transaction with
  `55000` (naming the offending `entry_id`) on the first value that does not resolve. The retired
  closed-set CHECK is then dropped dynamically from `pg_constraint` and the hard FK
  `direct_entries_labor_type_fkey` is added with `ON UPDATE RESTRICT` and `ON DELETE RESTRICT`, so a
  referenced key can never be renamed or removed and historical rows stay readable.
- Active-write enforcement, layered: (1) `direct_entry_labor_type_write_guard` (BEFORE INSERT OR UPDATE
  OF labor_type) requires an existing ACTIVE catalog key for every genuine write, but returns early when
  the value is unchanged and defers when it is NULL, so a historical row whose key was later deactivated
  stays fully editable and every rejection that already existed keeps its own message and ordering; (2)
  the FK proves existence; (3) the three PL/pgSQL write paths that carried the literal
  `TEMPORARY/PERMANENT` closed set — `direct_entry_create_batch`, `direct_entry_create_draft_row` and
  `direct_entry_create_full_profile_batch` — were re-emitted with
  `direct_entry_is_active_labor_type(...)` in place of the literal set. An unknown or inactive key is a
  `23514` before any FK is consulted.
- Five canonical RPCs, mirroring the W01B Personnel shape exactly (no Team Leader or Team Membership
  topology, no nested mutations): `direct_entry_list_labor_types_admin`,
  `direct_entry_get_labor_type_admin`, `direct_entry_create_labor_type`,
  `direct_entry_update_labor_type`, `direct_entry_set_labor_type_active`. They reuse the single existing
  guard `direct_entry_assert_catalog_operator` (the legacy Full Admin triple or
  `catalog_master_manage`, both at effective `all` scope) before any payload is inspected, and define no
  second catalog guard. Every RPC is `SECURITY DEFINER` with `search_path = pg_catalog, public`, revoked
  from every role and granted to `service_role` only; the nine internal helpers stay at zero grants.
- Reporting cutover: `direct_entry_reporting_employment_key` becomes a catalog lookup of
  `reporting_key` (unknown key stays `__unknown__`), and the new
  `direct_entry_reporting_employment_display` is the single display lookup. The four duplicated
  `case ... 'Thời vụ' / 'Chính thức'` sites in `direct_entry_reporting_facts_v01`,
  `direct_entry_reporting_dimension_options_v01` and `direct_entry_reporting_de_options_scoped` now call
  that one function, so a rename can never make the dashboard and the actor-scoped views disagree.
- Canonical projection (D12): `direct_entry_input_catalog` now carries `labor_types` sourced from the
  bounded active projection (key, display_name, sort_order — never a reporting key, never an inactive
  row), so the Direct Entry runtime keeps receiving its active options through `getInputCatalog` and no
  parallel route exists. `write-repository.ts` accepts and strictly validates the new key, and it stays
  optional so a payload produced before the catalog existed still projects.
- Server layer, no UI: `labor-type-catalog-contract.ts` (fail-closed exact-key projections),
  `labor-type-catalog-repository.ts` (the five RPCs, SQLSTATE to sanitized kinds),
  `labor-type-catalog-api.ts` (feature gate, same-origin, bounded JSON, recursive client authority
  rejection, strict request projection, session-only actor, `no-store`, sanitized taxonomy) and three
  `/api/admin/catalog/labor-types` routes (collection GET/POST, `[laborTypeKey]` GET/PATCH,
  `[laborTypeKey]/active` POST). `/api/direct-entry/labor-types/**` was NOT created.
- Ledger bookkeeping: migration count 78 -> 79, every pinned ledger offset shifted by one (47 files),
  and the alias-backfill pre-hotfix tail list extended with #79, following the same convention as
  #66-#78. Lane `test:p3-1-w02c-labor-type-catalog` is registered exactly once in `package.json` and
  once in the `pnpm test` chain.
- Out of scope and untouched: password/invitation/MFA, Team Leader and Team Membership topology, every
  other catalog, W04 UI, T1A consumer/client alias maps, import resolver and grid options, and all
  Production state.

## Evidence

The focused lane `test:p3-1-w02c-labor-type-catalog` is 37/37 (21 PGlite DB tests + 16
API/repository tests) and is green again after the mutation pass.

- Ledger: exact #79 addition, #1-#78 byte-identical, and the worktree check that no earlier migration is
  modified, deleted or renamed.
- Seeds and immutability: the three canonical rows with the server-owned reporting keys, ordered by
  `sort_order` then key; a direct `UPDATE` of `labor_type_key` or `reporting_key` is `55000`.
- Authority: Full Admin and Accounting (both at effective `all` scope) can read and write;
  `entry_admin`-with-`all`-only, a project manager, staff, a disabled actor, an unmapped actor and a
  mismatched actor/subject pair are denied with `42501` from all five RPCs before any input is
  inspected, with zero residue.
- Mutations: create under OCC (`expected_version = 0`), display_name/sort_order update and set-active,
  each appending exactly one revision and one audit event and bumping the row version exactly once; a
  stale expected version is `40001`, a no-op update is `22023`, a duplicate key is `23505`, a
  non-canonical key and a non-zero create version are `22023`, an unknown key is `P0002`.
- Revision contract: both snapshots are six-key business snapshots, the bump helper stamps the
  after-snapshot with the version the row now carries (the W01B/W02-B convention), and the revision is
  filed at the bumped version.
- Active semantics: an inactive or unknown key cannot be written to a NEW entry (`23514`); an UPDATE
  that leaves `labor_type` untouched still succeeds on a row whose key was since deactivated, and the
  stored entry remains readable through the read projection, so inactive means "not choosable", never
  "unreadable".
- FK integrity: `direct_entries_labor_type_fkey` exists, is validated and is `RESTRICT` on both update
  and delete; deleting a referenced catalog row raises `23001` (PostgreSQL reports `ON DELETE RESTRICT`
  that way) and neither the row nor the entry is lost.
- Idempotency: an exact replay of create/update/set-active returns the stored result and writes no second
  revision; the same key with different input is a `22023` conflict.
- Strict projection: the admin row, list envelope, mutation row and create result carry exactly the
  documented key sets; the active options projection is bounded to key, display_name and sort_order; no
  payload carries `auth_subject`, email, capability/scope, app-user id, raw reason, grant id or storage
  data.
- Reporting: `TEMPORARY`/`PERMANENT`/`OUTSOURCED` map to `thời vụ`/`chính thức`/`gia công`, an unknown
  key stays `__unknown__` and `Không xác định`; renaming a display label changes what is shown without
  touching the stored key or the reporting key; the three view/function definitions no longer contain a
  duplicated label map.
- ACL/RLS: `service_role` is the only role that can execute the five RPCs; every internal helper is
  executable by no role; both new tables carry no grant to any role and are RLS + FORCE RLS; the
  revision table is immutable.
- Retired closed set and abort path: after a full migration there is no closed-set CHECK left on
  `direct_entries.labor_type`; applying #79 to a ledger whose entry carries an unresolvable legacy key
  aborts with `55000` and leaves no table behind.
- Extensibility proof: a fourth type (`PROBATION`/"Thử việc") created through the RPC alone — no source
  or migration change — is accepted by the API validator, persists the key, appears in the active
  projection with a server-generated lowercase `reporting_key`, and is offered by the Direct Entry input
  catalog; no member of the TS contract, request validators or projections carries a closed vocabulary.
- Mutation plan: M1-M9 below, each temporarily applied to the final tree and each turning a named test
  red, with the tree restored byte-identically.

### M1-M9 mutation plan (R2 §9, retained by R3 §12)

| # | Temporary mutation | Result |
|---|---|---|
| M1 | drop the `OUTSOURCED` seed row | RED |
| M2 | active projection returns only the two legacy keys | RED |
| M3 | an inactive key may be written to a new entry | RED |
| M4 | a historical row whose key was deactivated becomes uneditable | RED |
| M5 | the `OUTSOURCED` label implies a Vendor provider branch | RED |
| M6 | catalog authority re-opened to every caller | RED |
| M7 | an unknown key silently falls back to `TEMPORARY` | RED |
| M8 | hard-coded three-key vocabulary in the TS create validator | RED |
| M9 | duplicated hard-coded label map returns in the display lookup | RED |

- Gates: focused lane, `pnpm test`, `next typegen`, `tsc --noEmit`, `eslint`, `pnpm build`,
  `docs:check`, `secrets:check`, offline migration validation and `git diff --check` all pass.

## Follow-ups (not in this lane)

- T1A consumer cutover: grid/import/template options, filters, alias maps and fixtures read the new
  key list, and the client stops carrying a two-key vocabulary.
