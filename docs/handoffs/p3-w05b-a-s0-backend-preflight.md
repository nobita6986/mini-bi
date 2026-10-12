# P3-W05B-A-S0 — Team reporting backend implementation preflight

> **Status:** `P3_W05B_A_S0_BACKEND_PREFLIGHT_PASS_AWAITING_T0_REVIEW`
> **Base:** `origin/main@bf23d5a80716512f831d46b0e93afe96b35be069`
> (`docs(p3-w05b): R8 close R7 review — team_active, route auth, total semantics`;
> migration ledger = **84** files).
> **Branch:** `audit/p3-w05b-a-s0-backend-preflight`
> **Worktree:** `C:\CodeApp\BI-p3-w05b-a-s0-backend-preflight`
> **Scope:** docs-only preflight. No implementation was opened.

## 0. Authority and boundary

This memo records the live implementation truth needed before P3-W05B-A backend work. It does not replace or modify the R6 contract and does not approve the T1C R7/R8 rebaseline.

References:

- R6 source: `origin/audit/p3-w05b-s0-bod-team-reporting-survey@e91362437cd4755898a3028cbed14216f26c34e2`.
- R6 handoff: `docs/handoffs/p3-w05b-s0-bod-team-reporting-survey.md` on that audit branch. It is not present on current `origin/main`.
- T1C current-main R8 working memo: `origin/audit/p3-w05b-s0-r7-bod-team-reporting-rebaseline`, now included on current `origin/main` after the R7/R8 docs-only commits. Its contract decisions remain subject to T0 review.
- Current W05A implementation source: `docs/handoffs/p3-w05a-actor-scoped-reporting-team-scope.md` and migration `20261008080000_p3_w05a_actor_scoped_reporting.sql`.
- Current W06C consumer source: `docs/handoffs/p3-w06c-bod-team-own-dashboard.md`.

The following are intentionally not decided here:

- Any change to the T1C R7/R8 contract or Owner UX decision.
- A migration number reservation. Current main has 84 migrations; the next filename is only an observation. W03B is outside this base and does not reserve #85.
- Any implementation detail that would contradict R8's locked Route Handler path/auth/status contract.

The R8 thin-parser decision is also treated as locked pending T0 approval: the shared `parseReportingFilters`/`ReportingFilters` remain unchanged, and drill-down-only fields belong in a separate parser.

## 1. Current-base truth

### 1.1 Reporting model and missing W05B surfaces

At current main:

- `ReportingFact` is the existing 11-field aggregate shape in `src/lib/reporting/p1-reporting.ts:18-30`.
- `ReportingBucket` is `{ key, display, recruitedCount }` in `src/lib/reporting/p1-reporting.ts:56-61`.
- `ReportingData` has totals, date/project/recruiter/provider/employment breakdowns, project-provider mix, coverage, sources, date extent and empty-state flags in `src/lib/reporting/p1-reporting.ts:91-105`. It has no `byTeam`.
- `computeReporting()` computes all current breakdowns from one filtered `rows` array in `src/lib/reporting/p1-reporting.ts:310-387`.
- There is no `team_id`, `team_code`, `team_display_name`, `bucket_key`, `byTeam`, `fetchCutoverTeamDrillDown` or `direct_entry_reporting_team_drill_down` in the live implementation.
- There is no reporting Route Handler today. `/dashboard` is a server component that reads through server modules directly.

The existing P1 error identifiers are `REPORTING_QUERY_FAILED` from `p1-reporting.ts` and `INVALID_FILTER` from `p1-filter.ts`. The cutover path reuses `REPORTING_QUERY_FAILED` for sanitized RPC/transport failures.

### 1.2 Exact live SQL definition chain

