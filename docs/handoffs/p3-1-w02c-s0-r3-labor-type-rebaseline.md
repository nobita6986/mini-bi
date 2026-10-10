# P3.1-W02C-S0-R3 — Labor-type catalog rebaseline (R2 factual corrections)

> **Status:** `P3_1_W02C_S0_R3_LABOR_TYPE_REBASELINE_PASS_AWAITING_T0_REVIEW`
> **Base:** `origin/main@09376b8ed44bc304b827f099f9597a4b82980ff0`. The merge at `09376b8` is the
> grid-toolbar actions hotfix; the **last migration** in the range is
> `20261009100000_p3_1_hf_duplicate_cccd_reporting.sql`. The repo at this base carries
> **74 migrations** under `supabase/migrations/`.
> **R2 correction note:** R2 was rejected on T0 review for **four factual errors**:
> 1. it cited "82 migrations" instead of the actual **74** (the grid-toolbar commit is a
>    source/UI hotfix, not a migration);
> 2. it mis-named the R1 base as `51fb221` (a W01B fix-up); the actual R1 lock is the
>    `docs(p3.1-w02c): lock dynamic labor-type catalog contract` commit `1b6b3de`, which sits on
>    top of `03f49ee` and carries **69 migrations**;
> 3. it stated "49 files, +11554/−35" for the `1b6b3de..09376b8` range; the actual
>    `git diff --shortstat` is **158 files changed, 25087 insertions(+), 599 deletions(-)**;
> 4. it claimed the four Admin catalog route families (personnel / team-leader /
>    team-membership / team) "all have the same one-collection / one-item / one-set-active shape"
>    and told W02C to mirror "the full convention"; in fact the four families have
>    **different shapes** (see §3.1 below) and the only family Labor Type should mirror is
>    **Personnel** (the only one that is a true CRUD catalog with a `[id]/active` set-active
>    route and a `set-active` action).
> R3 fixes the four errors, retains the rest of R2's design analysis where it survived the
> verification, and runs the gates again.
> **Authority:** `docs/P3.1.md`, `docs/handoffs/p3-1-c01-catalog-policy-survey.md` (C01),
> `docs/handoffs/p3-1-j00-security-regression-baseline.md` (J00), `docs/handoffs/p3-1-w04-r0-admin-ui-reuse-survey.md`
> (W04-R0), and the locked W02C contract in
> `docs/handoffs/p3-1-w02c-labor-type-consumer-survey.md` (R1, commit `1b6b3de`). Where this
> memo and those sources differ, those sources win.

## 0. Why a third rebaseline

R2 made claims about migration counts, file counts and route topology that did not survive
direct verification on `origin/main@09376b8`. R3 is the corrected, line-number-anchored,
route-topology-anchored and residual-scan-anchored rebaseline. The locked W02C contract in
`docs/handoffs/p3-1-w02c-labor-type-consumer-survey.md` is **still not edited**; R3 records the
delta against the lock and against current main without opening it.

## 1. Corrected lineage, counts and diff range (R2 §0 rewritten)

