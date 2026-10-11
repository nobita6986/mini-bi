# P3.1-W02-C R1 Labor type catalog backend, dynamic boundaries: P3_1_W02_C_R1_LABOR_TYPE_CATALOG_LOCAL_PASS_AWAITING_T0_REVIEW

Branch `feature/p3-1-w02c-labor-type-catalog`. Base `origin/main@5f41caf689dbfd52bb889744f227aa659da393db`
-> final (this commit). Fast-forward only; no Production query/apply/deploy, no browser or UAT work, no new
dependency, no merge of `main`.

**R1 correction.** The R2 handoff below claimed end-to-end dynamic behavior the tree did not have.
Migration #79 made the *database* dynamic, but every server and CLI boundary still accepted only the
retired `TEMPORARY | PERMANENT` pair, so a newly created key was rejected **before** the database
active-catalog guard was ever reached. The catalog was therefore not dynamic in practice, which is the
T0 blocker this revision closes. R1 changes source and tests only: no migration was added or amended
(#79 is byte-identical, there is no #80), no UI consumer was cut over, and the misleading claim is
withdrawn here. The dynamic UI consumer is the next lane, **T1A**.

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
  the FK proves existence; (3) the three PL/pgSQL write paths that still carried the literal
  `TEMPORARY/PERMANENT` closed set — `direct_entry_create_batch`,
  `direct_entry_create_draft_row` and `direct_entry_create_full_profile_batch` — are patched **in
  place**: the migration reads each live definition with `pg_get_functiondef`, requires the retired
  literal to appear exactly once, and re-executes the replaced definition. That is the same mechanism
  the later P1.7-H06, W07B, W07C-R2, W07C-R3 and P2.5-HF migrations already use on those same bodies.
  Re-emitting them from the original foundation source was explicitly rejected because it silently
  reverts every one of those later patches (the first implementation did exactly that and the
  P3-W07A-R3 vendor-upload lane caught it); source drift now aborts the migration with `55000`
  instead of dropping the guard, and replacing a definition preserves its ownership, ACL and
  volatility, so no grant is re-issued. An unknown or inactive key is a `23514` before any FK is
  consulted.
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
- Canonical projection (D12): the builder `direct_entry_input_catalog_unscoped_v42` now carries
  `labor_types` sourced from the bounded active projection (key, display_name, sort_order — never a
  reporting key, never an inactive row), so the Direct Entry runtime keeps receiving its active options
  through `getInputCatalog` and no parallel route exists. The `direct_entry_input_catalog` wrapper
  itself is **byte-untouched**, so W07B's per-actor project filter is exactly as it was written.
  `write-repository.ts` accepts and strictly validates the new key, and it stays optional so a payload
  produced before the catalog existed still projects. The two W07A-R2 catalog-contract locks (H1 and
  H6) were extended from the four locked top-level keys to five and now also assert that the three
  active options arrive through that projection.
- Server layer, no UI: `labor-type-catalog-contract.ts` (fail-closed exact-key projections),
  `labor-type-catalog-repository.ts` (the five RPCs, SQLSTATE to sanitized kinds),
  `labor-type-catalog-api.ts` (feature gate, same-origin, bounded JSON, recursive client authority
  rejection, strict request projection, session-only actor, `no-store`, sanitized taxonomy) and three
  `/api/admin/catalog/labor-types` routes (collection GET/POST, `[laborTypeKey]` GET/PATCH,
  `[laborTypeKey]/active` POST). `/api/direct-entry/labor-types/**` was NOT created.
- Ledger bookkeeping: migration count 78 -> 79, every pinned ledger offset shifted by one (48 files),
  the alias-backfill pre-hotfix tail list extended with #79, and the derived direct-entry function
  inventory moved from 194/89/105 to 209/95/114 (nine internal helpers plus six service-role
  functions), following the same convention as #66-#78. Lane
  `test:p3-1-w02c-labor-type-catalog` is registered exactly once in `package.json` and once in the
  `pnpm test` chain.
- Out of scope and untouched: password/invitation/MFA, Team Leader and Team Membership topology, every
  other catalog, W04 UI, T1A consumer/client alias maps, import resolver and grid options, and all
  Production state.

## R1 delta (dynamic boundaries)

**Blocker.** Migration #79 made the database own the labor-type vocabulary, but every server and CLI
acceptance site still carried the retired closed set `TEMPORARY | PERMANENT`. A key created through the
catalog RPC was therefore rejected by the backend **before** the database active-catalog guard ran, so the
catalog was dynamic only inside the database. Until this revision the honest status was "database dynamic,
backend closed", and R2's end-to-end claim was wrong.

**One shared predicate, no second vocabulary.** `src/lib/contracts/direct-entry-v1.ts` now defines the
single contract every other layer consumes: `LABOR_TYPE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/` (the
canonical key SHAPE), `type LaborType = string` (the key is no longer a union of literals) and
`isCanonicalLaborTypeKey(value): value is LaborType` (the one predicate every boundary calls).
`labor-type-catalog-contract.ts` re-exports all three — `LABOR_TYPE_KEY` is the pattern — so the admin API
and every other layer share exactly one definition. No server or CLI module defines a second copy: a
source-level test asserts none of the fifteen touched modules contains `"TEMPORARY" | "PERMANENT"` or
`["TEMPORARY", "PERMANENT"]`.

**Boundaries converted** (closed list to the shared shape predicate):

| Boundary | File |
|---|---|
| Batch write rows and the entry read projection | `write-api.ts` |
| Draft patch | `draft-api.ts` |
| Draft list projection | `draft-list-contract.ts` |
| Full-profile batch contract | `full-profile-batch.ts`, `full-profile-contract.ts` |
| Privileged edit patch | `privileged-edit-api.ts` |
| Change-request proposal contract | `change-request-contract.ts` |
| Change-request proposer | `change-request-proposer.ts`, `change-request-proposal-builders.ts` |
| Worker-directory read projection | `worker-directory-contract.ts` |
| Live controller view model | `live-controller.ts` |
| Excel/paste parser | `excel-paste.ts` |
| XLSX header normalizer | `worker-profile-xlsx.ts` |
| Worker-profile paste parser | `worker-profile-paste.ts` |
| T0 operator import preflight | `scripts/lib/t0-operator-import.mjs` |

The three alias tables (`LABOR_TYPE_ALIASES`, `LABOR_TYPE_KEY_BY_HEADER`, `LABOR_ALIASES`) stay — their
*content* is a T1A question — but each normalizer gained a canonical-key **passthrough**: a supplied value
that is already canonical is returned unchanged instead of being rejected, so a catalog key no alias table
has ever heard of still reaches the canonical RPC.

**The database decides, and it still fails closed.** No cache, no lookup table and no second guard was
added on the server: existence and active state remain the database's answer. A deactivated key and a
canonical key that has never existed are both `23514` at `direct_entry_labor_type_write_guard`, with no
entry, revision, audit or idempotency residue and no raw database message surfaced, while a stored row
keeps its key readable and editable.

**Evidence added by R1.** The new lane `src/lib/direct-entry/labor-type-catalog-dynamic.test.mjs` (19
tests) proves `PROBATION` at every boundary above and proves the legacy keys stay green; the DB lane
gained tests 22-24 covering the dynamic write plus entry read plus runtime catalog, the worker directory,
and deactivate-then-reject with zero residue. Negative fixtures that used to be "unknown but well-formed"
were retargeted to malformed keys, because a well-formed key is no longer this layer's business.

## Evidence

The focused lane `test:p3-1-w02c-labor-type-catalog` is 59/59 (24 PGlite DB tests + 16
API/repository tests + 19 dynamic-boundary tests) and is green again after the mutation pass.

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
  aborts with `55000` and leaves no table behind. A closing self-check asserts that **no**
  `direct_entry_*` function body still contains `TEMPORARY`, `PERMANENT`, "Thời vụ" or "Chính thức",
  so no write path and no display path can carry a second vocabulary.
- Scope of change, verified against the base commit: of the 197 direct-entry functions and views at
  base, exactly eight differ afterwards — the three write paths (`create_batch`,
  `create_draft_row`, `create_full_profile_batch`), the catalog builder
  (`input_catalog_unscoped_v42`), the reporting key lookup, the actor-scoped options projection and
  the two reporting views — and fifteen functions are added. Nothing in the database changes
  otherwise.
- **Nothing is re-emitted from a historical source.** The six functions and the two views are the
  *live* definitions patched in place, which is what makes every later migration's change survive.
  Re-emitting them from the foundation or cutover source was the first implementation and it silently
  reverted P1.7-H06 employee codes, W07B per-row project authority, W07C-R3 issue place, P2.5-HF
  status defaults and W07B per-actor project scope; the P3-W07A-R3 vendor-upload and P3-W07B
  project-scope lanes caught both regressions. The three write paths now differ from their live
  predecessors by exactly one line each.
- Extensibility proof (R1): a fourth type `PROBATION` created through the RPC alone — no source or
  migration change — now survives the *whole* backend, not just the database. A single shared predicate
  (`isCanonicalLaborTypeKey`, defined once in `contracts/direct-entry-v1.ts` and re-exported by
  `labor-type-catalog-contract.ts`) replaced the closed vocabulary at every server and CLI acceptance
  site; a new key is persisted, appears in the active projection with a server-generated lowercase
  `reporting_key`, and is accepted by the batch and direct-entry write validators, the draft patch and
  list projections, the full-profile batch contract, the privileged-edit patch, the change-request
  proposal contract and proposer, the worker-directory read projection, the T0 operator-import preflight
  and the Excel/Paste/XLSX normalizers, then returned by the entry read projection, the runtime input
  catalog and the worker directory. R2 asserted this without the source change and it was not true; see
  the R1 delta section below.
- Mutation plan: M1-M11 below, each temporarily applied to the final tree and each turning a named test
  red, with the tree restored byte-identically. M10 and M11 are the R1 additions: each reverts exactly
  one server/CLI boundary from the shared predicate back to the closed `TEMPORARY/PERMANENT` set.

### M1-M11 mutation plan (R2 §9, retained by R3 §12; M10-M11 added by R1)

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
| M10 | the batch read projection reverts to the closed `TEMPORARY/PERMANENT` set | RED |
| M11 | the T0 operator-import preflight reverts to the closed key set | RED |

- Gates: focused lane, the full `pnpm test` chain, `next typegen`, `tsc --noEmit`, `eslint`,
  `pnpm build` (the three labor-type routes compile), `docs:check`, `secrets:check`, offline
  migration validation and `git diff --check` all pass.

## Follow-ups (not in this lane)

- **T1A is the dynamic UI consumer, and it is the next lane.** Nothing in this revision changed a UI
  consumer. The backend now accepts any canonical key; the client still offers and labels the retired
  pair. T1A must read the active options from `getInputCatalog` instead of a literal list, drop the
  client-side two-key vocabulary, extend the grid/template/import aliases, and add the admin UI for the
  five catalog RPCs.

  The exact closed sets still in the tree — all presentation or alias content, none of them an acceptance
  decision on a server boundary:

  | Where | What |
  |---|---|
  | `direct-entry-grid-columns.ts:96` | grid labor-type options |
  | `worker-operations.tsx:793,818,1101,1220,1221` | filter, dropdown and label options |
  | `direct-entry-live.tsx:1261,1403,1515,2587,2591,2592` | default, options and labels |
  | `direct-entry-change-request-proposer.tsx:582,587,588` | proposal labor-type options |
  | `direct-entry-worker-profile-paste-dialog.tsx:134` | dialog option copy |
  | `live-controller.ts:102` | the `"TEMPORARY"` default for a new draft |
  | `change-request-reviewer.ts:63,64` | `LABOR_TYPE_LABELS` display map |
  | `excel-paste.ts:22-25` | `LABOR_TYPE_ALIASES` content |
  | `worker-profile-xlsx.ts:46,49-51` | `LABOR_TYPE_KEY_BY_HEADER` content |
  | `worker-profile-xlsx.ts:220,230` | template guide text |
  | `worker-profile-paste.ts:99-103,286` | `LABOR_ALIASES` content and copy |
  | `worker-profile-import-contract.ts:71,216` | `PASTE_LABOR_TYPE_INVALID` copy |
  | `excel-paste.ts:137` | import error copy |

  Every test fixture, DB test and acceptance script that still spells `TEMPORARY`/`PERMANENT` is
  deliberate legacy coverage and stays: those keys remain valid catalog rows, so the legacy paths must
  keep passing.
- Still out of scope for T1A and later: the Production ledger, deploy and UAT.