| Live object | Origin and later patches | Effective current behavior | Boundary that must remain |
|---|---|---|---|
| `public.direct_entry_reporting_facts_v01` | Created in `20261007020000_p2_w04a_direct_entry_reporting_cutover.sql:273-319`; cutoff rebaselined by W04B/W04C; Vendor/team-related invariants are carried by later W07A migrations; W02C #79 patches the live body at `20261011120000_p3_1_w02c_labor_type_catalog.sql:1114-1133`. | One eligible Direct Entry row per entry, `recruited_count=1`, submitted, not deleted, `first_work_date >= direct_entry_reporting_cutoff()`. Current 15 columns are the original 11 ReportingFact columns plus `first_work_date`, `entry_id`, `submission_id`, `cutoff_date`. No team columns. | View runs as owner, `service_role` SELECT only; `public`, `anon`, and `authenticated` remain denied. Existing column order/prefix and the W02C `direct_entry_reporting_employment_display(e.labor_type)` lookup must survive. |
| `direct_entry_reporting_resolve_audience(uuid,uuid)` | W05A migration `20261008080000...:51-169`. | Verifies enabled auth/app pair and returns sanitized `all`/`team`/`own` audience with priority `all > team > own`, team IDs and recruiter identity only inside the DB boundary. | `SECURITY DEFINER`, fixed `search_path = pg_catalog, public`, `service_role` only; no UUID/auth subject/PII in the server projection. |
| `direct_entry_reporting_authorized_entries(uuid,uuid)` | W05A `:181-246`. | Reuses the audience resolver and returns eligible entry IDs. Team scope uses the stored `direct_entries.team_id`; own scope uses the verified recruiter link. It does not infer history from current membership. | Shared predicate for facts/options; no client-side scope inference and no recruiter-membership re-attribution. |
| `direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)` | W05A `:259-430`; reads `direct_entry_reporting_facts_v01` and legacy `daily_recruitment_breakdown`; W02C changes the live facts view and labor display source. | Returns `{ audience, facts, sources, latest_runs, presence }`. Each fact currently has exactly 15 keys. Direct Entry rows are intersected with `authorized_entries`; legacy rows are included only for `all` and only before cutoff. It fully materializes JSON and has no cursor/page contract. | `SECURITY DEFINER`, fixed search path, service-role-only; existing 15 keys/order and audience/source rules stay intact. |
| `direct_entry_reporting_de_options_scoped(uuid,uuid)` | W05A `:438-549`; W02C #79 redefines it at `20261011120000...:1145-1243` so labels use catalog lookup. | Actor-scoped Direct Entry project/recruiter/provider/employment options from the same authorized set. | Do not add a team dimension here; W07A-R4 explicitly preserves the no-team options invariant. |
| `direct_entry_reporting_scoped_options(uuid,uuid)` | W05A `:560-631`. | Combines scoped Direct Entry options with legacy options for `all`; returns no global source metadata for `team`/`own`. | Existing output and ACL remain unchanged for the team report chart/read path. |

### 1.3 W02C patch hazard

W02C #79 no longer treats the W04A view/function source files as authoritative. It uses a temporary helper at `20261011120000_p3_1_w02c_labor_type_catalog.sql:546-585` that:

1. reads `pg_get_viewdef()`;
2. counts an expected source fragment exactly;
3. aborts with `55000` when the count drifts;
4. executes a qualified `CREATE OR REPLACE VIEW` using `replace()`.

W02C R2/R3 use the analogous `pg_get_functiondef()` strategy (`20261011130000...:45-71` and `20261011140000...:41-67`) and drop their temporary helpers in the same transaction. Re-emitting the W04A/W05A source bodies would silently remove the W02C employment-display patch and any other later patch. This is the primary migration safety constraint.

### 1.4 Current parser, pagination and error contracts

- `parseReportingFilters()` in `src/lib/reporting/p1-filter.ts:55-117` is the only current reporting filter parser. It validates real ISO dates, `from <= to`, normalized project/recruiter keys, UUID source values, and closed provider/employment sets.
- Current provider values are `hrp`, `vendor`, `__unknown__`, `__invalid__`; current employment values are `thời vụ`, `chính thức`, `__unknown__`, `__invalid__` (`p1-filter.ts:10-16`). W02C now has a dynamic labor catalog and seeds `OUTSOURCED` with reporting key `gia công`; whether W05B expands the parser is a T0/T1C decision, not a preflight decision.
- Existing `paginateAll()` in `src/lib/reporting/p1-reporting-pagination.ts:51-91` is offset/range based, with default page size 1000 and a 100,000-row ceiling. It is the correct error/count posture reference, but it is not suitable for a cursor drill-down that must default to 25 and cap at 100 without full materialization.
- `fetchCutoverReporting()` in `src/lib/reporting/p2-w04a-reporting-server.ts:82-215` performs the blocker RPC, parses filters, calls `direct_entry_reporting_scoped_facts`, projects the DB audience, masks/combines facts and calls `computeReporting()`.
- `fetchCutoverReportingOptions()` in `src/lib/reporting/p2-w04a-options-server.ts:35-64` calls `direct_entry_reporting_scoped_options` and builds the existing options catalog. It should not be duplicated or widened for team buckets.