| Field | R2 value (rejected) | R3 corrected value | Evidence on `09376b8` |
|---|---|---|---|
| Migration count on `09376b8` | 82 | **74** | `git ls-tree -r 09376b8 -- supabase/migrations/ | grep '\.sql$' \| wc -l` |
| Last migration in range | (n/a; R2 said "grid toolbar is the last") | **`20261009100000_p3_1_hf_duplicate_cccd_reporting.sql`** | last 3 entries of the migration listing are `…w02a…`, `…hf_recruiter_alias_backfill…`, `…hf_duplicate_cccd_reporting…` |
| Last commit adding a migration | (n/a) | `f66cf6e feat(p3.1-hf-r1): warn on duplicate CCCD when a draft is sent for review` (parents `f9c1107`) | the three commits after that are merges + the grid-toolbar source/UI hotfix, none of which add a migration |
| R1 base (R2's claim) | `51fb221` | **`1b6b3de`** ("docs(p3.1-w02c): lock dynamic labor-type catalog contract", parent `03f49ee` W01C-A team catalog) | `git log -1 --format='%H %P %s' 1b6b3de` |
| `51fb221` actual description | (R2 used as the W02C lock base) | "fix(p3.1-w01b-r1): HRP/Vendor isolation, fixed revision snapshot, explicit valid_from" (parent `eb4a4ee`) | `git log -1 --format='%H %P %s' 51fb221` |
| Migration count on R1 lock | (R2 implied 68) | **69** | `git ls-tree -r 1b6b3de -- supabase/migrations/ \| grep '\.sql$' \| wc -l` |
| Diff range `1b6b3de..09376b8` file count | 49 (R2) | **158** | `git diff --name-only 1b6b3de..09376b8 \| wc -l` |
| Diff range `1b6b3de..09376b8` line count | +11554/−35 (R2) | **+25087 / −599** | `git diff --shortstat 1b6b3de..09376b8` |

The R2 file was wrong because (a) the migration count was likely taken from a stale mental model
or a wrong `ls-files` query, and (b) the diff stats appear to have been computed from a
filtered subset (perhaps a single subdirectory) rather than the full range. R3 verified each
number directly.

## 2. Residual scan on the correct range (`1b6b3de..09376b8`)

A line-by-line `git diff 1b6b3de..09376b8` sweep was filtered for any change that touches the
labor-type vocabulary, validator, reporting mapping or any label/alias map. The R1 vocabulary
hold-still claim is **confirmed**, but with a precise residual:

| File in range | `+labor_type` / `+LaborType` lines | What was added | Implication for R1 §1.5 |
|---|---|---|---|
| `scripts/p3-1-hf-recruiter-alias-backfill.test.mjs` | 1 line | one INSERT column list literal `"… provider_type, labor_type)"` (the column is in the table; the literal `labor_type` is a string in an SQL string) | test fixture for the alias backfill; no vocabulary change |
| `scripts/p3-1-w01c-b-team-membership-db.test.mjs` | 1 line | one INSERT column list literal `"… provider_type, labor_type) values (…)"` (W01C-B fixture) | team-membership test fixture; no vocabulary change |
| `scripts/p3-1-hf-duplicate-cccd-report-db.test.mjs` | 4 lines | four `labor_type: "TEMPORARY"` row fixtures in the duplicate-CCCD reporting test | report test fixture; the literal `TEMPORARY` is the legacy two-value closed set as it stands today; no vocabulary change |
| `scripts/p3-1-hf-r1-duplicate-cccd-submit-confirmation-db.test.mjs` | 5 lines | five similar row fixtures (`labor_type: "TEMPORARY"`, plus the INSERT column lists) | submit-confirmation test fixture; same observation |
| `scripts/p2-5-hf-r2-cccd-canonicalization-db.test.mjs` | 1 line | one INSERT column list (W2-5 hotfix R2 fixture) | legacy P2-5 fixture; same observation |
| `scripts/p2-w07-restore-rollback-drill.mjs` | 1 line | one INSERT column list (restore-rollback drill fixture) | P2-W07 fixture; same observation |
| **Total** | **13 lines across 6 files** | every new line is either a `labor_type: "TEMPORARY"` row fixture or a `… labor_type …)` column-list literal | **the closed two-value vocabulary in `direct_entries.labor_type` and in `LaborType = "TEMPORARY" \| "PERMANENT"` is still present in every new fixture**; no third value has been introduced anywhere on main since R1 |

**Conclusion:** the R1 §1 hold-still claim is correct: **no code on main between the W02C R1
lock (`1b6b3de`) and the R2/R3 base (`09376b8`) introduces, removes, renames or deactivates
any labor-type vocabulary value, validator, reporting mapping or alias map**. The 13 added
lines are pure fixture/column-list additions in DB tests, all of them carrying the
`TEMPORARY` literal that R1 already enumerated. R1's tests-and-fixtures list (§1.5) is still
authoritative; the W02C implementation task will need to extend the fixtures to include a
fourth-value case (per the R1 §7 extensibility proof), but no existing test contradicts the
locked contract.

## 3. Corrected Admin catalog route topology (R2 Δ1 rewritten)

R2 claimed "all four families have the same one-collection / one-item / one-set-active shape".
This is **false**. The four families at `09376b8` have **three different shapes**, and Labor
Type must mirror only the **Personnel** shape (it is a CRUD catalog with no membership/leader
concept).

### 3.1 Actual route topology at `09376b8`

| Family | Collection route | Item route | Item `/active` route | Nested mutations | Read-only sibling | Library file set |
|---|---|---|---|---|---|---|
| **Personnel** | `GET/POST /api/admin/catalog/personnel` | `GET/PATCH /api/admin/catalog/personnel/[recruiterId]` | `POST /api/admin/catalog/personnel/[recruiterId]/active` | `POST .../team-memberships/[teamId]/move`, `POST .../team-memberships/[teamId]`, `POST .../team-memberships/unassign` | — | `personnel-catalog-{contract,api,repository}.ts` (+ `personnel-catalog-api.test.mjs`) |
| **Teams** | `GET/POST /api/admin/catalog/teams` | `GET/PATCH /api/admin/catalog/teams/[teamId]` | `POST /api/admin/catalog/teams/[teamId]/active` | `POST .../leaders/revoke`, `POST .../leaders` | — | `team-catalog-{contract,api,repository}.ts` (+ `team-catalog-api.test.mjs`) |
| **Team-leaders** | `GET /api/admin/catalog/team-leaders` | (no item route) | (no `/active` route) | (no nested mutations) | `GET /api/admin/catalog/team-leader-candidates` (search-only) | `team-leader-{contract,api,repository}.ts` (+ `team-leader-*.test.mjs`) |
| **Team-memberships** | `GET /api/admin/catalog/team-memberships` | (no item route; mutations are under Personnel) | (no `/active` route) | (all mutations under Personnel) | — | `team-membership-{contract,api,repository}.ts` (+ `team-membership-*.test.mjs`) |

**Three different shapes:**

- **Personnel** and **Teams** are both **CRUD catalogs with a set-active route** (collection list+create, item read+update, item set-active). They are the only families W02C should mirror.
- **Team-leaders** is a **read-only index** with a sibling **search-only candidates** endpoint. It has no create/update/set-active because team leader designation/revocation is performed via a different RPC family (`direct_entry_designate_team_leader` / `…_revoke_team_leader` per C01 §2.3). W02C should **not** mirror this shape — Labor Type has no equivalent "designate as the canonical labor type" concept; it has a true CRUD + set-active lifecycle.
- **Team-memberships** is a **read-only collection**; all mutations are nested under Personnel (`personnel/[recruiterId]/team-memberships/...`). W02C should **not** mirror this shape because Labor Type is a first-class catalog, not a side collection of another entity.

### 3.2 What W02C should mirror (R3 correction to Δ1)

W02C mirrors **Personnel** (and secondarily **Teams** for the `[id]/active` set-active
convention) — the two families that are genuine CRUD catalogs. W02C does **not** mirror Team-
leaders or Team-memberships because Labor Type has no designation RPC and no "owned by
Personnel" parent.

The route surface for W02C therefore is:

```
GET    /api/admin/catalog/labor-types                        # list (admin: includes inactive)
POST   /api/admin/catalog/labor-types                        # create (reason + idempotency + expected_version=0)
GET    /api/admin/catalog/labor-types/[laborTypeKey]         # read (admin: includes inactive)
PATCH  /api/admin/catalog/labor-types/[laborTypeKey]         # update display_name + sort_order (reason + idempotency + expected_version)
POST   /api/admin/catalog/labor-types/[laborTypeKey]/active  # set-active true/false (reason + idempotency + expected_version)
```

This is **exactly** the Personnel shape (collection list+create, item read+update, item
set-active) and **exactly** the Teams shape (same). The library module set mirrors Personnel:

```
src/lib/direct-entry/labor-type-catalog-contract.ts   # mirrors personnel-catalog-contract.ts
src/lib/direct-entry/labor-type-catalog-api.ts        # mirrors personnel-catalog-api.ts
src/lib/direct-entry/labor-type-catalog-repository.ts # mirrors personnel-catalog-repository.ts
src/lib/direct-entry/labor-type-catalog-api.test.mjs  # mirrors personnel-catalog-api.test.mjs
```

No nested mutations (no W02C equivalent of `team-memberships` or `team-leaders`). No
`team-leader-candidates` analog. No second "search-only" endpoint — the W02C admin list is
the search list. The runtime Direct Entry catalog projection (D12) is unchanged; the active
labor-type options continue to join `getInputCatalog`, not a new
`/api/direct-entry/labor-types/**` route.

### 3.3 What W02C must NOT do (R3 boundary)

- W02C must **not** add nested mutations under the `[laborTypeKey]/...` path (no labor-type
  membership; no "labor-type leader"). The W04-R0 reuse survey E2 (Admin area one
  entry = one NavEntry) and E3 (one predicate per entry) make a flat CRUD catalog the only
  safe shape; nesting would create a parallel surface that the W04-R0 contract does not
  describe.
- W02C must **not** add a second `team-leader-candidates`-style search-only sibling. The
  Personnel list route is the search list; an additional
  `/api/admin/catalog/labor-types/candidates` would diverge from Personnel without a contract
  reason.
- W02C must **not** add a `/api/direct-entry/labor-types/**` runtime route. D12 is the only
  runtime catalog route for Direct Entry; the active options must join `getInputCatalog`.

## 4. Current-truth reverification (R2 §1 retained where the facts survived)

R2 §1's reverification of R1 §1 (D1–D12, T1–T16, L1–L8, consumer surfaces, tests/fixtures) is
**still correct** for every row. The L1–L8 line-number drift caused by the grid-toolbar commit
(`172ba11`) is also still correct. R3 does not re-list those rows; the R2 file is the source
of truth for them, the only change being the route topology in §3 above.

The R2 §1 reverification of D11 (the Admin catalog convention) is the row that R3 corrects:
the convention is **not** "one family"; it is **two CRUD families (Personnel, Teams), one
read-only index (Team-leaders) and one nested collection (Team-memberships)**. W02C's Admin
surface is therefore one CRUD family, and it follows the Personnel shape.

## 5. Target canonical catalog (R1 §2 reaffirmed, unchanged from R2)

R1 §2 (locked) stays authoritative. R2's restatement of the four locked target decisions is
retained verbatim in R3 because R1 is still locked and the design analysis is unaffected by
the route-topology correction. The four decisions:

1. **Dynamic catalog with three seeds only** — `TEMPORARY`, `PERMANENT` and `OUTSOURCED` as
   seed rows; Admin and Accounting can add a fourth through the RPC.
2. **Hard FK with restrict semantics** — `direct_entries.labor_type` references
   `direct_entry_labor_types.labor_type_key` with `ON UPDATE RESTRICT, ON DELETE RESTRICT`.
3. **`reporting_key` is catalog-owned and immutable** — `OUTSOURCED` → `gia công`,
   `TEMPORARY` → `thời vụ`, `PERMANENT` → `chính thức`; client never sends `reporting_key`.
4. **Write authority is projection-backed** — unknown fails shape; inactive rejected for every
   new write; historical stays readable.

## 6. Backward compatibility and seed/backfill (R2 §3 retained)

R2 §3 (seed scope is `direct_entries` only; backfill is **forbidden**; the verify step aborts
on any value outside the seed set) is retained. R3 adds the **explicit numeric bound**: at
`09376b8` the maximum possible legacy values that the verify step can encounter are exactly
`{TEMPORARY, PERMANENT, NULL, ""}` plus any value pre-dating the original foundation
migration. The verify step must read the current `min(entry_id)` and `max(entry_id)` of
`direct_entries` before scanning so the abort path can list the actual offending row ids,
not a sample.

## 7. Deactivate rules (R2 §4 retained)

R2 §4's three explicit deactivate rules (no historical rows broken; no new selection; historical
data stays readable) are retained. R3 adds the **operational meaning** for the Admin UI:
`set-active(false)` from the Admin UI does **not** delete the row, does **not** rename the
display label, and does **not** change `reporting_key`. The Admin UI confirmation dialog must
show the before/after `active` flag, the immutable `key` and `reporting_key`, and the
immutable `display_name` at the moment of deactivation, and must require a reason (the same
reason catalog the W01B personnel catalog uses).

