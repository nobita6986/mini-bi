# P3-W05B-S0 — BoD recruitment reporting by team (Survey / Contract Lock)

> **Status:** `P3_W05B_S0_BOD_TEAM_REPORTING_SURVEY_PASS_AWAITING_T0_REVIEW`
> **Base:** `origin/main@5f41caf689dbfd52bb889744f227aa659da393db`
>   (`fix(projects): compact table layout without forced scroll`).
> **Branch:** `audit/p3-w05b-s0-bod-team-reporting-survey`
> **Authority (locked sources, in order of priority):**
>   1. `docs/master-plan.md` §9 (P3 — Authentication + Organization + Permission) and §10
>      (P4 — KPI & Performance) — "Dữ liệu lịch sử giữ đúng bối cảnh tại thời điểm phát
>      sinh; chuyển team không viết lại kết quả cũ" and "team lịch sử xác định theo
>      business date" and "Nhân viên chuyển team không làm thay đổi phân bổ kết quả lịch
>      sử. Quyền Leader xem dữ liệu trước/sau thời điểm nhận team phải có quy tắc được
>      duyệt và ca kiểm tra riêng; không mặc định mọi Leader hiện tại thấy toàn bộ
>      lịch sử."
>   2. `docs/handoffs/p3-w05a-actor-scoped-reporting-team-scope.md` — actor-scoped
>      reporting (`direct_entry_reporting_resolve_audience`, `_authorized_entries`,
>      `_scoped_facts`, `_scoped_options`).
>   3. `docs/handoffs/p3-w06c-bod-team-own-dashboard.md` — audience-aware
>      BoD/Team/Own dashboard dispatch.
>   4. `supabase/migrations/20261008080000_p3_w05a_actor_scoped_reporting.sql` (W05A
>      migration #48) and `20261007020000_p2_w04a_direct_entry_reporting_cutover.sql`
>      (W04A reporting seam, view `direct_entry_reporting_facts_v01`).
>   5. `docs/handoffs/p3-1-w01c-b-team-membership.md` and
>      `p3-1-hf-legacy-team-leader-scope.md` — team-membership history and the legacy
>      leader-scope compatibility rules.
> Where this memo and those sources differ, those sources win.

## 0. Why a new contract

The BoD dashboard today (`mode.kind === "all"`, rendered in
`src/components/dashboard/dashboard-view.tsx` → `DashboardBody`) breaks the
scoped-fact payload by **project / recruiter / provider / employment / date** but
has no team dimension. The W05A scoped payload already proves that:
- an `all` audience is the only audience that may see the legacy aggregate
  (`daily_recruitment_breakdown`, business_date < cutoff), and that aggregate
  **has no team column** at all (`p0_daily_recruitment_breakdown_foundation.sql`
  lines 60–80);
- a `team` / `own` audience sees only Direct Entry rows where
  `direct_entries.team_id` is the **team at first_work_date** (the row was
  authored against the team in effect when the entry was saved — see
  `direct_entry_reporting_authorized_entries` in W05A migration, lines 198–234).

W05B adds the missing team breakdown to the BoD view **and** a server-side
drill-down within each team. The team attribution rule is the historical one:
**the team of the row is the team stored on the row at the time the fact was
saved** (Direct Entry: `direct_entries.team_id`; legacy: bucket `__unknown__`),
never the team of the recruiter today, never the team of the actor looking at
the report.

This survey is docs-only. No source, migration, API, UI, dependency,
Production query, apply, deploy, browser, CUA, screenshot, UAT, migration
number reservation, or merge to main is part of this work.

## 1. Current truth (what exists at `5f41caf`)

### 1.1 Reporting fact grain

`src/lib/reporting/p1-reporting.ts` defines `ReportingFact` with one row per
Direct Entry eligible row (1 row per `entry_id` post-cutover; 1 row per
breakdown grain pre-cutover) and the columns:

```
source_id, business_date, project_key/display, recruiter_key/display,
provider_type_key/display, employment_type_key/display, recruited_count,
first_work_date, entry_id, submission_id, cutoff_date
```

The `ReportingData` aggregate carries `byDate`, `byProject`, `byRecruiter`,
`byProvider`, `byEmployment`, `projectProviderMix`, `coverage`, `sources`,
`dateExtent`, `empty` — **no `byTeam`**. The W05A scoped RPC
(`direct_entry_reporting_scoped_facts`, migration line 252) builds this
identical grain; it does not surface `team_key` / `team_display`.

`direct_entry_reporting_facts_v01` (defined in
`p2_w04a_direct_entry_reporting_cutover.sql` lines 273–320) joins
`direct_entries` + `direct_entry_submissions` + `direct_entry_projects` +
`recruiters` and explicitly does **not** project `team_id`. The post-W05A
comment "Service-role-only" is unchanged.

`daily_recruitment_breakdown` (defined in
`p0_daily_recruitment_breakdown_foundation.sql` lines 60–80) has columns
`source_id, business_date, project_key, project_display, recruiter_key,
recruiter_display, provider_type_key, provider_type_display, employment_type_key,
employment_type_display, recruited_count, sync_run_id, snapshot_at,
created_at, updated_at` — **no team column**. The legacy aggregate is
unattributable to a team by schema.

### 1.2 Audience model (W05A)

`direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id)`
returns the locked priority audience and a sanitized jsonb projection
`{ audience, label, team_ids, recruiter_id }` (no auth subject, no app-user
UUID, no grant UUID, no email). The kinds are `all` / `team` / `own` with
priority `all > team > own`. The shared predicate
`direct_entry_reporting_authorized_entries` materializes the eligible
`entry_id` set for the resolved audience. The facts RPC, the options RPC and
the server read path (`fetchCutoverReporting` in
`p2-w04a-reporting-server.ts`) all consume this same predicate, so the
audience rule is expressed exactly once.

### 1.3 Dashboard dispatch (W06C)

`resolveDashboardMode` in `src/lib/reporting/p3-w06c-audience-view.ts`
returns one of `{kind: "error"}` / `{kind: "all"}` / `{kind: "team"}` /
`{kind: "own"}`. The `all` mode currently renders
`DashboardBody` (in `dashboard-view.tsx`) with cards keyed by date, project,
HRP/Vendor, recruiter (top 10), employment and the project × provider mix.
The `team` mode renders `TeamDashboardView` (member contribution ranking,
team trend, team project / provider / employment). The `own` mode renders
`OwnDashboardView`. A successful read with no usable audience resolves to
`error` and never renders facts under a guessed scope label.

### 1.4 Filter pipeline (W05A / W04A / W06C)

`src/lib/reporting/p1-filter.ts::parseReportingFilters` is the single
filter parser for `from`, `to`, `project`, `recruiter`, `provider`,
`employment`, `source`. The W05A scoped RPC accepts only the same
JSONB-shaped filter; an out-of-scope requested filter yields an empty
result, never an error, and never a non-empty result computed against an
out-of-scope set. The legacy `source` filter is only honored for a
DB-confirmed `all` audience (`p3-w05a-source-filter.ts`).

### 1.5 What does not exist yet

- No `byTeam` aggregate on `ReportingData`.
- No `team_key` / `team_display` in the scoped fact payload.
- No server-side drill-down endpoint that returns fact rows under a chosen
  team + filter combination with bounded pagination and a sanitized row
  shape.
- No team option in `direct_entry_reporting_dimension_options_v01`
  (verified by the W07A-R4 hotfix: "the real reporting view emits no team
  dimension").
- No BoD-by-team chart, no team-scoped drill-down UI.

## 2. Target contract (locked)

### 2.1 BoD chart broken down by team

The BoD view (`mode.kind === "all"`) renders a new card set in the
"Phân bổ tuyển dụng" section:

- **Biểu đồ theo nhóm** — a primary chart (donut or bar, decided in T1A)
  whose buckets are the active+historical team display names that have at
  least one fact in the current filter window. Each bucket's `recruitedCount`
  is the sum of `recruited_count` over facts whose team attribution resolves
  to that team (see §2.2 for the attribution rule). Buckets are sorted by
  count desc, then by `display` ascending (stable Vietnamese collation), and
  are emitted alongside the existing per-team detail list (so the chart and
  the list share a single bucketing function).
- A "Không xác định" bucket MUST exist whenever any Direct Entry fact in the
  result has no resolvable team (see §2.3) and MUST be displayed last, with
  the same shared display rules as `p1-reporting.ts::selectDisplay`. The
  legacy aggregate contributes fully to this bucket because it has no team
  column (see §1.1). The bucket's label is fixed: "Không xác định".
- Every `recruitedCount` shown in the team chart equals the corresponding
  bucketed count in the read-model. The team chart and the total
  `recruitedTotal` agree (the BoD total is the sum of all team buckets plus
  the unknown bucket).

### 2.2 Historical attribution rule (the master-plan guarantee)

For every Direct Entry fact, the team attribution is:

```
team = e.team_id at the time the entry was saved (i.e. the team_id currently
       stored on the direct_entries row; this value is set when the entry is
       authored and is NOT rewritten when the recruiter later changes team
       or when a leader transitions)
```

This is enforced by the W05A predicate
`direct_entry_reporting_authorized_entries` already, which joins
`direct_entries` directly and uses the `team_id` column as the join key for
`team` audience filtering. The W05B work does not add a new lookup; it
exposes the **same** `team_id` on the fact payload so the read-model can
group by it.

- The W05A "team" audience filter `e.team_id = any(v_team_ids)` is keyed on
  the row's stored `team_id` (not on the recruiter's current team). The
  W05B team breakdown reuses the same field and the same rule.
- If the team has since been renamed, deactivated or its `display_name`
  changed, the row's team attribution for that fact row is **the team that
  existed at the time the entry was saved**, and the row's `team_display`
  in the breakdown is the current `teams.display_name` (joined from the
  current row). The historical name is not preserved as a separate value
  (master plan does not require a per-row `team_display_at_fact` snapshot;
  this is locked by §2.2.1 below).
- A row whose `team_id` no longer matches any row in `teams` (orphan) is
  bucketed as "Không xác định" with the sentinel `__unknown__` key, not
  silently dropped and not re-attributed to a current recruiter's team.

**§2.2.1 (locked — no name-snapshot lookup):** W05B does NOT introduce a
`team_display_at_fact` or `team_history` lookup. The historical attribution
uses the row's `team_id` and the **current** `teams.display_name`. Renames
that happen after the fact are visible retroactively (this matches the W05A
audience label, which already reads the current display name). A future
audit-grade history view is out of scope.

**§2.2.2 (locked — recruiter's current team is NEVER used):** the BoD chart
and the team drill-down never join `recruiter_team_memberships` /
`recruiter_provider_memberships` to attribute a fact to a current team.
The recruiter-attribution key is `recruiter_key` (already in the grain);
the team-attribution key is the row's `team_id`, not a membership join.
This is the master-plan guarantee "Nhân viên chuyển team không làm thay đổi
phân bổ kết quả lịch sử."

### 2.3 Unknown bucket (mandatory)

A Direct Entry fact contributes to the "Không xác định" team bucket iff any
of the following hold:

- `e.team_id IS NULL` (cannot happen by schema, but the bucket must still
  defend against it — the read-model never assumes the schema is
  self-enforcing);
- `e.team_id` does not match any row in `public.teams` (orphan);
- The team's `active = false` AND the user has not opted in to "include
  inactive teams" (which is **out of scope for W05B** — the W05B team
  breakdown defaults to active teams only; see §2.4).

The legacy aggregate contributes fully to the "Không xác định" bucket
(because the legacy `daily_recruitment_breakdown` has no team column at
all). The `recruitedCount` of the unknown bucket is the sum of legacy
`recruited_count` plus any orphan or inactive-team Direct Entry rows that
match the current filter window. The BoD total equals the sum of the
known-team buckets plus the unknown bucket; this is an invariant the
W05A server test must hold.

### 2.4 Scope authority (DB / server, never client)

- The audience (`all` / `team` / `own`) is resolved server-side by
  `direct_entry_reporting_resolve_audience` (W05A) and is the **sole**
  authority. The BoD view (`mode.kind === "all"`) is reachable only when
  the DB returns `audience = "all"`. A `team` / `own` actor never sees the
  BoD team chart, the BoD chart, the BoD totals, or any per-team
  breakdown.
- The team breakdown for a BoD actor is the **full** set of teams with at
  least one fact in the result, restricted to **active** teams by default.
  An inactive-team row contributes to "Không xác định" (see §2.3) — there
  is no client-side toggle to include inactive teams in W05B. A future
  enhancement may add that toggle, but it is **out of scope** here and
  would require its own T0 decision.
- No client-side role check widens the data. The BoD actor arrives at the
  BoD page only because `decideSessionPageAccess` returned `ALLOW` and
  `fetchCutoverReporting` returned `{ ok: true, audience: {kind: "all"} }`.
  Removing either of those gates causes the page to fail closed (the W06C
  error mode already covers this).
- A `team` / `own` actor who navigates to the BoD URL receives the team
  or own dashboard, never a BoD team chart. The W06C dispatch is the only
  entry point.

### 2.5 Drill-down within a team (server-side, bounded)

W05B adds a server-side **team drill-down** endpoint. The endpoint is
reached from the BoD view (the BoD team chart is interactive; clicking
or focusing a team bucket opens the drill-down). The drill-down contract:

- **Request:** `{ team_key: string, from?: string, to?: string, project?:
  string, recruiter?: string, provider?: string, employment?: string,
  cursor?: string, limit?: number }`. `team_key` is the team display key
  used in the BoD chart bucket; the special sentinel
  `team_key = "__unknown__"` is also accepted and renders the unknown
  bucket's rows. `team_key` is a sanitized display identity (the
  `selectDisplay` winner over the team's current `display_name`); it is
  **not** the `team_id` UUID, **not** a `recruiter_id`, **not** a
  `scope_team_id`. The server resolves the `team_key` to a `team_id` set
  inside the RPC.
- **Scope is BoD-only:** the endpoint is reachable only when the
  DB-resolved audience is `all`. A `team` or `own` actor who calls the
  endpoint with the correct `team_key` for a team outside their own
  effective scope is rejected with the existing `REPORTING_QUERY_FAILED`
  error (no 404 leak, no empty list). The shared audience predicate
  (`direct_entry_reporting_authorized_entries`) is the gate.
- **Server-side, bounded pagination:** the response is
  `{ rows: DrillDownRow[], nextCursor: string | null, total: number,
  applied: ReportingFilters, team: { key, display } }`. `limit` is
  optional, default 25, max 100. `cursor` is an opaque server-issued
  string. The total count returned equals the total fact count for the
  filter set (no client-side recomputation), and the total agrees with the
  BoD team's bucket count for the same filter set (a server test pins
  this).