## 2. Exact call graph

```text
src/app/dashboard/page.tsx
  -> resolveActorForRequest()
  -> decideSessionPageAccess(actor)
  -> Promise.all(
       fetchCutoverReporting(searchParams, actor.actor),
       fetchCutoverReportingOptions(actor.actor)
     )

fetchCutoverReporting
  -> readCutoverBlocker()
       -> direct_entry_reporting_pre_cutover_blocker_count
  -> parseReportingFilters()
  -> direct_entry_reporting_scoped_facts
       -> direct_entry_reporting_resolve_audience
       -> direct_entry_reporting_authorized_entries
       -> direct_entry_reporting_facts_v01 (Direct Entry branch)
       -> daily_recruitment_breakdown + source/status views (all branch)
  -> resolveReportingAudienceProjection()
  -> maskDirectEntryFacts()/maskLegacyFacts()
  -> combineReportingFacts()
  -> computeReporting()
  -> DashboardView

fetchCutoverReportingOptions
  -> direct_entry_reporting_scoped_options
       -> direct_entry_reporting_de_options_scoped
            -> direct_entry_reporting_authorized_entries
       -> reporting_dimension_options_v01 (all only)
  -> buildDimensionOptions()/buildSourceOptions()
```

Current `DashboardView` consumes the result and dispatches the DB-projected `all`/`team`/`own` audience. Existing W06C team/own views are consumers of the scoped aggregate; they are not a cross-team BoD report and must not be reused as the drill-down implementation.

## 3. Smallest proposed backend diff

This is a proposed implementation touch set only. It is conditional on T0 accepting the T1C R8 contract.

| Area | Smallest expected touch | Reuse / non-goal |
|---|---|---|
| SQL migration | One append-only migration after current main, allocated by T0. Patch the live facts view and scoped-facts function; add exactly one team drill-down RPC. | Do not re-emit W04A/W05A bodies. Do not alter `reporting_dimension_options_v01` or `direct_entry_reporting_scoped_options`. Do not reserve #85. |
| Fact projection | Append `team_id`, `team_code`, `team_display_name`, `team_active` to the facts view. Add the same four keys to each scoped-facts fact; legacy branch emits four nulls. `team_active` stays server-internal. | Preserve the existing 15 keys and order. Preserve stored `direct_entries.team_id`; never join current membership to rewrite history. |
| Read model | Add `byTeam: Record<string, ReportingBucket>` to `ReportingData`. Compute it from the same filtered fact array used by `recruitedTotal` and existing breakdowns. Use `team_active === false` only to compose the inactive suffix. | Reuse `ReportingBucket`, `selectDisplay()` and grouping/sum semantics. No second aggregate RPC and no client-side team join. |
| Team identity | Resolve current `teams.display_name` from the reporting read path. Use an opaque, stable bucket key derived from canonical `teams.code`; use bare `unknown` only for null/orphan/teamless facts. | Never expose raw UUID, raw code, display name as identity, or internal identifiers in the wire key. Vendor is a known team bucket, not Unknown. |
| Drill-down | Add the locked `GET /api/reporting/team-drill-down` Route Handler, one service-role-only RPC with the R8 signature and one server function. The route owns `runtime="nodejs"`, `dynamic="force-dynamic"`, `guardApiSession()`, sanitized no-store headers and HTTP mapping. The RPC re-resolves audience, validates bucket/filter/cursor/limit, reads in one query and returns sanitized rows. | `all` only; `team`/`own` fail closed with `REPORTING_QUERY_FAILED`. No N+1, no Admin Catalog call, no client-side join. |
| Pagination | Add a thin `parseTeamDrillDownRequest()` without changing `parseReportingFilters()` or `ReportingFilters`. It validates only the locked allowlist, rejects `source`, defaults 25, caps at 100, and handles opaque cursor/stable ordering. | Reuse existing `INVALID_FILTER` and sanitized reporting errors. Do not use `paginateAll()` to materialize the drill-down. |
| Server boundary | `fetchCutoverReporting` remains the only aggregate read. The new drill-down is an additive interactive endpoint under `src/app/api/**`, guarded by the existing actor/session pattern. | No change to the current dashboard aggregate fetch contract; no UI implementation in this lane. |
| Unknown panel data | In the one drill-down response, keep legacy aggregate total as Section A and Direct Entry null/orphan rows as paginated Section B. | Legacy aggregate is never converted into entry-level rows; no extra legacy RPC. |