## 8. Impact matrix (R2 §5 retained with one corrected row)

R2 §5's impact matrix is **retained** with one row corrected:

| Consumer | R2 status | R3 status | Delta |
|---|---|---|---|
| Admin catalog API (D11) | "mirror the four existing families" | **"mirror the Personnel family shape; secondarily the Teams `[id]/active` set-active convention"** | corrected per §3.2 above |

All other rows in the impact matrix are unchanged from R2 because the R1 hold-still claim was
correct (residual scan in §2 confirms it).

## 9. Extensibility design (R2 §6 retained)

R1 §2 + §7 (locked) and R2 §6's restatement of the extensibility proof (create a fourth type
through the RPC; no source or migration change; all surfaces pick it up) are retained. R3
adds the **explicit test-family name** for the W02C implementation: the
`personnel-catalog-api.test.mjs` test surface is the template (its assertions on
immutability, OCC, idempotency and active-flag are exactly the assertions the W02C test family
must make). The R1 §7 proof itself is unchanged.

## 10. Implementation slicing (R2 §7 retained, narrower)

R2 §7's T1B/T1A split is **retained** with one narrowing:

- **T1B (W02C) route surface** is the Personnel-shaped CRUD catalog (5 routes, see §3.2).
  Not 4, not 14, not "the union of the four families" — exactly the 5 routes that mirror
  Personnel.