- **Filters only narrow:** the drill-down filter set is the same parser
  (`p1-filter.ts::parseReportingFilters`) plus a required `team_key`. Any
  filter not in that list is rejected as `INVALID_FILTER`. The
  `source` filter is not exposed to the drill-down (drill-down is Direct
  Entry scoped; legacy aggregate is part of the BoD team chart as
  "Không xác định" only, and the drill-down never pages through legacy
  rows because legacy rows are aggregated).
- **PII / data minimization:** `DrillDownRow` is the minimal sanitized
  shape: `business_date, project_display, recruiter_display,
  provider_type_display, employment_type_display, recruited_count,
  first_work_date`. The row **must not** include `entry_id`, `submission_id`,
  `source_id`, `drive_file_id`, `file_name`, `recruiter_key`,
  `project_key`, `provider_type_key`, `employment_type_key`, `team_id`,
  `team_key`, `auth_subject`, `app_user_id`, or any other internal
  identifier. The server test pins the row shape.
- **Drill-down first dimension: recruiter.** The drill-down is sorted by
  `recruiter_display` ascending then `business_date` descending then
  `entry_id` ascending (the existing grain tie-breaker). The page
  surfaces the recruiter display only (the bucket identity), never the
  recruiter_key. The T1A UI may group rows by `recruiter_display` and
  show a per-recruiter subtotal; the subtotal equals the per-recruiter
  sum that the BoD chart's recruiter breakdown would compute for the
  same filter set, projected against the scoped audience.