Likely source touch set for the later implementation is therefore:

- one new SQL migration;
- `src/lib/reporting/p1-reporting.ts` for `ReportingData`/team aggregation and its existing unit tests;
- `src/lib/reporting/p2-w04a-cutover.ts` for the normalized Direct Entry fact shape/masking preservation if the implementation keeps team fields typed there;
- `src/lib/reporting/p2-w04a-reporting-server.ts` or a new reporting sibling for `fetchCutoverTeamDrillDown` and the thin `parseTeamDrillDownRequest`; `src/lib/reporting/p1-filter.ts` and `ReportingFilters` stay unchanged;
- `src/app/api/reporting/team-drill-down/route.ts` with its own `guardApiSession()` boundary;
- W05B DB/server tests and a small extension to `src/lib/reporting/p3-w05a-page.test.mjs` proving aggregate byTeam is read-model work, not a client join.

No package, dependency, lockfile, dashboard UI, W06C view, Admin Catalog API, or unrelated migration should be touched by T1B.

## 4. Migration patch strategy

### 4.1 Live objects to patch

Only these existing bodies need additive changes:

1. `public.direct_entry_reporting_facts_v01` — append the four team columns (`team_id`, `team_code`, `team_display_name`, `team_active`) and add one `LEFT JOIN public.teams t ON t.team_id = e.team_id` in the Direct Entry projection.
2. `public.direct_entry_reporting_scoped_facts(uuid,uuid,jsonb)` — append the four team keys to the Direct Entry JSON object and append four null keys to the legacy JSON object. `team_active` is server-internal and must not reach the drill-down row/client payload.
3. No patch to `direct_entry_reporting_scoped_options` or the dimension-options views. Team is a report output dimension, not a new filter option, and W07A-R4 pins the absence of a `team` option.
4. Create `direct_entry_reporting_team_drill_down(...)` as a new body with the locked service boundary. It reads the already-live projection and shared authorized predicate; it must not duplicate the old source body.

### 4.2 Helper and exact-count requirements

The implementation migration must create a temporary, private patch helper in its own transaction, following W02C:

- Function patch helper input: `regprocedure`, expected fragment, replacement fragment, expected count.
- View patch helper input: `regclass`, expected fragment, replacement fragment, expected count; resolve the qualified catalog name before `CREATE OR REPLACE VIEW`.
- Every target definition is read with `pg_get_functiondef()` or `pg_get_viewdef()` from the live database, not copied from W04A/W05A source.
- Every expected fragment is counted with the length-difference method. Any missing, duplicated or drifted fragment aborts with `55000`.
- The expected semantic count for each one-time W05B insertion is one. The final implementation must pin the exact normalized source fragments produced by the current live migration chain; this preflight does not query Production or invent catalog output.
- Drop the helpers in the same migration and revoke their execute privilege from `public`, `anon`, `authenticated` and `service_role`.

Expected patch anchors to lock in the implementation test are:

- one unique current live join boundary for adding `LEFT JOIN public.teams`;
- one unique current live select-list tail after `cutoff_date` for appending the four view columns;
- one Direct Entry `cutoff_date` JSON fragment and one legacy `cutoff_date` JSON fragment in scoped-facts;
- no replacement that removes or rewrites any existing 15-key field.

### 4.3 Post-state self-check

The migration self-check must fail closed and prove:

- facts view columns are the original 15-column prefix plus exactly `team_id`, `team_code`, `team_display_name`, `team_active`; `team_active` is not a client field;
- the W02C employment display lookup remains in the live facts view and no original labor-type CASE map is restored;
- scoped-facts retains all existing keys/order and emits the four team keys for both Direct Entry and legacy branches;
- the new drill-down signature exists, is `SECURITY DEFINER`, has `search_path = pg_catalog, public`, and is executable only by `service_role`;
- existing view/RPC ACLs remain unchanged;
- no team option appears in either dimension-options path;
- no leader/current-membership join or Admin Catalog call is introduced;
- earlier migration files remain byte-identical.