- **T1A (W04) does NOT touch:** the catalog table, the revision table, the audit reference,
  the FK, the seed rows, the active/admin projections, the RPCs, the Admin catalog API, the
  reporting lookup, the search_path or the grants. Every one of these is **W02C**.
- **T1A (W04) does touch:** every `LaborType` validator, every consumer of the closed pair, the
  L1–L8 defects, the three alias maps, the XLSX template list, the dashboard filters, the
  change-request proposer/reviewer, the privileged-edit select, the worker profile paste
  dialog, the Excel paste preview, the T0 operator importer (it is the same import resolver
  on the T0 lane), the tests and fixtures in R1 §1.5 (extended with a dynamic-key case; the
  legacy pair stays green), and the Admin UI entry point under `/admin/catalog/labor-types`
  that mirrors `/admin/catalog/personnel` (W04-R0 §2 E2/E3).

## 11. Migration sequencing (R2 §8 retained, no number reserved)

R2 §8's migration sequencing is **retained**. R3 adds the **explicit ordering constraint**
that the migration must run **after** the W02A team-leader project-manager authority
migration (`20261009080000_p3_1_w02a_team_leader_project_manager_authority.sql`) because
W02A introduces the `direct_entry_assert_catalog_operator` call site for catalog operators
on the project-master path, and the W02C migration adds a **second** call site for labor-type
mutations. The two migrations are independent (W02A guards project-master; W02C guards
labor-type), but they share the same guard function (D9) and the same rev-grant pattern.