- **No unbounded list.** A `limit` above 100 is rejected as
  `INVALID_FILTER`. A request without `limit` uses the default 25. A
  request that asks for `nextCursor` beyond the available rows returns
  `{ rows: [], nextCursor: null, total, applied, team }` (no error, no
  out-of-scope leak). The server test pins the upper bound and the empty
  next-page contract.

**§2.5.1 (locked — only one drill-down dimension in W05B):** the first
drill-down dimension is **recruiter**. The BoD chart's other dimensions
(project, provider, employment) are already exposed as filters on the
BoD page (`p1-filter.ts`); the user can re-apply those filters at the
BoD level to narrow the team chart itself. A **second** drill-down
endpoint that re-buckets by project / provider / employment is **out of
scope** for W05B and would require its own T0 decision because it would
need additional pagination, a different row shape (aggregated rows, not
fact rows) and a different sorting contract. The survey records this as
a deferred extension (§6) and not as part of the locked contract.

### 2.6 Architecture (reuse, no N+1, no migration number reserved)

- **Reuse W05A:** the BoD team chart and the drill-down both consume the
  **same** audience predicate (`direct_entry_reporting_authorized_entries`)
  and the **same** eligibility filter (state='SUBMITTED', deleted_at IS
  NULL, first_work_date >= cutoff, all audience). The W05A RPC
  `direct_entry_reporting_scoped_facts` is the **single source of facts**
  for both the BoD chart and the drill-down. The drill-down is a
  **separate** RPC (`direct_entry_reporting_team_drill_down`, locked name)
  that intersects the authorized set with the requested `team_key` set
  and applies the same filter parser. The drill-down does **not** re-derive
  audience; it requires the caller to pass the audience already resolved
  by the W05A resolver, and the drill-down RPC **re-resolves** audience
  internally to ensure the call is BoD-authoritative (a defense-in-depth
  re-check, even when the caller already supplied it).