`CREATE OR REPLACE VIEW` must preserve owner/ACL in practice, but the self-check must assert the ACL rather than relying on that assumption. Function patching must likewise assert the existing security/search-path posture after replacement.

## 5. Test and ledger plan

### 5.1 New or modified tests

Proposed W05B tests, subject to T0/T1C naming confirmation:

- `scripts/p3-w05b-by-team.test.mjs`: read-model byTeam, total reconciliation, stored team attribution, inactive labels, unknown/orphan handling, Vendor bucket and opaque key rules.
- `scripts/p3-w05b-team-drill-down.test.mjs`: RPC/server boundary, `GET /api/reporting/team-drill-down`, own `guardApiSession()` auth, HTTP status mapping, all-only audience, cursor paging, limit/default validation, thin parser allowlist, sanitized seven-field rows, `team_active` absent from wire, known/unknown total semantics and the two-section unknown response.
- One migration DB test asserting the 84-to-85 append-only change, live-body patch strategy, expected-count drift failure, W02C patch survival, ACL/search path and no-team-options invariant.
- Extend `src/lib/reporting/p3-w05a-page.test.mjs` to assert that `byTeam` is produced by the server read-model path and that no client-side team join or direct view read is introduced.
- Extend the existing P1 reporting tests for the additive `ReportingData` field. Keep `parseReportingFilters()`/`ReportingFilters` unchanged; test `parseTeamDrillDownRequest()` in the drill-down server test. Existing `p1-reporting.test.mjs`, `p1-dashboard.test.mjs`, and `p1-reporting-pagination.test.mjs` are the reuse points.

### 5.2 Existing regression lanes

The implementation must keep green:

- `pnpm test:p3-w05a` — audience, page wiring, source filter, actor-scoped DB, team seed and multi-team regression;
- `pnpm test:p3-w06c` — all/team/own dashboard dispatch and fail-closed audience projection;
- `pnpm test:p2-de-dim-hotfix` — Direct Entry reporting dimensions and scoped-facts behavior;
- `pnpm test:main` — P1 reporting/read-model/filter/pagination contracts;
- `pnpm test:p1.6-i04c3-s01` and `pnpm test:p1.6-i04c2b` — full function/catalog boundaries and migration application inventory;
- W04A/W04C migration and reconcile tests (`scripts/p2-w04a-migration.test.mjs`, `scripts/p2-w04a-reconcile-verify.test.mjs`) as standalone historical/reconciliation gates;
- canonical `pnpm test` once the new lane is registered.

No Production query, migration apply, deployment, browser UAT or real-data acceptance belongs to this preflight.

### 5.3 Ledger impact

The current base has 84 migration files and the last file is `20261011170000_p3_1_w03a_r2_r1_account_read_repair.sql`. A later implementation adds exactly one migration, so the implementation must sweep:

- live ledger counts `84 -> 85`;
- distance-from-end `.at(-N)`, `slice(0,-N)` and `names.length-(N)` pins where the referenced migration is before the new tail;
- explicit tail arrays that currently end at #84;
- full-ledger function-inventory counts and any package test chain registration.

Frozen historical controls must remain frozen, including the W04A Production reconciliation expectation of 47 applied migrations. No migration number is reserved by this preflight. The W03B provisional #85 file is not part of this base and must not be copied or referenced as a reservation.

### 5.4 Acceptance and mutation mapping

The implementation evidence must cover the R6 matrix carried by T1C R8. T1B backend focus is:

- **Aggregate/read model:** total equals the sum of all `byTeam` buckets including `unknown`; same stored `team_id` remains historical; `team_active === false` produces the inactive suffix without reaching the client; null/orphan Direct Entry rows go to `unknown`; Vendor stays a known bucket; no second aggregate dimension and no N+1.
- **Drill-down:** page default 25/max 100; stable opaque cursor; cursor beyond last page returns an empty page with `nextCursor=null`; thin parser rejects non-allowlisted fields and `source`; only `all` may drill down; `team`/`own` fail closed.
- **Totals:** known-team `total` equals the bucket `recruitedCount`; unknown `total` is anomaly-row count only; `legacy_aggregate_total.recruited_count + total = byTeam["unknown"].recruitedCount`.
- **Route/security:** the route itself calls `guardApiSession()` and maps 401 `UNAUTHENTICATED`, 403 `ACTOR_NOT_AVAILABLE`/audience failure, 400 `INVALID_FILTER`, and 503 `REPORTING_QUERY_FAILED`; bucket keys are canonical/opaque and never raw UUID/code/display name; rows have exactly seven sanitized fields and no `team_active`; audience is re-resolved inside the RPC.
- **Migration:** exactly one append-only migration; earlier bytes unchanged; live `pg_get_viewdef`/`pg_get_functiondef` patch with exact expected counts; W02C employment-display patch and W07A no-team-options invariant survive.