The slot is **not reserved in this memo**. T0 allocates the number when the W02C implementation
task is scheduled.

## 12. Allowed / denied matrix and mutation-check plan (R2 §9 retained)

R2 §9's allowed/denied matrix and M1–M9 mutation-check plan are **retained** in full. R3
adds the **explicit denial code** for the Admin catalog API:

- `direct_entry_assert_catalog_operator` returns a structured denial with code
  `CATALOG_OPERATOR_REQUIRED` (mapping-first; then either the legacy full-Admin triple or
  `catalog_master_manage@all`). A leader/PM/staff/disabled actor gets the same code as the
  W01B personnel-catalog denial.
- An unknown key on a write returns `LABOR_TYPE_INVALID` (shape failure) before reaching
  the active-catalog lookup.
- An inactive key on a write returns `LABOR_TYPE_INACTIVE` (active-catalog lookup failure)
  after shape validation passes.
- Re-activation by a non-Admin/Accounting actor returns `CATALOG_OPERATOR_REQUIRED` (same as
  the catalog API denial).

## 13. Blockers (R2 §10 retained, one explicit R2-only blocker)

R2 §10's blocker list is **retained** with one R2-only blocker made explicit so a T0 reviewer
can confirm R3 addresses it:

- **R2-only blocker (now resolved by R3):** the route-topology claim "all four families have
  the same shape" was factually wrong; R3 corrects it to "two CRUD families (Personnel,
  Teams), one read-only index (Team-leaders) and one nested collection (Team-memberships)
  and W02C must mirror Personnel".