- **Reuse W06C:** the team chart card is a new entry in
  `DashboardBody` (BoD). The dispatch is unchanged: the new card is
  rendered only when `mode.kind === "all"`. The team drill-down is a
  new section; it is **not** added to the `team` or `own` dashboards
  (those audiences never see the BoD chart or the drill-down).
- **No N+1 query:** the BoD read path uses one call to
  `direct_entry_reporting_scoped_facts` and one call to
  `direct_entry_reporting_scoped_options`. The team chart bucket and
  total are computed from the same fact array in the read-model
  (the W05A page test pins "no TS audience inference" and
  "no pre-RPC global metadata read"; W05B adds the same pin for the
  team dimension: "no client-side team join"). The drill-down uses one
  call to `direct_entry_reporting_team_drill_down` (no loop, no per-row
  RPC).
- **Migration:** W05B does **not** add a migration. The W05A
  `direct_entry_reporting_facts_v01` view will need to project
  `team_id` and the current `teams.display_name` as
  `team_key` / `team_display` so the RPC can carry them, and the
  `direct_entry_reporting_scoped_facts` RPC will need to add the same
  fields to its jsonb fact output. The W05A
  `direct_entry_reporting_resolve_audience` already returns `team_ids`
  and a label, so the audience side needs no change. This is an
  **in-place column-add** on the view and a **non-breaking additive
  change** on the RPC's jsonb shape (new keys; existing keys
  unchanged). The migration number is **not reserved in this memo**;
  T0 allocates the slot when the W05B implementation task is scheduled.
  The slot appends after the current `main` SHA; W05B does not rewrite
  any existing migration.
