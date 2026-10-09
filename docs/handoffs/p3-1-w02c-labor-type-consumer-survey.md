# P3.1-W02C-S0-R1 — Labor-type catalog and consumer impact survey

> **Status:** `P3_1_W02C_S0_R1_LABOR_TYPE_SURVEY_PASS_AWAITING_T0`
> **Base:** `origin/main@51fb221027d48272cb968ee9d7d98fe9d713f07c` (68 migrations; #68 = P3.1-W01B personnel catalog).
> R1 applies the T0 decisions taken after S0: a genuinely dynamic catalog, a hard foreign key, a runtime-parsed
> key contract, a catalog-owned reporting key, the Admin-API/DE-projection split, one import resolver, corrected
> historical semantics, an extensibility proof and a corrected allowed/denied matrix.
> Read-only design survey: no source, migration, API, dependency, UI or Production change; no browser/Playwright/CUA/UAT
> (Owner only); no Production query, apply or deploy.
> **Authority:** `docs/P3.1.md`, `docs/handoffs/p3-1-c01-catalog-policy-survey.md`, `docs/handoffs/p3-1-j00-security-regression-baseline.md`,
> `docs/handoffs/p3-1-w04-r0-admin-ui-reuse-survey.md`, `docs/handoffs/p3-1-w01a-capability-contract-foundation.md`,
> `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`. Where they and this survey differ, they win.

## 1. Current truth

### 1.1 Database vocabulary and enforcement

| # | Location | Fact |
|---|---|---|
| D1 | `20261002170000_p1_6_direct_entry_foundation.sql:220` | `direct_entries.labor_type text not null check (labor_type in ('TEMPORARY','PERMANENT'))` — the only storage-level vocabulary. A third key is rejected today. |
| D2 | same file `:1291`, `:1445`, `:1616` | Entry create / full-profile path / patch apply re-check the closed set in PL/pgSQL, so removing the CHECK alone is not enough. |
| D3 | same file `:2751`-`:2779`, `:3029`-`:3083` | Change-request apply and privileged patch accept `labor_type` through a field whitelist and assign it directly — they inherit D1 but add no vocabulary of their own. |
| D4 | `20261005060000_p1_6_i04c3_full_profile_server_foundation.sql:350`, `:408`, `:451` | Full-profile batch create: row whitelist plus a closed-set test on the parsed value. |
| D5 | `20261002170000...:1077`, `:3161`; `20261005060000...:140`, `:245` | Entry projections return `labor_type` verbatim (no label) — the API/DB boundary is key-based and stays so. |
| D6 | `20261007020000_p2_w04a_direct_entry_reporting_cutover.sql:225`-`:237` | `direct_entry_reporting_employment_key(text)` — immutable, security invoker, `search_path = pg_catalog`, revoked from public/anon/authenticated, execute only for service_role. It maps the two legacy keys to `'thời vụ'`/`'chính thức'` and everything else to `'__unknown__'`. |
| D7 | same file `:289`-`:293`, `:502`-`:505`; `20261008080000_p3_w05a_actor_scoped_reporting.sql:519`-`:535` | The **display** mapping is duplicated at four sites, two of them inside the W05A actor-scoped reporting views and group-bys. |
| D8 | `20261001140000_p0_r1_envelope_schema_and_catalogs.sql:68`, `:141` | The retired ingestion path keeps its own employment key/display mapping over the same `'thời vụ'`/`'chính thức'` vocabulary. Two SQL vocabularies already exist and must not diverge further. |
| D9 | `20261009040000_p3_1_w01b_personnel_catalog.sql:69`-`:118` | `direct_entry_assert_catalog_operator(auth, app)` **already exists on main**: actor mapping first, then (legacy Full-Admin triple **or** `catalog_master_manage`), then an effective `all` scope grant; it returns the *exercised* authority for audit and is revoked from every role. This is the guard W02C must call, before any payload validation. |
| D10 | `20261009040000...:33`-`:64`, `:200`-`:265` | The W01B catalog shape to mirror: append-only revisions with a unique version pair, immutability trigger, RLS enabled and forced, revoked from every role; an audit reference on the revision; lock/snapshot/write-revision/bump-version helpers. |
| D11 | `src/app/api/admin/catalog/personnel/route.ts`, `.../personnel/[recruiterId]/route.ts`, `.../personnel/[recruiterId]/active/route.ts`; `src/lib/direct-entry/personnel-catalog-{contract,api,repository}.ts` | The Admin catalog API convention W02C must mirror: one collection route, one item route, one set-active route, plus contract/api/repository modules. |
| D12 | `src/app/api/direct-entry/catalog/route.ts` -> `getInputCatalog` -> the draft catalog projection (`projects`/`recruiters`/`banks`) and its response projector | The **only** runtime catalog route for Direct Entry. Active labor-type options must join this projection; a second labor-type route would be a parallel source of truth. |

### 1.2 TypeScript unions, validators, options and label maps

| # | File:symbol | Fact |
|---|---|---|
| T1 | `src/lib/contracts/direct-entry-v1.ts:20`, `:520` | The `LaborType` union and the `LABOR_TYPE_INVALID` validator both encode the closed pair as a type-level truth. |
| T2 | `src/lib/direct-entry/change-request-contract.ts:63`, `:262`-`:265` | Closed set for change-request items. |
| T3 | `src/lib/direct-entry/privileged-edit-api.ts:20`, `:73`-`:74` | Closed set for the privileged-edit patch. |
| T4 | `src/lib/direct-entry/write-api.ts:106`-`112`, `:238`, `:328` | Entry create and batch validators repeat the set. |
| T5 | `src/lib/direct-entry/draft-api.ts:35`, `:82`; `draft-list-contract.ts:57`, `:104` | Draft patch and draft list repeat it. |
| T6 | `src/lib/direct-entry/full-profile-contract.ts:43`, `:324`, `:356`; `full-profile-batch.ts:65`, `:195` | Full-profile paste contract repeats it. |
| T7 | `src/lib/direct-entry/worker-directory-contract.ts:166`, `:274` | Worker directory row projector rejects anything outside the pair. |
| T8 | `src/lib/direct-entry/change-request-proposer.ts:40`, `:48`, `:101`; `change-request-proposal-builders.ts:91`, `:147`, `:222`; `change-request-read-contract.ts:231`, `:240` | Proposer field list, proposal baseline type and read-projection key list. |
| T9 | `src/lib/direct-entry/live-controller.ts:9`, `:65`, `:101`, `:139`, `:152`, `:188` | Live draft controller types and diff. |
| T10 | `src/lib/direct-entry/direct-entry-grid-columns.ts:93`-`102`, `:215` | The grid option list is a two-element list of **display labels**, not keys. |
| T11 | `src/lib/direct-entry/ui-model.ts:8`, `:34`, `:44`, `:54` | Legacy pilot model is typed on a **third** label vocabulary. |
| T12 | `src/lib/direct-entry/change-request-reviewer.ts:62`-`:63`; `direct-entry-excel-paste-dialog.tsx:34` | Key-to-label maps for the change-request reviewer and the Excel paste preview. |
| T13 | `src/components/direct-entry/worker-operations.tsx:1102`, `:1221`-`:1222` | Inline key-to-label for the directory row, plus a privileged-edit select whose option values are keys. |
| T14 | `src/components/direct-entry/direct-entry-change-request-proposer.tsx:587` | Proposer select with key values and hard-coded labels. |
| T15 | `src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx:134` | Key-to-label preview that renders the permanent key as a different legacy label than T12/T13. |
| T16 | `src/components/direct-entry/direct-entry-shell.tsx:145`, `:262` | Retired demo shell still carries the legacy long-form label. |

### 1.3 Display-label comparisons instead of the stable key (the defect class)

| # | File:line | Current shape | Why it is unsafe |
|---|---|---|---|
| L1 | `direct-entry-live.tsx:1338` | `safePatch.labor_type === "Chính thức" ? "PERMANENT" : "TEMPORARY"` | **Label-to-key inversion.** Any label that is not exactly that string silently becomes the temporary key, so a fourth value would be written as temporary labour. |
| L2 | `direct-entry-live.tsx:2212`-`2213`, `:2407`-`2411` | Label-valued `option` elements on the mobile staged and quick-edit selects | The select **value is the label**; the key exists only as a UI string. |
| L3 | `direct-entry-live.tsx:2521`-`2526` | Quick editor with key-valued options | Same field, different contract from L2 — the two paths disagree today. |
| L4 | `direct-entry-spreadsheet-grid.tsx:176`, `:189`; `direct-entry-grid-columns.ts:99` | Dropdown options come from the label list; the cell text is the label | The grid draft stores labels; conversion happens only at L1. |
| L5 | `direct-entry-live.tsx:1196`, `:1450`; `worker-operations.tsx:1102`; `direct-entry-worker-profile-paste-dialog.tsx:134`; `direct-entry-change-request-reviewer.tsx:116` | Binary `key ? labelA : labelB` renderers | Any additional key falls into the `else` branch and is mislabelled. |
| L6 | `worker-profile-xlsx.ts:47`-`51`; `worker-profile-paste.ts:98`-`104`; `excel-paste.ts:20`-`25` | Three independent label/alias maps | They already disagree; adding a value means editing all three and a missed one mis-maps silently. |
| L7 | `worker-profile-xlsx.ts:219` | Template data validation hard-codes the two labels | A downloadable template would not offer any newly added value. |
| L8 | `direct-entry-live.tsx:1196`, `:1450`; `worker-profile-import-contract.ts:216`; `excel-paste.ts:128` | Error/help copy names only two types | Copy must come from the catalog or it lies as soon as the catalog grows. |

### 1.4 Consumer surfaces

| Area | Consumers |
|---|---|
| Direct Entry grid | `direct-entry-spreadsheet-grid.tsx`, `direct-entry-grid-columns.ts:215`, grid validation fixtures |
| Quick add / mobile staged / quick editor | `direct-entry-live.tsx:1196`, `:2209`, `:2407`, `:2521` |
| Full-profile batch and paste preview | `full-profile-contract.ts`, `full-profile-batch.ts`, `direct-entry-worker-profile-paste-dialog.tsx:134`, `worker-profile-paste.ts`, `worker-profile-import-contract.ts` |
| Privileged edit | `privileged-edit-api.ts`, `worker-operations.tsx:1221`, the worker full-correction DB test |
| Change requests | `change-request-proposer.ts`, `change-request-contract.ts`, `change-request-proposal-builders.ts`, `change-request-read-contract.ts`, `change-request-reviewer.ts`, `direct-entry-change-request-proposer.tsx:587` |
| Excel/CSV paste, import, template | `excel-paste.ts`, `excel-paste-import.ts`, `worker-profile-xlsx.ts`, `direct-entry-excel-paste-dialog.tsx:34` |
| T0 bulk importer | `scripts/lib/t0-operator-import.mjs:30`, `:256`-`257`, `:317`, `:336`, `:621`, `:665` |
| Worker directory and entry APIs | `worker-directory-contract.ts:274`; entry projections D5 |
| Reporting dimensions and filters | SQL D6/D7; `reporting/p1-dashboard.ts:83`-`96`, `p1-reporting.ts`, `p1-reporting-server.ts`, `p1-reporting-pagination.ts`, `p2-w04a-cutover.ts`, `contracts/daily-recruitment-breakdown.ts:34`, `:47`-`49`, `:147`-`159`, `pipeline-check*.ts`, `dashboard-filters.tsx:18`, `:125` |
| Reporting fixtures and contracts | `docs/contracts/fixtures/p1-reporting/*.json`, `docs/contracts/fixtures/daily-recruitment-breakdown/*.json`, `docs/contracts/daily-recruitment-breakdown-v0.2.md:27`, `:55`, `:179`-`180`, `:241`, `scripts/check-daily-recruitment-fixtures.mjs:181`, `:235`, `:286`, `:332` |
| Deferred / out of scope | AI report engine employment consumers (flags stay off in P3.1) and the retired ingestion vocabulary D8 |

### 1.5 Tests and fixtures that encode the two-value set

`direct-entry-spreadsheet-dropdown-regression.test.mjs:161`, `:356`, `:362`, `:465`, `:517` · `direct-entry-grid-validation.test.mjs:65`-`163` · `worker-profile-xlsx.test.mjs:79`, `:108`, `:167`, `:201`, `:217`, `:250`, `:280` · `excel-paste.test.mjs` · `excel-paste-import.test.mjs` · `worker-profile-paste.test.mjs:104`-`106` · `full-profile-batch.test.mjs` · `banking-metadata.test.mjs` · `change-request-*.test.mjs` · `privileged-edit.test.mjs` · `p2-5-hf-r3-worker-full-correction-db.test.mjs` · `t0-import-workers.test.mjs` · `src/lib/reporting/p1-reporting.test.mjs:16` · `p1-chart-data.test.mjs:69` · `p2-w04a-acceptance.test.mjs:917`-`918` · `p1.6-w03-db.test.mjs` · `p1.6-w03-g3-dev-acceptance.mjs`.

## 2. Locked target contract (T0 R1)

1. **The catalog is genuinely dynamic.** `TEMPORARY`, `PERMANENT` and `OUTSOURCED` are **three seed rows only**, never a permanent closed set. Admin/Accounting must be able to add a fourth type from the Admin UI **without any code or migration change**.
2. **Key.** Entered by the operator and canonical by `^[A-Z][A-Z0-9_]{0,63}$`; case-sensitive; stored exactly as entered after canonical validation.
3. **Immutability and editability.** The key is immutable after create. `display_name`, `sort_order` and `active` are editable through reason + expected version + idempotency + revision + immutable audit. No hard delete exists.
4. **Storage integrity (hard FK).** `direct_entries.labor_type` references `direct_entry_labor_types.labor_type_key` with `ON UPDATE RESTRICT, ON DELETE RESTRICT`. The FK guarantees the key *exists*; a separate active-write guard guarantees the key is *active*. Historical rows stay readable precisely because a catalog row can never be deleted.
5. **Explicitly rejected storage designs:** a static three-key CHECK, a hand-written pseudo-FK trigger, and projection-only validation with no constraint.
6. **TypeScript contract.** No three-literal union as the source of truth. The contract exposes a `LaborTypeKey` (canonical string parsed at runtime); shape validation checks only the canonical format, while **write authority requires the key to be present in the server-provided active catalog projection**. Validators, UI and import take that projection as a dependency; historical reads accept key + display from the projection and must not fail merely because the key is inactive.
7. **Reporting.** The outsourced key gets its **own** dimension key `gia công` with initial display `Gia công`; `TEMPORARY` stays `thời vụ` and `PERMANENT` stays `chính thức`; anything unknown keeps the existing fail-closed fallback.
8. **`reporting_key` lives in the catalog** and is immutable: unique and non-empty. The three seeds use the three mappings in (7). A newly created type receives a **server-generated** `reporting_key` derived from the canonical labor-type key as lowercase ASCII (for example `PROBATION` -> `probation`). Renaming a display label never changes `reporting_key`, and a client may never send or override it.
9. **Guard.** Every catalog mutation and admin read runs `direct_entry_assert_catalog_operator` (D9) **before** payload validation; Admin (legacy triple) and Accounting (`catalog_master_manage`) both pass, all other actors are denied.
10. **Writes.** An unknown key fails shape validation; an inactive key is rejected for every new write (entry create, draft patch, full-profile batch, change-request item, privileged patch, import and template).
11. **Independence.** The value carries no provider, Vendor or team meaning: choosing the outsourced type must never imply one.
12. **No historical rewrite.** No update of existing entry values and no remapping of existing reporting keys.

## 3. Recommended backend shape

| Object | Shape |
|---|---|
| Catalog table | `direct_entry_labor_types(labor_type_key text primary key check (labor_type_key ~ '^[A-Z][A-Z0-9_]{0,63}$'), display_name text not null, reporting_key text not null unique, sort_order integer not null, active boolean not null default true, version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`. Key and `reporting_key` are immutable; the rest is versioned. |
| Revision table | Append-only revisions keyed uniquely by (key, version), carrying actor and reason references plus before/after snapshots, an immutability trigger, RLS enabled **and forced**, and revoked from every role; the audit table gains the matching revision reference (mirrors D10). |
| Foreign key | `direct_entries.labor_type` -> `direct_entry_labor_types.labor_type_key`, `ON UPDATE RESTRICT, ON DELETE RESTRICT`. |
| Migration order (one transaction) | (a) create the catalog; (b) seed the three initial rows; (c) verify every existing `direct_entries.labor_type` resolves to a catalog row and abort otherwise; (d) drop the old closed-set CHECK; (e) add and validate the FK; (f) replace every PL/pgSQL closed-set test (D2, D4) with a lookup against the **active** catalog. Steps (c) and (e) make the switch provable: a value that does not resolve aborts the migration instead of being orphaned. |
| Active projection | One bounded function returning only key, display name and sort order for active rows ordered by sort order then key; plus an admin projection adding active flag, version and `reporting_key`. Direct Entry, import/template, filters and reporting all resolve labels from these projections — no consumer keeps a private label map. |
| RPCs | List (admin, includes inactive), get (admin), create, update (display name and sort order), set-active. Each takes expected version (0 on create), a required reason and an idempotency key, and returns the bounded row plus the new version; `reporting_key` is generated server-side on create and is never an input. |
| Reporting lookup | `direct_entry_reporting_employment_key` becomes a catalog lookup of `reporting_key`; the four duplicated display sites (D7) are replaced by a join on `display_name`, so no CASE or label map remains. Renaming a label changes what is displayed today; `reporting_key` and stored labor-type keys never change. The unknown fallback stays fail-closed for a key that is absent from the catalog (defensive only — the FK should prevent it). |
| ACL / RLS / search_path | Security definer with an explicit `pg_catalog, public` search path; helpers revoked from public/anon/authenticated/service_role; execute granted only on the public RPCs to the service role; no table grant to any role. |
| Migration sequencing | One cohesive, replay-safe migration appended after the current head; T0 allocates the slot and this survey deliberately reserves no number. The catalog must not be bundled into a capability or personnel migration. |
| No new dependency | Everything reuses existing objects (restricted reasons, RPC idempotency helpers, audit events, the shared immutability trigger). No ORM, no new framework, no new library. |

## 4. Consumer cutover matrix

| Consumer | Current source | Required change | Active-write behavior | Historical-read behavior | Test to add | Blast radius |
|---|---|---|---|---|---|---|
| `contracts/direct-entry-v1.ts` union + validator | closed pair as a type | replace with runtime-parsed `LaborTypeKey`: canonical-format shape check only; write checks the active projection | unknown rejected by shape; inactive rejected by the authoritative projection | accepts any stored key and renders its catalog display name | contract unit + validator cases | **high** — every consumer imports it |
| `write-api.ts`, `draft-api.ts`, `draft-list-contract.ts` | inline pair checks | validate against the active catalog projection supplied by the server | unknown/inactive rejected | — | API unit + route tests | high |
| `privileged-edit-api.ts` | inline pair | same | rejected | — | privileged-edit unit + DB test | medium |
| `full-profile-contract.ts`, `full-profile-batch.ts` | inline pair | same | rejected | — | full-profile batch tests | medium |
| `change-request-{contract,proposer,proposal-builders,read-contract}.ts` | inline pair | same | rejected | an old request still renders; applying it as a new write rejects an inactive key | change-request unit + DB tests | medium |
| `worker-directory-contract.ts` | pair validator | accept any catalog key and resolve display from the projection | read path only | inactive key renders the current catalog display name | directory contract test | low |
| `direct-entry-grid-columns.ts`, `direct-entry-spreadsheet-grid.tsx` | label options | options come from the active projection as key + display; the cell stores the **key** | inactive values absent from new selections | existing rows render the catalog display name | dropdown regression | **high** — primary entry surface |
| `direct-entry-live.tsx` (L1-L5) | inversion, binary renderers, mixed select contracts | delete the inversion; one key-based select on every path, labels only for display | invalid key rejected | renders the catalog display name | interaction regressions for grid, quick add, mobile staged | **high** |
| `worker-operations.tsx`, `direct-entry-worker-profile-paste-dialog.tsx`, `direct-entry-change-request-reviewer.tsx`, `direct-entry-excel-paste-dialog.tsx`, `change-request-reviewer.ts` | inline or local label maps | consume one shared projection-backed lookup | render only | inactive key renders its catalog display name; unknown key renders a neutral placeholder | source + unit tests | medium |
| Import/paste surface (`excel-paste.ts`, `excel-paste-import.ts`, `worker-profile-paste.ts`, `worker-profile-import-contract.ts`, `worker-profile-xlsx.ts`) | three alias maps + copy + hard-coded template list | **one resolver** fed by (a) canonical key, (b) current active display label, (c) centrally maintained legacy aliases; template list and copy built from the active projection | alias resolves to a key only when that key is active; persisted value is always the key | — | paste/import/template tests | **high** — three copies must converge |
| `scripts/lib/t0-operator-import.mjs` | own closed set + upper-casing | validate through the same resolver; keep the preflight denial on unresolved values | unknown/inactive rejected in dry-run | — | importer dry-run/apply test | medium (T0 lane) |
| SQL reporting mapping + four display sites | pair + duplicated CASE | catalog `reporting_key` lookup + `display_name` join | — | stored keys unchanged | DB reporting test | **high** — four duplicated sites |
| `reporting/p1-dashboard.ts`, `contracts/daily-recruitment-breakdown.ts`, `ai-report/report-export-server.ts`, `dashboard-filters.tsx` | fixed four-value lists | derive options from the catalog projection instead of a literal list | — | — | reporting and filter tests | medium |
| Fixtures and contracts (1.5) | two-value expectations | extend with a dynamic-key case and keep the legacy pair green | — | historical rows still resolve | fixture/contract updates | medium |

## 5. Allowed / denied matrix

| Surface | Full Admin | Accounting (catalog operator) | Team leader | Project manager | Ordinary staff | Disabled / unmapped actor |
|---|---|---|---|---|---|---|
| Admin catalog API (list/get/create/update/set-active) | **allow** (legitimate request, legacy triple + all scope) | **allow** (legitimate request, catalog operator + all scope) | deny | deny | deny | deny (mapping first) |
| Read active labor types (entry, import, filter, display) | allow | allow | allow | allow | allow | deny |
| Read the catalog including inactive rows | allow | allow | deny | deny | deny | deny |
| Direct URL/API call with **no** catalog authority | server denial, no data, no field hints | server denial | server denial | server denial | server denial | server denial (mapping first) |
| Write an **unknown** key to a new entry | reject | reject | reject | reject | reject | reject |
| Write an **inactive** key to a new entry | reject | reject | reject | reject | reject | reject |
| Read or render a row whose key is now inactive | allow | allow | allow (own operational scope) | allow | allow | deny |
| Re-activate a previously deactivated key | allow | allow | deny | deny | deny | deny |
| Change an existing key or `reporting_key` | never (immutable) | never | never | never | never | never |
| Hard-delete a key | never (no such RPC) | never | never | never | never | never |
| Infer Vendor, provider or team from the value | **never** | never | never | never | never | never |
| Manage accounts, grants or links | allow | **deny** | deny | deny | deny | deny |

The unauthorized-call row applies **only** to actors without catalog authority; Full Admin and Accounting making a legitimate request are explicitly **not** a denial. In every case the guard runs before payload validation, so a denied actor learns nothing about the payload shape.

## 6. Mutation-check plan (each temporary change must turn a named test red)

| # | Temporary mutation | Expected red test |
|---|---|---|
| M1 | Remove the outsourced seed from the catalog while clients still offer it | catalog test + Direct Entry create with that key |
| M2 | Keep the client hard-coded to two types (grid options or select) | dropdown regression + grid validation test |
| M3 | Allow an inactive key to be written to a new entry | active-write rejection test |
| M4 | Make a historical inactive key unreadable (filter it out of the read projection) | historical-read test on a deactivated key |
| M5 | Make the outsourced display label imply Vendor (any provider/team branch on the label) | independence test: provider type and team stay unchanged |
| M6 | Re-open Accounting to account, grant or link operations | allowed/denied DB test for Accounting |
| M7 | Silently accept an unknown key (fallback to the temporary key) | unknown-key rejection test — the current inversion (L1) is exactly this defect |
| M8 | Reintroduce a hard-coded three-key vocabulary anywhere in the TS contract, validators, grid options or import resolver | the extensibility proof in section 7 must go red |

## 7. Mandatory extensibility proof (section 8 of the T0 decision)

Add a DB/API test that creates a fourth type **through the RPC**, with no source or migration change: key `PROBATION`, display `Thử việc`, and then asserts:

1. the RPC create succeeds under Admin **and** Accounting, and returns the new row with a server-generated `reporting_key` (`probation`) the client never supplied;
2. the row appears in the active projection, and both the entry catalog projection (D12) and the grid/import/template options offer it **without editing any source vocabulary**;
3. Direct Entry create, change request, paste and import all accept `PROBATION` and persist the **key**;
4. after `set-active(false)` the value disappears from every new-write choice and every new write with it is rejected, while existing rows remain readable;
5. a historical row carrying `PROBATION` still renders with the catalog display name, and still does so after the display label is renamed;
6. re-activating the key restores it to the new-write choices and to the reporting dimension;
7. nothing about `provider_type`, Vendor membership or team attribution changes for any row in the test.

## 8. Implementation map

**W02C — backend (owns the storage contract; W04 must never have to re-open it)**

| Action | File / object |
|---|---|
| add | new migration: catalog table (with `reporting_key`), revisions table, audit reference, three seeds, the resolve-and-verify step, drop of the old CHECK, the FK, and the replacement of every PL/pgSQL closed set with an active-catalog lookup |
| add | RPCs: list (admin), get (admin), create, update, set-active, the active and admin projections, and the revision/bump helpers (mirroring D10) |
| add | admin API mirroring D11: `/api/admin/catalog/labor-types`, `/api/admin/catalog/labor-types/[laborTypeKey]`, `/api/admin/catalog/labor-types/[laborTypeKey]/active` |
| edit | the existing Direct Entry catalog projection and its route handler (D12) to include active labor-type options; **no** parallel `/api/direct-entry/labor-types/**` source of truth |
| edit | `direct_entry_reporting_employment_key` -> `reporting_key` lookup, and the four duplicated display sites -> `display_name` join |
| add | `src/lib/direct-entry/labor-type-catalog-{contract,api,repository}.ts` (mirroring the personnel catalog modules) |
| add | DB tests: catalog CRUD and history, key/reporting_key immutability, FK integrity, active-write rejection, historical inactive read, independence from provider/team, Admin/Accounting allow + leader/PM/staff deny, and the section 7 proof |

**W04 — consumer cutover (key-based and projection-driven; UI interaction only)**

| Action | File / symbol |
|---|---|
| edit | `src/lib/contracts/direct-entry-v1.ts` (`LaborTypeKey`, runtime parse), `write-api.ts`, `draft-api.ts`, `draft-list-contract.ts`, `privileged-edit-api.ts`, `full-profile-contract.ts`, `full-profile-batch.ts`, `worker-directory-contract.ts`, `change-request-*.ts` — all take the active projection as a dependency |
| edit | `direct-entry-grid-columns.ts`, `direct-entry-spreadsheet-grid.tsx` — options from the projection, cell stores the key |
| edit | `direct-entry-live.tsx` — remove the label-to-key inversion and unify the three select paths on keys |
| edit | one shared label lookup for `worker-operations.tsx`, `direct-entry-change-request-proposer.tsx`, `direct-entry-change-request-reviewer.tsx`, `change-request-reviewer.ts`, `direct-entry-worker-profile-paste-dialog.tsx`, `direct-entry-excel-paste-dialog.tsx` |
| edit | one import resolver for `excel-paste.ts`, `excel-paste-import.ts`, `worker-profile-paste.ts`, `worker-profile-import-contract.ts`, `worker-profile-xlsx.ts` |
| edit | reporting/filter option lists to read the catalog instead of a literal list |
| edit | the tests and fixtures in 1.5 (extend them; keep the legacy pair green) |
| keep | the Admin UI entry point stays the `/admin/catalog/labor-types` section from the W04-R0 survey; no new navigation model, no new dependency, no new form or grid framework |

## 9. Boundary, decisions recorded and remaining risks

- **Boundary:** design only. No source, migration, API, dependency, route or UI change; `docs/P3.1.md`, `package.json` and every source file are untouched. No Production query, apply or deploy; no browser, CUA, screenshot or UAT.
- **Decisions recorded from this round:** dynamic catalog with three seeds only; canonical operator-entered key; hard FK with restrict semantics; runtime-parsed `LaborTypeKey` with projection-backed write authority; catalog-owned immutable `reporting_key` with the outsourced dimension key `gia công`; Admin API under `/api/admin/catalog/labor-types` with the operational options folded into the existing Direct Entry projection; one import resolver; historical display via the current catalog row; corrected allowed/denied matrix.
- **Risk — duplicated label logic (L4, L6).** Several label or alias maps already disagree; the cutover must collapse them into one projection-backed lookup plus one resolver, or a new value will be mis-mapped somewhere.
- **Risk — binary renderers (L5).** Every binary key-to-label site needs an explicit catalog lookup with a neutral fallback.
- **Risk — reporting duplication (D7).** Four mapping sites across two migrations; a partial update would make the dashboard and the actor-scoped views disagree.
- **Risk — rename semantics.** Because display names are catalog-driven, renaming a label changes current display everywhere while `reporting_key` and stored keys stay stable. This is intended and must be stated in the W04 acceptance criteria so a rename is not mistaken for a data change.
- **Risk — FK plus seed ordering.** The migration must verify that every existing value resolves before the FK is validated, otherwise a legacy value would abort the switch; the recommended order handles this in one transaction.
- **Deferred:** AI report surfaces (flags off in P3.1), the retired ingestion vocabulary (D8), any labor-type-driven reporting feature not already listed, and Owner browser UAT.