All other blockers from R2 §10 are unchanged.

**Explicitly out of W02C scope (P3.2 deferred, password/invitation/MFA):** unchanged. R3 does
not address self-service password change, invitation, MFA, account recovery or any other
P3.2 area. R3 does not propose any W02C change that touches the auth or session layer
(`direct-entry-v2.ts`, `auth-session-core.ts`, session revocation cache or session-identity
header).

## 14. Boundary, decisions recorded and remaining risks

- **Boundary:** design-only survey, exactly **one** documentation file added
  (`docs/handoffs/p3-1-w02c-s0-r2-labor-type-rebaseline.md` removed,
  `docs/handoffs/p3-1-w02c-s0-r3-labor-type-rebaseline.md` added). The R2 file is **deleted
  in the same commit** that adds R3; the net file diff is **+1 documentation file** on the
  R2/R3 worktree. No source, migration, API, dependency, route or UI change;
  `docs/P3.1.md`, `package.json`, `pnpm-lock.yaml`, every existing `src/**` /
  `supabase/**` / `scripts/**` / `docs/**` file is untouched; no Production query, apply,
  deploy, browser, CUA, screenshot or UAT; no commit hash on main; no merge queue.
- **Decisions recorded in R3 (corrections vs R2):** migration count 74 (not 82); R1 base
  `1b6b3de` (not `51fb221`); R1 migration count 69; `1b6b3de..09376b8` is 158 files,
  +25087/−599 (not 49 / +11554/−35); the four Admin catalog route families are **not** the
  same shape — W02C mirrors **Personnel** (CRUD catalog with `[id]/active` set-active),
  secondarily the **Teams** `[id]/active` convention; W02C does **not** mirror
  Team-leaders (read-only index) or Team-memberships (nested collection under Personnel).
- **Decisions reaffirmed from R1 / R2 (unchanged):** dynamic catalog with three seeds only;
  hard FK with restrict semantics; runtime-parsed `LaborTypeKey`; catalog-owned immutable
  `reporting_key`; `OUTSOURCED` → `gia công`; one canonical source; single import resolver;
  historical display via the current catalog row; corrected allowed/denied matrix; M1–M9
  mutation-check plan; T1B / T1A split; migration slot unallocated.
- **Risk — duplicated label logic (R1 L4, L6).** Unchanged. The W04 cutover must collapse the
  three alias maps into one resolver.
- **Risk — binary renderers (R1 L5).** Unchanged. L1 inversion is now at
  `direct-entry-live.tsx:1403` (per R2's verification, still correct).
- **Risk — reporting duplication (R1 D7).** Unchanged. Four duplicated display sites must
  collapse to one `reporting_key` lookup + one `display_name` join.
- **Risk — rename semantics.** Unchanged. Stored key and `reporting_key` are immutable;
  `display_name` is editable.
- **Risk — FK plus seed ordering.** Unchanged. The verify step aborts on any value outside
  the seed set; the abort path lists the offending `entry_id` and `labor_type` values.
- **Risk — W04B code freeze.** Unchanged. R3 rebaselines on the current main at `09376b8`;
  the W04-B team-leader UI lane is already merged into main. R3 is not a W04B rebaseline.
- **Risk — route-shape drift after W02C is implemented.** New: a future lane that adds a
  Personnel-shaped sibling (e.g. an "Issue place" or "Bank" catalog) might evolve the
  Personnel shape. R3 records that the W02C implementation should track the Personnel shape
  in a header comment ("mirrors personnel-catalog-*.ts at `<sha>`") so a future diff is
  easy to spot.
- **Deferred:** the AI report engine employment consumers (P3.1 flags off), the retired
  ingestion vocabulary (D8), any labor-type-driven reporting feature not already listed, the
  P3.2 password/invitation/MFA workstream, the Owner browser UAT, the migration slot
  allocation (T0 reserves the number), and any future labor-type with a custom `reporting_key`
  override.