- **No new dependency, no new package, no new RPC framework.** Reuses
  the W05A `service_role` only execute grant and the
  `SECURITY DEFINER` + fixed `search_path` posture.

### 2.7 Allowed / denied matrix (audit-grade)

The matrix below pins what each actor kind sees for each new surface.

| Surface | `all` (DB-confirmed) | `team` (DB-confirmed) | `own` (DB-confirmed) | anonymous / failed actor / malformed audience |
|---|---|---|---|---|
| BoD layout (`mode.kind === "all"`) | Renders, including the new BoD-by-team chart and totals | Never reached (W06C dispatch fails closed) | Never reached | Never reached (W06C error mode) |
| BoD team chart bucket count | Renders per-team buckets + "Không xác định" | Never reached | Never reached | Never reached |
| BoD team chart total vs. `recruitedTotal` | Equal (server test pin) | Never reached | Never reached | Never reached |
| Team drill-down endpoint (new RPC) | Renders sanitized rows for the requested `team_key` (incl. `__unknown__`); respects filter parser; respects bounded pagination | Rejected with `REPORTING_QUERY_FAILED` (the caller's audience is `team`; no leak, no 404) | Rejected with `REPORTING_QUERY_FAILED` (same reason) | Rejected with `REPORTING_QUERY_FAILED` (audience is null / not `all`) |
| Team drill-down row shape | Only `business_date, project_display, recruiter_display, provider_type_display, employment_type_display, recruited_count, first_work_date` | n/a | n/a | n/a |
| Team drill-down `limit` | Default 25, max 100; >100 → `INVALID_FILTER` | n/a | n/a | n/a |
| Team drill-down `cursor` | Opaque server string; out-of-range returns empty page + `nextCursor: null` | n/a | n/a | n/a |
| Filter outside the W05A parser | Rejected as `INVALID_FILTER` | n/a | n/a | n/a |
| Unknown team (no team_id, orphan, or inactive team) | "Không xác định" bucket (legacy aggregate contributes fully) | n/a | n/a | n/a |
| Inactive-team rows in BoD team chart | Contributes to "Không xác định" (out of scope to expose a toggle in W05B) | n/a | n/a | n/a |

### 2.8 Acceptance / mutation plan

The T0 acceptance gates are:

- **E1: BoD by team happy path.** With a DB-confirmed `all` audience and
  a known filter window, the BoD layout renders the team chart card and
  the new buckets. Each bucket's `recruitedCount` equals the sum of
  `recruited_count` over the matching fact rows. The total of the
  buckets plus the unknown bucket equals `recruitedTotal`. The
  `recruitedTotal` equals the team-of-row sum computed from the
  authorized-fact set.
- **E2: historical attribution.** A Direct Entry row whose
  `team_id = T1` and whose recruiter later transfers to team `T2` is
  bucketed under `T1` (display name is the current `T1.display_name`)
  for every filter window covering that fact's `business_date`. The
  test seeds a fact with `team_id = T1` then a recruiter transfer, and
  asserts the BoD team chart and the team drill-down both show `T1`.
- **E3: unknown bucket.** A Direct Entry row whose `team_id` no longer
  matches any row in `teams` is bucketed as "Không xác định". The
  legacy aggregate is bucketed as "Không xác định" regardless of any
  team join. The total of the unknown bucket agrees with the legacy
  count plus the orphan-count for the same filter window.
- **E4: drill-down happy path.** A BoD request with a valid
  `team_key`, a valid filter set and `limit=25` returns the first page
  in `business_date` / `recruiter_display` / `entry_id` order, the
  `nextCursor` matches the next page, the second page returns the
  remainder, and the `nextCursor` is null on the last page. The total
  returned equals the team's per-team total for the same filter set.
- **E5: drill-down re-derives audience.** A drill-down request whose
  caller is a `team` or `own` actor is rejected with
  `REPORTING_QUERY_FAILED`. The drill-down never reuses a caller-
  supplied audience value; the W05A resolver is the only authority
  inside the RPC.
- **E6: drill-down row shape.** The response row contains exactly the
  seven sanitized fields listed in §2.5. A test pins the response row
  shape and rejects any added field (especially `entry_id`, `team_id`,
  `recruiter_key`).
- **E7: drill-down bounded.** A `limit=101` request is rejected with
  `INVALID_FILTER`. A `limit=0` is rejected with `INVALID_FILTER`. A
  request with a non-numeric `limit` is rejected. A request with a
  `cursor` that does not decode to a real offset is rejected.
- **E8: drill-down filter parity.** A drill-down request with
  `from > to` is rejected as `INVALID_FILTER`. The drill-down reuses
  the W05A filter parser, so the same filter errors propagate.
- **E9: BoD team chart card placement.** The card is rendered only
  inside the BoD `mode.kind === "all"` branch. A `team` audience sees
  no BoD card. A `own` audience sees no BoD card. A failed read sees
  the W06C error mode.
- **E10: no client-side scope widening.** Removing the audience
  resolver in the drill-down RPC (or in the BoD server) makes the
  drill-down fail with `REPORTING_QUERY_FAILED` and the BoD team
  chart fail with the W06C error mode. The test pins this in both
  directions.

**Mutation cases** (each makes the corresponding E test fail, then is
restored to byte-equivalent code; the migration file hash stays
unchanged):

| Mutation | Failing E test(s) |
|---|---|
| Drop `team_key` / `team_display` from the view | E1, E2, E3 |
| Use `recruiter_team_memberships` (or `recruiter_provider_memberships`) to attribute a fact to a current team | E2 |
| Skip the unknown bucket | E3 |
| Add `entry_id` / `team_id` / `recruiter_key` to the drill-down row | E6 |
| Remove the drill-down audience re-check | E5, E10 |
| Cap `limit` at 200 in the server | E7 |
| Apply the W05A filter parser to a new filter key in the drill-down (e.g. an unrestricted text search) | E8 |
| Render the BoD team chart for a `team` audience | E9, E10 |
| Remove the legacy aggregate from the unknown bucket | E3 |
| Compute the team bucket on the client (the W05A page-test pin) | E1 |

## 3. Boundary (what this memo does NOT do)

- No source, migration, API, dependency, route, UI, or Production change.
  No `pnpm install`, no `package.json` / `pnpm-lock.yaml` edit, no
  `tsconfig.json` edit. No Production query, no apply, no deploy, no
  browser, no CUA, no screenshot, no UAT.
- No migration number reservation. T0 allocates the migration slot
  when the W05B implementation task is scheduled.
- No new RPC framework, no new capability token, no new role engine, no
  new grant creation rule, no new rev-grant pattern, no new
  `search_path` policy. The W05A `SECURITY DEFINER` + fixed
  `search_path = pg_catalog, public` posture is reused for the new
  drill-down RPC.
- No edit to the W05A RPC's existing keys (audience, facts, sources,
  latest_runs, presence). The new `team_key` / `team_display` fields
  are additive on the fact grain. The W05A tests stay green.