R6 mutations M1-M29 remain applicable. R7/R8 add:

- **M30:** re-emit the W04A/W05A facts view or scoped-facts body and drop the W02C patch; migration/body self-check must fail.
- **M31:** build a second project/provider/employment aggregate inside the team report; read-model/acceptance test must fail.
- **M32:** render team chart/tabs for `team` or `own`; this is T1A UI coverage, not T1B implementation.
- **M33:** drop `team_active` or derive inactivity from absence/catalog/client data; E12/E30 must fail.
- **M34:** omit the Route Handler's own `guardApiSession()` or trust client actor/audience; E28 must fail.
- **M35:** extend the shared parser or accept `source` on drill-down; E31 must fail.

This preflight does not execute mutation probes because it is docs-only.

## 6. Required evidence for the later implementation

The later T1B lane must produce test evidence for at least:

- `total = sum(byTeam)` including `unknown`; known-team drill-down `total` equals bucket count; unknown drill-down `total` is anomaly rows only and reconciles with the legacy aggregate;
- an inactive team remains a named bucket and does not become Unknown; the inactive suffix is composed server-side from `team_active`, which never reaches the client;
- historical membership changes do not rewrite a fact's stored team attribution;
- the reserved Vendor team appears as a known Vendor bucket;
- the route rejects missing/invalid sessions independently of `/dashboard`, and team/own actors cannot drill down and receive only the sanitized reporting error;
- no UUID, raw team code, bucket key, entry ID or other internal identifier appears in a drill-down row;
- malformed bucket key, non-canonical alias, unknown bucket token, bad date, bad dimension, invalid source/extra field, bad cursor and invalid limit fail closed with `INVALID_FILTER` where specified;
- cursor pagination returns complete, ordered pages without N+1 queries;
- W02C dynamic employment display remains authoritative after the W05B migration;
- no `team` option is added to the existing filter catalog.

## 7. Blockers and decisions for T0/T1C

1. T0 must review/accept the T1C R8 current-main contract before implementation. This memo does not alter or independently ratify that contract.
2. T0 must allocate the eventual migration filename after approval. `#85` is only the current next slot observation; no reservation is made here.
3. R8 has one internal wording conflict that T1C should close before implementation: §4.2/§10 require four added fields (`team_id`, `team_code`, `team_display_name`, `team_active`), while §6's self-check prose still says three columns/keys. This preflight does not choose which contract text wins.
4. The exact Route Handler is now locked by R8 as `GET /api/reporting/team-drill-down` in `src/app/api/reporting/team-drill-down/route.ts`, with its own `guardApiSession()`, `runtime="nodejs"`, `dynamic="force-dynamic"`, no-store/security headers and the R8 status/code mapping. Implementation must follow that boundary.
5. The current shared employment filter set remains intentionally unchanged by R8. The W02C catalog contains a newer labor type, so the later implementation must test the locked thin-parser behavior rather than silently widen `parseReportingFilters()`.
6. T1A UI work remains downstream: two-tab BoD presentation, team chart, bucket list and unknown panel must not be opened in this T1B preflight.

No live implementation blocker was found in the existing reporting call graph. The gating dependencies are T0 contract approval and closure of the R8 four-versus-three self-check wording conflict, not a missing reusable reporting path.

## 8. Explicit boundary

This lane changed no source, migration, API, UI, package, dependency, lockfile or contract file. It did not query or write Production, apply migrations, deploy, run browser/UAT, reserve a migration number, merge `main` or continue W03B implementation.

Implementation is **not opened**. The requested handoff state is:

`P3_W05B_A_S0_BACKEND_PREFLIGHT_PASS_AWAITING_T0_REVIEW`
