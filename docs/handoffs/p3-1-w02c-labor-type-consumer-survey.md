# P3.1-W02C-S0 — Labor-type catalog and consumer impact survey

> **Status:** `P3_1_W02C_S0_LABOR_TYPE_SURVEY_PASS_AWAITING_T0`
> **Base:** `origin/main@51fb221027d48272cb968ee9d7d98fe9d713f07c` (68 migrations; #68 = P3.1-W01B personnel catalog).
> Read-only design survey: no source, migration, API, dependency, UI or Production change; no browser/Playwright/
> CUA/UAT (Owner only); no Production query, apply or deploy.
> **Authority:** `docs/P3.1.md`, `docs/handoffs/p3-1-c01-catalog-policy-survey.md`, `docs/handoffs/p3-1-j00-security-regression-baseline.md`,
> `docs/handoffs/p3-1-w04-r0-admin-ui-reuse-survey.md`, `docs/handoffs/p3-1-w01a-capability-contract-foundation.md`,
> `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`. Where they and this survey differ, they win.

## 1. Current truth

### 1.1 Database vocabulary and enforcement

| # | Location | Fact |
|---|---|---|
| D1 | `20261002170000_p1_6_direct_entry_foundation.sql:220` | `direct_entries.labor_type text not null check (labor_type in ('TEMPORARY','PERMANENT'))` — the only storage-level vocabulary. `OUTSOURCED` is rejected today. |
| D2 | same file `:1291`, `:1445`, `:1616` | Entry create / full-profile path / patch apply re-check the closed set in PL/pgSQL, so widening the CHECK alone is not enough. |
| D3 | same file `:2751`-`:2779`, `:3029`-`:3083` | Change-request apply and privileged patch accept `labor_type` through a field whitelist and assign it directly — they inherit D1 but add no vocabulary of their own. |
| D4 | `20261005060000_p1_6_i04c3_full_profile_server_foundation.sql:350`, `:408`, `:451` | Full-profile batch create: row whitelist + a closed-set test on the parsed value. |
| D5 | `20261002170000...:1077`, `:3161`; `20261005060000...:140`, `:245` | Entry projections return `labor_type` verbatim (no label) — the API/DB boundary is key-based and stays so. |
| D6 | `20261007020000_p2_w04a_direct_entry_reporting_cutover.sql:225`-`:237` | `direct_entry_reporting_employment_key(text)` — immutable, security invoker, `search_path = pg_catalog`, revoked from public/anon/authenticated, execute only for service_role. Maps the two legacy keys to `'thời vụ'`/`'chính thức'`, anything else to `'__unknown__'`. |
| D7 | same file `:289`-`:293`, `:502`-`:505`; `20261008080000_p3_w05a_actor_scoped_reporting.sql:519`-`:535` | The **display** mapping (`Thời vụ` / `Chính thức` / `Không xác định`) is duplicated at four sites, two of them inside the W05A actor-scoped reporting views and group-bys. |
| D8 | `20261001140000_p0_r1_envelope_schema_and_catalogs.sql:68`, `:141` | The retired ingestion path has its own employment key/display mapping over the same `'thời vụ'`/`'chính thức'` vocabulary. Two SQL vocabularies already exist and must not diverge further. |
| D9 | `20261009040000_p3_1_w01b_personnel_catalog.sql:69`-`:118` | `direct_entry_assert_catalog_operator(auth, app)` **already exists on main**: actor mapping first, then (legacy Full-Admin triple **or** `catalog_master_manage`), then an effective `all` scope grant; returns the *exercised* authority for audit; revoked from every role. This is the guard W02C must call. |
| D10 | `20261009040000...:33`-`:64`, `:200`-`:265` | The W01B catalog shape is the house pattern to mirror: append-only `<entity>_revisions` with a unique `(entity_id, version)`, immutability trigger, RLS forced, revoked from every role; `direct_entry_audit_events.<entity>_revision_id` FK; lock/snapshot/write-revision/bump-version helpers. |

### 1.2 TypeScript unions, validators, options and label maps

| # | File:symbol | Fact |
|---|---|---|
| T1 | `src/lib/contracts/direct-entry-v1.ts:20`, `:520` | The `LaborType` union and the `LABOR_TYPE_INVALID` validator both repeat the closed pair. |
| T2 | `src/lib/direct-entry/change-request-contract.ts:63`, `:262`-`:265` | Closed set for change-request items. |
| T3 | `src/lib/direct-entry/privileged-edit-api.ts:20`, `:73`-`:74` | Closed set for the privileged-edit patch. |
| T4 | `src/lib/direct-entry/write-api.ts:106`-`112`, `:238`, `:328` | Entry create + batch validators repeat the set. |
| T5 | `src/lib/direct-entry/draft-api.ts:35`, `:82`; `draft-list-contract.ts:57`, `:104` | Draft patch and draft list repeat it. |
| T6 | `src/lib/direct-entry/full-profile-contract.ts:43`, `:324`, `:356`; `full-profile-batch.ts:65`, `:195` | Full-profile paste contract repeats it. |
| T7 | `src/lib/direct-entry/worker-directory-contract.ts:166`, `:274` | Worker directory row projector rejects anything outside the pair. |
| T8 | `src/lib/direct-entry/change-request-proposer.ts:40`, `:48`, `:101`; `change-request-proposal-builders.ts:91`, `:147`, `:222`; `change-request-read-contract.ts:231`, `:240` | Proposer field list, proposal baseline type and read-projection key list. |
| T9 | `src/lib/direct-entry/live-controller.ts:9`, `:65`, `:101`, `:139`, `:152`, `:188` | Live draft controller types and diff. |
| T10 | `src/lib/direct-entry/direct-entry-grid-columns.ts:93`-`102`, `:215` | `DIRECT_ENTRY_LABOR_TYPE_OPTIONS` is a two-element list of **display labels**, not keys. |
| T11 | `src/lib/direct-entry/ui-model.ts:8`, `:34`, `:44`, `:54` | Legacy pilot model is typed on a **third** label vocabulary (`Toàn thời gian` / `Thời vụ`). |
| T12 | `src/lib/direct-entry/change-request-reviewer.ts:62`-`:63`; `direct-entry-excel-paste-dialog.tsx:34` | Key-to-label maps for the change-request reviewer and the Excel paste preview. |
| T13 | `src/components/direct-entry/worker-operations.tsx:1102`, `:1221`-`:1222` | Inline key-to-label for the directory row, and a privileged-edit select whose option values are **keys**. |
| T14 | `src/components/direct-entry/direct-entry-change-request-proposer.tsx:587` | Proposer select with key values and hard-coded labels. |
| T15 | `src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx:134` | Key-to-label preview that renders the permanent key as `Toàn thời gian` (inconsistent with T12/T13). |
| T16 | `src/components/direct-entry/direct-entry-shell.tsx:145`, `:262` | Retired demo shell still carries `Toàn thời gian`. |

### 1.3 Display-label comparisons instead of the stable key (the defect class)

| # | File:line | Current shape | Why it is unsafe |
|---|---|---|---|
| L1 | `direct-entry-live.tsx:1338` | `safePatch.labor_type === "Chính thức" ? "PERMANENT" : "TEMPORARY"` | **Label-to-key inversion.** Any label that is not exactly that string silently becomes the temporary key; a new `Gia công` value would be written as temporary labour. |
| L2 | `direct-entry-live.tsx:2212`-`2213`, `:2407`-`2411` | `<option value="Thời vụ">` / `value="Chính thức"` on the mobile staged and quick-edit selects | The select **value is the label**; the stable key exists only as a UI string. |
| L3 | `direct-entry-live.tsx:2521`-`2526` | Quick editor with key-valued options | Same field, different contract from L2 — the two paths disagree today. |
| L4 | `direct-entry-spreadsheet-grid.tsx:176`, `:189`; `direct-entry-grid-columns.ts:99` | Dropdown options come from the label list; the cell text is the label | The grid draft stores labels; conversion happens only at L1. |
| L5 | `direct-entry-live.tsx:1196`, `:1450`; `worker-operations.tsx:1102`; `direct-entry-worker-profile-paste-dialog.tsx:134`; `direct-entry-change-request-reviewer.tsx:116` | Binary `key ? labelA : labelB` renderers | A third key falls into the `else` branch and is mislabelled. |
| L6 | `worker-profile-xlsx.ts:47`-`51`; `worker-profile-paste.ts:98`-`104`; `excel-paste.ts:20`-`25` | Three independent label/alias maps | They already disagree: the paste parser does not accept `Chính thức`, while the pilot model and the paste dialog use `Toàn thời gian`. Adding a value means editing all three, and a missed one silently mis-maps. |
| L7 | `worker-profile-xlsx.ts:219` | Template data validation hard-codes the two labels | The downloadable template would not offer a third value. |
| L8 | `direct-entry-live.tsx:1196`, `:1450`; `worker-profile-import-contract.ts:216`; `excel-paste.ts:128` | Error/help copy names only two types | Copy must come from the catalog or it lies after the catalog grows. |

### 1.4 Consumer surfaces

| Area | Consumers |
|---|---|
| Direct Entry grid | `direct-entry-spreadsheet-grid.tsx` (label dropdown), `direct-entry-grid-columns.ts:215`, grid validation fixtures |
| Quick add / mobile staged / quick editor | `direct-entry-live.tsx:1196`, `:2209`, `:2407`, `:2521` |
| Full-profile batch and paste preview | `full-profile-contract.ts`, `full-profile-batch.ts`, `direct-entry-worker-profile-paste-dialog.tsx:134`, `worker-profile-paste.ts`, `worker-profile-import-contract.ts` |
| Privileged edit | `privileged-edit-api.ts`, `worker-operations.tsx:1221`, the worker full-correction DB test |
| Change requests | `change-request-proposer.ts`, `change-request-contract.ts`, `change-request-proposal-builders.ts`, `change-request-read-contract.ts`, `change-request-reviewer.ts`, `direct-entry-change-request-proposer.tsx:587` |
| Excel/CSV paste, import, template | `excel-paste.ts`, `excel-paste-import.ts`, `worker-profile-xlsx.ts`, `direct-entry-excel-paste-dialog.tsx:34` |
| T0 bulk importer | `scripts/lib/t0-operator-import.mjs:30`, `:256`-`257`, `:317`, `:336`, `:621`, `:665` (own closed set, upper-casing, post-import comparison) |
| Worker directory / APIs | `worker-directory-contract.ts:274`; entry projections D5 |
| Reporting dimensions and filters | SQL D6/D7; `reporting/p1-dashboard.ts:83`-`96`, `p1-reporting.ts`, `p1-reporting-server.ts`, `p1-reporting-pagination.ts`, `p2-w04a-cutover.ts`, `contracts/daily-recruitment-breakdown.ts:34`, `:47`-`49`, `:147`-`159`, `pipeline-check*.ts`, `dashboard-filters.tsx:18`, `:125` |
| Reporting fixtures and contracts | `docs/contracts/fixtures/p1-reporting/*.json`, `docs/contracts/fixtures/daily-recruitment-breakdown/*.json`, `docs/contracts/daily-recruitment-breakdown-v0.2.md:27`, `:55`, `:179`-`180`, `:241`, `scripts/check-daily-recruitment-fixtures.mjs:181`, `:235`, `:286`, `:332` |
| Deferred / out of scope | AI report engine employment consumers (flags stay off in P3.1) and the retired ingestion vocabulary D8 |

### 1.5 Tests and fixtures that encode the two-value set

`direct-entry-spreadsheet-dropdown-regression.test.mjs:161`, `:356`, `:362`, `:465`, `:517` · `direct-entry-grid-validation.test.mjs:65`-`163` · `worker-profile-xlsx.test.mjs:79`, `:108`, `:167`, `:201`, `:217`, `:250`, `:280` · `excel-paste.test.mjs` · `excel-paste-import.test.mjs` · `worker-profile-paste.test.mjs:104`-`106` · `full-profile-batch.test.mjs` · `banking-metadata.test.mjs` · `change-request-*.test.mjs` · `privileged-edit.test.mjs` · `p2-5-hf-r3-worker-full-correction-db.test.mjs` · `t0-import-workers.test.mjs` · `src/lib/reporting/p1-reporting.test.mjs:16` · `p1-chart-data.test.mjs:69` · `p2-w04a-acceptance.test.mjs:917`-`918` · `p1.6-w03-db.test.mjs` · `p1.6-w03-g3-dev-acceptance.mjs`.

## 2. Locked target contract

1. Seed exactly three stable keys with fixed initial order: `TEMPORARY` -> `Thời vụ` (sort order 10), `PERMANENT` -> `Chính thức` (20), `OUTSOURCED` -> `Gia công` (30).
2. The **key is immutable after create**; the display label, sort order and active flag are editable through reason + expected version + idempotency + revision + immutable audit.
3. Admin **and** Accounting operate the catalog through `direct_entry_assert_catalog_operator` (D9); no new guard, no role-name or client-side check.
4. Unknown or inactive keys are **rejected for new writes** (entry create, draft patch, full-profile batch, change-request item, privileged patch, import and template); historical rows carrying a now-inactive key stay readable and render their stored label.
5. The value stays **completely independent** of provider type, Vendor and team attribution: choosing `Gia công` must never imply Vendor, a provider membership or a team.
6. No hard delete: a referenced key can only be deactivated, and deactivation only removes it from new-entry choices.
7. The field never becomes arbitrary free text: it is always a catalog key validated against the canonical projection.
8. Historical data is never rewritten — no update of existing entry values and no remapping of existing reporting keys.

## 3. Recommended backend shape

Mirror the W01B catalog pattern (D10) instead of inventing a new one:

| Object | Shape |
|---|---|
| Catalog table | `direct_entry_labor_types` keyed by the existing labor-type text vocabulary, with editable display label, sort order, active flag and a version counter. No new identity is introduced. |
| Revision table | Append-only revisions keyed uniquely by (key, version), carrying actor and reason references, before/after snapshots, an immutability trigger, RLS enabled **and forced**, and revoked from every role; `direct_entry_audit_events` gains the matching revision reference. |
| Active-value projection | One bounded function returning only key, display label and sort order for active rows ordered by sort order then key, plus an admin projection adding active flag and version. Direct Entry, import/template, filters and reporting resolve labels from this projection — no consumer keeps a private label map. |
| RPCs | list / get (admin variant includes inactive), create, update (label + sort order), set-active. Each takes expected version (0 on create), a required reason and an idempotency key, and returns the bounded row plus the new version, exactly as the W01B RPCs do. |
| Guard | `direct_entry_assert_catalog_operator` first, before any input validation, so a denied actor learns nothing about the payload. |
| ACL / RLS / search_path | Security definer with an explicit `pg_catalog, public` search path; every helper revoked from public/anon/authenticated/service_role; execute granted only on the public RPCs to the service role; no table grant to any role. |
| Existing two values | Seed all three keys in the same migration with the labels already in use, idempotently on the primary key, so no existing row has to be rewritten. |
| Widening the vocabulary safely | In one transaction and in this order: create and seed the catalog, then widen the storage check to the catalog keys (or add an equivalent validating guard), then widen the PL/pgSQL closed sets (D2, D4), then widen the reporting mapping and its four display sites (D6, D7). Seeding before the check keeps a valid key from ever being rejected, and creating the catalog before any constraint keeps existing rows resolvable, so no historical row becomes orphaned or unreadable. |
| Migration sequencing | One cohesive, replay-safe migration appended after the current head, allocated by T0. The labor-type catalog must **not** be bundled into a capability or personnel migration; reporting view changes ride in the same package only if they apply atomically. This survey deliberately does **not** reserve a slot number. |
| No new dependency | Everything above reuses existing objects (restricted reasons, RPC idempotency helpers, audit events, the shared immutability trigger). No ORM, no new framework, no new library. |

## 4. Consumer cutover matrix

| Consumer | Current source | Required change | Active-write behavior | Historical-read behavior | Test to add | Blast radius |
|---|---|---|---|---|---|---|
| `contracts/direct-entry-v1.ts` union + validator | closed pair | widen to the catalog key and validate against the projection | unknown/inactive rejected | unchanged read of the stored key | contract unit + validator cases | **high** — every consumer imports this type |
| `write-api.ts`, `draft-api.ts`, `draft-list-contract.ts` | inline pair checks | validate against the active projection | unknown/inactive rejected | — | API unit + route tests | high |
| `privileged-edit-api.ts` | inline pair | same | rejected | — | privileged-edit unit + DB test | medium |
| `full-profile-contract.ts`, `full-profile-batch.ts` | inline pair | same | rejected | — | full-profile batch tests | medium |
| `change-request-{contract,proposer,proposal-builders,read-contract}.ts` | inline pair | same | rejected | a request built before deactivation still renders | change-request unit + DB tests | medium |
| `worker-directory-contract.ts` | pair validator | accept any catalog key, resolve the label from the projection | read path only | inactive key still renders its label | directory contract test | low |
| `direct-entry-grid-columns.ts`, `direct-entry-spreadsheet-grid.tsx` | label options | options come from the projection as key+label; the cell stores the **key** | inactive values absent from new selections | existing label still rendered | dropdown regression (currently asserts two labels) | **high** — grid is the primary entry surface |
| `direct-entry-live.tsx` (L1-L5) | inversion, binary renderers, mixed select contracts | delete the inversion; one key-based select on every path | invalid key rejected | renders the catalog label | interaction regressions for grid, quick add, mobile staged | **high** |
| `worker-operations.tsx`, `direct-entry-worker-profile-paste-dialog.tsx`, `direct-entry-change-request-reviewer.tsx`, `direct-entry-excel-paste-dialog.tsx` | inline label maps | consume one shared projection-backed lookup | render only | inactive key renders its stored label; unknown key renders a neutral placeholder | source + unit tests | medium |
| `change-request-reviewer.ts` label map | local map | replace with the shared lookup | — | — | reviewer tests | low |
| `excel-paste.ts`, `excel-paste-import.ts`, `worker-profile-paste.ts`, `worker-profile-import-contract.ts` | three alias maps + copy | one alias map derived from key + label (keep the legacy alias for the permanent key), messages built from the catalog | unknown/inactive rejected with clear copy | — | paste/import tests | **high** — three copies must converge |
| `worker-profile-xlsx.ts` template | hard-coded list and guide text | build the validation list and guide text from the active projection | new templates offer every active value | — | xlsx unit test | medium |
| `scripts/lib/t0-operator-import.mjs` | own closed set | validate against the projection; keep the preflight denial on unknown values | unknown/inactive rejected in dry-run | — | importer dry-run/apply test | medium (T0 lane) |
| SQL reporting mapping + four display sites | pair + unknown fallback | add the outsourced key and label; keep the unknown fallback (**decision for T0**, section 8) | — | historical keys unchanged | DB reporting test | **high** — four duplicated sites |
| `reporting/p1-dashboard.ts`, `contracts/daily-recruitment-breakdown.ts`, `ai-report/report-export-server.ts` | fixed four-value lists | add the new key and display (or read the projection) | — | — | reporting and filter tests | medium |
| `dashboard-filters.tsx` | employment filter | gains the value once the option catalog is widened | — | — | filter test | low |
| Fixtures and contracts (1.5) | two-value expectations | add the outsourced cases and keep the legacy pair green | — | historical rows still resolve | fixture/contract updates | medium |

## 5. Allowed / denied matrix

| Surface | Full Admin | Accounting (catalog operator) | Team leader | Project manager | Ordinary staff | Disabled / unmapped actor |
|---|---|---|---|---|---|---|
| Read active labor types (entry, import, filter, label) | allow | allow | allow | allow | allow | deny |
| Create / rename / reorder / activate-deactivate | allow | allow | deny | deny | deny | deny |
| Read the catalog including inactive rows | allow | allow | deny | deny | deny | deny |
| Direct URL/API call while unauthorized | server denial, no data, no field hints | server denial | server denial | server denial | server denial | server denial (mapping first) |
| Write an **unknown** key to a new entry | reject | reject | reject | reject | reject | reject |
| Write an **inactive** key to a new entry | reject | reject | reject | reject | reject | reject |
| Read or render a historical row whose key is now inactive | allow | allow | allow (own operational scope) | allow | allow | deny |
| Re-activate a previously deactivated key | allow | allow | deny | deny | deny | deny |
| Hard-delete a key | never (no such RPC) | never | never | never | never | never |
| Infer Vendor, provider or team from the outsourced value | **never** | never | never | never | never | never |
| Manage accounts, grants or links | allow | **deny** | deny | deny | deny | deny |

## 6. Mutation-check plan (each temporary change must turn a named test red)

| # | Temporary mutation | Expected red test |
|---|---|---|
| M1 | Remove the outsourced key from the DB vocabulary while clients still offer it | DB catalog test + Direct Entry create with that key |
| M2 | Keep the client hard-coded to two types (grid options or select) | dropdown regression + grid validation test |
| M3 | Allow an inactive key to be written to a new entry | active-write rejection test |
| M4 | Make a historical inactive key unreadable (filter it out of the read projection) | historical-read test on a deactivated key |
| M5 | Make the outsourced label imply Vendor (any provider/team branch on the label) | independence test: the entry keeps provider type and team unchanged |
| M6 | Re-open Accounting to account, grant or link operations | allowed/denied DB test for Accounting |
| M7 | Silently accept an unknown key (fallback to the temporary key) | unknown-key rejection test — the current inversion (L1) is exactly this defect |

## 7. File/symbol implementation map

**W02C — backend catalog (one cohesive migration + bounded RPCs)**

| Action | File / object |
|---|---|
| add | new migration: the labor-type catalog table, its revisions table, the audit reference, the three seeds, the widened storage check and the widened PL/pgSQL closed sets (`20261002170000...:1291`, `:1445`, `:1616`; `20261005060000...:350`, `:408`, `:451`) |
| add | RPCs: list (admin), get (admin), create, update, set-active, plus the shared active-value projection and the revision/bump helpers (mirroring `20261009040000...:177`-`295`) |
| edit | the reporting mapping function and its four display sites (D6, D7) |
| add | `src/lib/direct-entry/labor-type-catalog-contract.ts` — pure parse/validate, mirroring `project-operations-model.ts` |
| add | `src/app/api/direct-entry/labor-types/**` route handlers (session -> repository -> projector) and the read projection consumed by Direct Entry |
| add | DB tests: catalog CRUD and history, immutability, active-value rejection, historical inactive read, independence from provider/team, Accounting and leader denial |

**W04 — consumer switch (UI)**

| Action | File / symbol |
|---|---|
| edit | `src/lib/contracts/direct-entry-v1.ts`, `write-api.ts`, `draft-api.ts`, `draft-list-contract.ts`, `privileged-edit-api.ts`, `full-profile-contract.ts`, `full-profile-batch.ts`, `worker-directory-contract.ts`, `change-request-*.ts` |
| edit | `direct-entry-grid-columns.ts` (options become projection-backed), `direct-entry-spreadsheet-grid.tsx` |
| edit | `direct-entry-live.tsx` — remove the label-to-key inversion (L1) and unify the three select paths (L2-L4) on keys |
| edit | `direct-entry-change-request-proposer.tsx`, `direct-entry-change-request-reviewer.tsx`, `change-request-reviewer.ts`, `worker-operations.tsx`, `direct-entry-worker-profile-paste-dialog.tsx`, `direct-entry-excel-paste-dialog.tsx` — one shared label lookup |
| edit | `excel-paste.ts`, `excel-paste-import.ts`, `worker-profile-paste.ts`, `worker-profile-import-contract.ts`, `worker-profile-xlsx.ts` — single alias map plus projection-built template list and copy |
| edit | reporting and filter surfaces: `reporting/p1-dashboard.ts`, `contracts/daily-recruitment-breakdown.ts`, `ai-report/report-export-server.ts`, `dashboard-filters.tsx` |
| edit | the tests and fixtures listed in 1.5 (extend them; do not delete the legacy pair) |
| keep | the Admin entry point is the `/admin/catalog/labor-types` section defined by the W04-R0 survey — no new navigation model, no new dependency, no new form or grid framework |

## 8. Boundary, open decisions and risks

- **Boundary:** design only. No source, migration, API, dependency, route or UI change; `docs/P3.1.md`, `package.json` and every source file are untouched. No Production query, apply or deploy; no browser, CUA, screenshot or UAT.
- **Open decision for T0 — the reporting key for the outsourced value.** Recommendation: give it its own dimension key and display label in the reporting mapping and the four display sites, keeping the unknown fallback fail-closed. Alternative (rejected): fold it into the existing permanent bucket, which would misreport a distinct labour form and lose the Owner-visible distinction.
- **Open decision for T0 — constraint shape.** Recommendation: keep the column validated against the catalog projection rather than a hard foreign key, so catalog maintenance can never orphan a historical value; if a foreign key is preferred it must restrict deletes and be paired with a rule that keys are never deleted.
- **Risk — duplicated label logic (L4, L6).** Five independent label or alias maps already disagree; the cutover must collapse them into one projection-backed lookup or the third value will be mis-mapped somewhere.
- **Risk — binary renderers (L5).** Six binary key-to-label sites would mislabel the outsourced value; each needs an explicit catalog lookup with a neutral fallback for unknown values.
- **Risk — reporting duplication (D7).** Four mapping sites across two migrations; a partial update would make the dashboard and the actor-scoped views disagree.
- **Risk — blast radius of the shared type (T1).** Widening the union compiles through every Direct Entry and reporting consumer at once, so the switch should land as one reviewed package with the fixture updates in 1.5.
- **Deferred:** AI report surfaces (flags off in P3.1), the retired ingestion vocabulary (D8), any labor-type-driven reporting feature not already listed, and Owner browser UAT.