- No edit to `docs/P3.1.md`, `docs/P4.md`, `docs/master-plan.md`,
  `package.json`, `pnpm-lock.yaml` or any existing
  `src/**` / `supabase/**` / `scripts/**` / `docs/**` file in this
  survey.
- No split into T1B / T1A in this memo. The proposed split is recorded
  in §4 for T0's review but is **not committed** until T0 approves the
  contract.

## 4. Proposed T1B / T1A split (for T0's review, not committed)

The split is proposed only; the implementation does not start until T0
approves the contract above.

### 4.1 T1B (backend / SQL)

- Add `team_id` and `team_display` to the in-place projection of
  `direct_entry_reporting_facts_v01` (left-join to `public.teams`).
  The team row's `display_name` is the **current** display name; the
  `team_id` is the row's stored `team_id`. No `team_history` snapshot.
- Extend `direct_entry_reporting_scoped_facts` to add
  `team_key` (= the same `team_id::text`) and `team_display` (= the
  joined `teams.display_name`, or `"Không xác định"` for null/orphan)
  to every fact in the returned jsonb. The existing keys
  (`audience`, `facts`, `sources`, `latest_runs`, `presence`) are
  unchanged. The fact ordering is unchanged.
- Add a new RPC `direct_entry_reporting_team_drill_down(p_auth_subject,
  p_app_user_id, p_team_key, p_filters jsonb, p_cursor text, p_limit
  int)` returning `{ rows, next_cursor, total, applied, team }`. The
  RPC re-resolves the audience; if the audience is not `all`, it
  returns the existing `REPORTING_QUERY_FAILED` error code. The RPC
  uses the shared authorized-row predicate
  (`direct_entry_reporting_authorized_entries`) plus a `team_key` set
  resolved inside the RPC. The fact row shape is the seven sanitized
  fields in §2.5.
- Extend the read-model in `p1-reporting.ts` to compute `byTeam` from
  the same scoped-fact array. `byTeam` uses the same
  `groupByDimension` helper, with `team_id` as the key and the joined
  `teams.display_name` as the display, and the unknown sentinel
  `__unknown__` for null / orphan / inactive rows. The `recruitedTotal`
  invariant (`total = sum(byTeam)`) is a server test pin.
- Add a new server endpoint `fetchCutoverTeamDrillDown(params, actor)`
  in `p2-w04a-reporting-server.ts` (or a new sibling) that calls the
  new RPC, applies the same filter parser, applies the same
  `dbKind === "all"` gate, validates `limit` (default 25, max 100),
  and returns the sanitized shape. The existing `fetchCutoverReporting`
  is unchanged.
- Update `ReportingData` to add `byTeam: Record<string, ReportingBucket>`
  (additive). Update `DashboardBody` (T1A reads this) to render the
  team chart card; this is the only T1A change.
- Tests: extend `p3-w05a-page.test.mjs` to pin "no client-side team
  join" and "byTeam is computed in the read-model, not on the client".
  Extend `p3-w05a-source-filter.test.mjs` is not touched. Add a new
  `p3-w05b-team-drill-down.test.mjs` that pins the row shape, the
  bounded pagination, the audience re-check, the filter parity, the
  unknown bucket, and the historical attribution rule. Add a new
  `p3-w05b-by-team.test.mjs` that pins the `byTeam` aggregate against
  the `recruitedTotal` invariant. Extend
  `p3-w05a-page.test.mjs` with "fetchCutoverReporting carries byTeam
  in the result".

### 4.2 T1A (UI)

- Add a new card to `DashboardBody` in
  `src/components/dashboard/dashboard-view.tsx` rendering the
  `byTeam` chart (donut or bar) and a per-team list. The card is
  rendered only inside the BoD branch (no `team` / `own` audience
  reaches it).
- Add a new team drill-down panel inside the BoD layout. The panel
  opens when the user focuses or clicks a team bucket (keyboard
  activation also supported). The panel calls
  `fetchCutoverTeamDrillDown({ team_key, ...filters, cursor, limit })`
  and renders the sanitized rows. The panel does **not** include any
  other field. A "no data" empty state renders when the team has no
  fact in the current filter window.
- The panel respects the same date / project / provider / employment /
  recruiter filter pipeline as the BoD page. The "Không xác định"
  bucket opens a panel labeled "Chi tiết: Không xác định" and renders
  the unknown-bucket rows (legacy aggregate + orphan / inactive-team
  Direct Entry). The legacy rows render with `first_work_date = null`
  (the existing sanitization), which the UI displays as "—".
- The panel paginates with a "Tải thêm" button; the cursor is opaque
  and is the next page's `nextCursor`. The button is disabled when
  `nextCursor` is null. There is no infinite-scroll, no auto-fetch.
- Reuse `Card`, `KpiCard`, `EmptyState`, `ErrorState`, `Alert`, the
  `ProjectDonut` / `ProviderDonut` / `RecruiterBarChart` chart
  components, and the design tokens. No new visual primitive.
- No new dependency. The drill-down URL is a server route guarded by
  the same session/actor check as the BoD page (the page-level
  `decideSessionPageAccess` runs first, then the server endpoint
  re-derives the audience).

### 4.3 Out of scope for both lanes (explicit)

- A second drill-down dimension (project / provider / employment). A
  future W05C may add it; it is **not** part of W05B.
- A toggle to include inactive teams in the BoD chart. A future
  W05D may add it; it is **not** part of W05B.
- A "team display name at the time of the fact" snapshot. The W05B
  rule is the current display name (see §2.2.1). A future
  audit-grade view may add a snapshot; it is **not** part of W05B.
- A per-team dashboard for the BoD view (the W06C `team` dashboard is
  unchanged and is the dedicated team view; the BoD team chart is the
  cross-company team breakdown).
- A change to the W05A `all > team > own` priority. The priority is
  locked at W05A and is not altered by W05B.
- A change to the W05A legacy-aggregate aggregation. The legacy
  aggregate contributes fully to "Không xác định" (see §2.3); no
  legacy-side join to a team is added.
- A change to the W05A source filter posture. The drill-down never
  exposes `source`; the BoD team chart is filter-narrowing only.

## 5. Risk register

- **R1 — recruiter's current team accidentally used.** Risk: a
  developer joins `recruiter_team_memberships` to "fix" the unknown
  bucket. Mitigation: the master-plan guarantee and §2.2.2 lock the
  rule. E2 / M2 / M9 / M10 fail closed.
- **R2 — legacy rows mis-attributed to a team.** Risk: a developer
  re-joins the legacy `daily_recruitment_breakdown` to a current team
  via `recruiter_key`. Mitigation: §1.1 + §2.3 lock the rule; the
  legacy aggregate is bucketed as "Không xác định" in full. E3 / M9
  fail closed.
- **R3 — drill-down PII leak.** Risk: a developer adds `entry_id`
  or `team_id` to the drill-down row. Mitigation: §2.5 + §2.7 lock
  the row shape; E6 / M4 fail closed.
- **R4 — drill-down audience bypass.** Risk: a developer trusts a
  caller-supplied audience. Mitigation: §2.4 + §2.5 lock the
  server-side re-check; E5 / E10 / M3 / M9 fail closed.
- **R5 — unbounded drill-down.** Risk: a developer removes the
  `limit` cap. Mitigation: §2.5 + §2.7 lock the cap at 100; E7 / M6
  fail closed.
- **R6 — team-display drift.** Risk: a team's `display_name` changes
  after the fact. Mitigation: §2.2.1 locks "current display name"; the
  BoD chart and the drill-down render the current name. No retroactive
  rename is applied.
- **R7 — migration slot collision.** Risk: a parallel task reserves
  the migration slot that W05B would use. Mitigation: §3 + §4.1
  record "T0 reserves the slot"; the survey does not reserve a number.
- **R8 — read-model N+1.** Risk: a developer computes `byTeam` in a
  loop on the client. Mitigation: §2.6 + the W05A page-test pin
  "no client-side audience join"; the W05B by-team test pin extends
  the same principle. E1 / M10 fail closed.
- **R9 — orphaned teams.** Risk: a `team_id` that no longer matches
  `teams` is silently dropped. Mitigation: §2.3 locks the unknown
  bucket. E3 / M8 fail closed.
- **R10 — `team` audience accidentally reaches the BoD team chart.**
  Risk: the W06C dispatch regresses. Mitigation: §2.4 + E9 + M8
  pin "card is rendered only inside the BoD branch". The W06C
  dispatch is unchanged in W05B.

## 6. Deferred (recorded, not in W05B)

- A second drill-down dimension (project / provider / employment) in a
  W05C follow-up.
- A toggle to include inactive teams in the BoD chart in a W05D
  follow-up.
- A `team_display_at_fact` snapshot for audit-grade history in a
  future W05E follow-up.
- A cross-team comparison panel (e.g. period-over-period by team) in
  a P4 follow-up.
- Per-team KPI / target / achievement in a P4 follow-up. W05B only
  exposes the recruitment count; P4 will compose KPI formulas on top of
  W05B's `byTeam` aggregate.
- A "team-of-the-day" attribution mode that uses a membership
  effective at a specific business date to attribute a fact whose
  `team_id` is null or orphan. This is **explicitly out of scope** in
  W05B (see §2.2.2); the master plan does not require it.
- The Owner browser UAT. No Production access, no migration apply, no
  deploy. Release A / 2A sequencing stays T0's call.

## 7. Authority, decisions recorded, and review pass

- **Authority (locked, in order):** `docs/master-plan.md` §9 + §10 →
  `docs/handoffs/p3-w05a-actor-scoped-reporting-team-scope.md` →
  `docs/handoffs/p3-w06c-bod-team-own-dashboard.md` →
  `supabase/migrations/20261008080000_p3_w05a_actor_scoped_reporting.sql`
  → `supabase/migrations/20261007020000_p2_w04a_direct_entry_reporting_cutover.sql`
  → `docs/handoffs/p3-1-w01c-b-team-membership.md` and
  `p3-1-hf-legacy-team-leader-scope.md`.
- **Decisions recorded (locked in this memo):** team attribution is the
  row's stored `team_id`; the team display name is the current
  `teams.display_name`; "Không xác định" is a mandatory bucket; the
  legacy aggregate contributes fully to "Không xác định"; the BoD
  team chart and the team drill-down are reachable only for a
  DB-confirmed `all` audience; the drill-down is server-side, bounded
  (default 25, max 100), filter-narrowing, sanitized (no UUID, no
  recruiter_key, no project_key, no team_id, no entry_id, no
  submission_id, no source_id, no drive_file_id, no auth subject, no
  app_user_id); the drill-down first dimension is recruiter; no
  migration number is reserved in this memo; no new dependency, no
  new RPC framework, no new grant creation rule; the W05A
  `SECURITY DEFINER` + fixed `search_path` posture is reused.
- **Decisions NOT recorded (deferred, see §4.3 and §6):** second
  drill-down dimension; inactive-team toggle; team-display-at-fact
  snapshot; cross-team period comparison; per-team KPI; Owner browser
  UAT.
- **Review pass:** this memo is `PASS_AWAITING_T0_REVIEW`. T0's
  review will check the four locked decisions in §2.2, §2.3, §2.4,
  §2.5, the acceptance / mutation plan in §2.8, the boundary in §3,
  the T1B / T1A split in §4, and the risk register in §5.
