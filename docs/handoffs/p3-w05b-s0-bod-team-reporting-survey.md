# P3-W05B-S0 — BoD recruitment reporting by team (Survey / Contract Lock)

> **Status:** `P3_W05B_S0_R1_BOD_TEAM_REPORTING_SURVEY_PASS_AWAITING_T0_REVIEW`
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
the report. The chart-to-drill-down identity is the team's
`teams.code` (the W01C-A stable-code invariant), not the `display_name` and
not the `team_id` UUID (see §2.5.2). Inactive teams stay in their own bucket
and are labelled " (Đã ngừng hoạt động)"; the unknown bucket is reserved
for the legacy aggregate and Direct Entry defensive null / orphan only
(see §2.3.1 / §2.3.2). The W05B implementation adds **exactly one**
append-only migration on top of the current `main` SHA (no number reserved
in this memo; T0 allocates the slot — see §2.6 and §3).

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
identical grain; it does not surface `team_id` / `team_code` /
`team_display_name` (the W05B implementation adds these additive
fields — see §2.6).

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
- No `team_id` / `team_code` / `team_display_name` in the scoped
  fact payload (the W05B implementation adds these additive fields
  — see §2.6).
- No server-side drill-down endpoint that returns fact rows under a
  chosen team + filter combination with bounded pagination and a
  sanitized row shape.
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
- **Buckets are keyed by an opaque, stable `bucket_key` token.** The chart
  bucket identity is `bucket_key` (NOT the `display_name`, NOT the
  `team_id` UUID). `bucket_key` is a sanitized token the server maps
  one-to-one to the team fact rows (see §2.5.2 for the contract). The
  UI never infers `bucket_key` from display text; the server is the
  single source of truth. The `display` field on the bucket is a
  current best-effort display label, joined from `teams.display_name`
  at query time; if the team is `active = false`, the display label
  is suffixed with " (Đã ngừng hoạt động)" (the chart card and the
  drill-down title render the same suffix; see §2.3.1 for the
  attribution rule and §2.5.2 for the bucket_key contract). A fact
  whose `team_id` matches no row in `public.teams` (orphan) or whose
  `team_id IS NULL` falls into the "Không xác định" bucket, which is
  the **only** bucket whose `bucket_key` is a sentinel, not a team
  token (see §2.3.1 and §2.5.2).
- A "Không xác định" bucket MUST exist whenever any Direct Entry fact
  in the result has no resolvable team (see §2.3.1) and MUST be
  displayed last, with the same shared display rules as
  `p1-reporting.ts::selectDisplay`. The legacy aggregate contributes
  fully to this bucket because it has no team column (see §1.1). The
  bucket's label is fixed: "Không xác định". The bucket's
  `bucket_key` is the literal sentinel `__unknown__` (see §2.5.2 for
  the rule that the server is the only authority that maps a
  sentinel to a set of rows).
- Every `recruitedCount` shown in the team chart equals the
  corresponding bucketed count in the read-model. The team chart and
  the total `recruitedTotal` agree (the BoD total is the sum of all
  team buckets plus the unknown bucket). The legacy aggregate and the
  Direct Entry rows in the unknown bucket share the unknown bucket
  in the chart; the unknown drill-down panel renders them under
  their own clearly-labelled sections (see §2.5.4).

### 2.2 Historical attribution rule (the master-plan guarantee)

For every Direct Entry fact, the team attribution is:

```
team = e.team_id at the time the entry was saved (i.e. the team_id currently
       stored on the direct_entries row; this value is set when the entry is
       authored and is NOT rewritten when the recruiter later changes team
       or when a leader transitions)
bucket_key = team_token_for(e.team_id)            -- see §2.5.2
display    = join teams.display_name at query time
```

This is enforced by the W05A predicate
`direct_entry_reporting_authorized_entries` already, which joins
`direct_entries` directly and uses the `team_id` column as the join key for
`team` audience filtering. The W05B work does not add a new lookup; it
exposes the **same** `team_id` on the fact payload so the read-model can
group by it and emit a sanitized `bucket_key` token for the chart
(see §2.5.2 for the bucket_key contract — `bucket_key` is a server-side
token, NOT a display text, NOT a UUID).

- The W05A "team" audience filter `e.team_id = any(v_team_ids)` is keyed on
  the row's stored `team_id` (not on the recruiter's current team). The
  W05B team breakdown reuses the same field and the same rule.
- If the team has since been renamed, deactivated or its `display_name`
  changed, the row's team attribution for that fact row is **the team that
  existed at the time the entry was saved**, and the row's `display`
  label in the breakdown is the current `teams.display_name` (joined from
  the current row). The historical name is not preserved as a separate
  value (master plan does not require a per-row `team_display_at_fact`
  snapshot; this is locked by §2.2.1 below).
- A row whose `team_id` no longer matches any row in `teams` (orphan) is
  bucketed as "Không xác định" with the sentinel `bucket_key =
  "__unknown__"`, not silently dropped and not re-attributed to a current
  recruiter's team. An inactive team is **not** an orphan (see §2.3.1 for
  the inactive-team rule and the " (Đã ngừng hoạt động)" suffix).

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

### 2.3 Unknown bucket (mandatory) and the inactive-team rule

The "Không xác định" bucket is reserved for facts whose team attribution
**cannot** be resolved against any active or historical team. The bucket
has two **and only two** contributors:

1. **Legacy aggregate** (`daily_recruitment_breakdown` rows,
   `business_date < cutoff`). The legacy aggregate has no team column by
   schema; the read-model **never** attempts to re-attribute a legacy row
   to a team (the master-plan guarantee forbids it). The legacy aggregate
   contributes the sum of its `recruited_count` to the unknown bucket.
2. **Direct Entry defensive null / orphan** rows. Two defensive cases
   that the schema says cannot happen but the read-model must still
   defend against:
   - `e.team_id IS NULL` (defensive; `direct_entries.team_id` is
     `NOT NULL` by schema but the read-model does not assume the
     schema is self-enforcing); and
   - `e.team_id` does not match any row in `public.teams` (orphan —
     the team was hard-deleted, which the W01C-A append-only revision
     ledger is designed to prevent, but the read-model still defends).

**§2.3.1 (locked — inactive teams are NOT Unknown):** a Direct Entry
fact whose `team_id` matches a row in `public.teams` is bucketed
under **that team** even when the team's `active = false`. The team's
`active` status is rendered as a label suffix — the bucket
`display` becomes `<teams.display_name> (Đã ngừng hoạt động)` — but
the `bucket_key` is unchanged and the `recruitedCount` stays in the
team's bucket. There is no client-side toggle to "include inactive
teams" in W05B (active and inactive teams are always included); a
future toggle is **out of scope** and is a deferred extension (see
§6). Renaming a team does not change its `bucket_key` (the
`bucket_key` derivation is locked in §2.5.2 and is independent of
`display_name`).

**§2.3.2 (locked — Unknown is the only sentinel bucket):** the only
sentinel `bucket_key` in W05B is the literal string `"__unknown__"`,
reserved for the unknown bucket. No other sentinel is allowed; the
`__system_vendor__` reserved team identity is a `teams.code` (a real
team) and is treated like any other team in the chart (its bucket
shows up if it has facts in the result). The unknown bucket is
emitted **only** if the unknown bucket's count is greater than zero;
if no fact falls into it, the chart and the totals still reconcile
(`total = sum(knownTeamBuckets)`) and the unknown bucket is omitted
from the chart visually. The drill-down panel for the unknown bucket
is reachable only via the chart bucket (or, in a no-facts-fall-into-
it case, not at all).

**§2.3.3 (locked — legacy aggregate total in the unknown panel):**
the unknown drill-down panel is split into two clearly-labelled
sections (see §2.5.4):
- a **legacy aggregate total** card: one number, the
  `sum(recruited_count)` of the legacy rows that fall into the
  unknown bucket for the current filter window, with the
  `business_date` range and the BoD `cutover` date as the only
  provenance; no row-by-row pagination; no entry-level rows.
- a **Direct Entry anomaly row list** (paginated, bounded, sanitized
  as in §2.5): entry-level rows for Direct Entry facts whose
  `team_id IS NULL` or is an orphan. This list is empty unless
  defensive null / orphan rows exist.

The legacy aggregate is **never** rendered as Direct Entry entry-
level rows. The legacy aggregate is **never** paginated as
entry-level rows. The contract is the recommended path: a
`legacy_aggregate_total` card plus, if needed, a `direct_entry_
anomaly` paginated list. The alternative path — paging legacy
aggregate-grain rows — is **not part of the locked contract** and is
explicitly deferred (see §6 and §2.5.4).

**§2.3.4 (locked — `recruitedTotal` invariant):** the BoD total
equals the sum of every team bucket plus the unknown bucket. The
read-model pins this invariant. A test (`E1`) compares
`recruitedTotal` to `sum(byTeam)` plus the unknown bucket's
`recruitedCount` and fails on any delta.

### 2.4 Scope authority (DB / server, never client)

- The audience (`all` / `team` / `own`) is resolved server-side by
  `direct_entry_reporting_resolve_audience` (W05A) and is the **sole**
  authority. The BoD view (`mode.kind === "all"`) is reachable only when
  the DB returns `audience = "all"`. A `team` / `own` actor never sees the
  BoD team chart, the BoD chart, the BoD totals, or any per-team
  breakdown.
- The team breakdown for a BoD actor is the **full** set of teams
  (active and inactive) with at least one fact in the result.
  Inactive teams are bucketed under their own team identity and are
  rendered with the " (Đã ngừng hoạt động)" label suffix (see
  §2.3.1). The unknown bucket captures only legacy aggregate and
  Direct Entry defensive null / orphan (see §2.3); inactive teams
  do **not** contribute to the unknown bucket. There is no
  client-side toggle to "include inactive teams" in W05B (active
  and inactive teams are always included); a future toggle is a
  deferred extension (see §6).
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

- **Request:** `{ bucket_key: string, from?: string, to?: string, project?:
  string, recruiter?: string, provider?: string, employment?: string,
  cursor?: string, limit?: number }`. `bucket_key` is the **opaque,
  stable, server-issued token** the chart emits for the team bucket;
  see §2.5.2 for the contract. The literal sentinel `bucket_key =
  "__unknown__"` is also accepted and renders the unknown bucket's
  contents (see §2.5.4 for the unknown panel split). `bucket_key` is
  **not** a `team_id` UUID, **not** a `recruiter_id`, **not** a
  `scope_team_id`, **not** a `display_name`, and **not** any
  user-inferable text. The server is the **single** authority that
  maps a `bucket_key` to a fact-row set; the UI never tries to
  decode or guess it.
- **Scope is BoD-only:** the endpoint is reachable only when the
  DB-resolved audience is `all`. A `team` or `own` actor who calls the
  endpoint with a `bucket_key` for any team is rejected with the
  existing `REPORTING_QUERY_FAILED` error (no 404 leak, no empty
  list). The shared audience predicate
  (`direct_entry_reporting_authorized_entries`) is the gate.
- **Server-side, bounded pagination:** the response is
  `{ rows: DrillDownRow[], nextCursor: string | null, total: number,
  applied: ReportingFilters, bucket: { key, display } }`. `limit` is
  optional, default 25, max 100. `cursor` is an opaque server-issued
  string. The total count returned equals the total fact count for the
  filter set (no client-side recomputation), and the total agrees with
  the BoD team's bucket count for the same filter set (a server test
  pins this). The `bucket.key` echoed in the response is the
  request's `bucket_key` (round-trip); the `bucket.display` is the
  current display label, with the " (Đã ngừng hoạt động)" suffix for
  inactive teams.
- **Filters only narrow:** the drill-down filter set is the same parser
  (`p1-filter.ts::parseReportingFilters`) plus a required `bucket_key`.
  Any filter not in that list is rejected as `INVALID_FILTER`. The
  `source` filter is not exposed to the drill-down (drill-down is
  Direct Entry scoped; legacy aggregate is part of the BoD team chart
  as "Không xác định" only and is rendered in the unknown panel as a
  single aggregate total, not as paginated rows; see §2.5.4).
- **PII / data minimization:** `DrillDownRow` is the minimal sanitized
  shape: `business_date, project_display, recruiter_display,
  provider_type_display, employment_type_display, recruited_count,
  first_work_date`. The row **must not** include `entry_id`,
  `submission_id`, `source_id`, `drive_file_id`, `file_name`,
  `recruiter_key`, `project_key`, `provider_type_key`,
  `employment_type_key`, `team_id`, `team_code`,
  `bucket_key`, `auth_subject`, `app_user_id`, or any other
  internal identifier. The server test pins the row shape.
- **Drill-down first dimension: recruiter.** The drill-down is sorted
  by `recruiter_display` ascending then `business_date` descending
  then `entry_id` ascending (the existing grain tie-breaker). The
  page surfaces the recruiter display only (the bucket identity),
  never the recruiter_key. The T1A UI may group rows by
  `recruiter_display` and show a per-recruiter subtotal; the
  subtotal equals the per-recruiter sum that the BoD chart's
  recruiter breakdown would compute for the same filter set,
  projected against the scoped audience.
- **No unbounded list.** A `limit` above 100 is rejected as
  `INVALID_FILTER`. A `limit = 0` is rejected as `INVALID_FILTER`. A
  request without `limit` uses the default 25. A request that asks
  for `nextCursor` beyond the available rows returns
  `{ rows: [], nextCursor: null, total, applied, bucket }` (no error,
  no out-of-scope leak). The server test pins the upper bound and the
  empty next-page contract.

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

**§2.5.2 (locked — `bucket_key` contract, no UUID, no display text):**
`bucket_key` is the sanitized identity the chart emits for each team
bucket and the drill-down accepts back. The rules are:
- `bucket_key` is **opaque** to the UI and the wire format: it is
  a `text` token the server derives and the UI passes verbatim. The
  UI never decodes it, never infers it from display text, and never
  shows it to the user as a "code" or "id" (the user sees only
  `display`).
- `bucket_key` is **stable** across reads: the same team yields the
  same `bucket_key` in the chart, in the drill-down response, and
  in any future paginated request. The current derivation is
  `bucket_key = teams.code` for every team row (`teams.code` is
  `unique` and has a `length(btrim(code)) between 1 and 128`
  check; the W01C-A append-only revision ledger
  `p3_1_w01c_a_team_catalog.sql` keeps `code` stable for a team
  across versions). The server validates that the requested
  `bucket_key` matches exactly one team row in `public.teams` (a
  `bucket_key` that matches zero or more than one team is rejected
  as `INVALID_FILTER` — the reserved `__system_vendor__` is a real
  `code` and is treated like any other team). The literal
  `__unknown__` is the only sentinel `bucket_key`; the server maps
  it to the unknown bucket's contents (see §2.5.4) and rejects
  every other sentinel.
- `bucket_key` is **sanitized** for the wire: the server rejects
  any `bucket_key` that is not a single non-empty line of printable
  text matching `^[A-Za-z0-9_]+$` with `1 ≤ length ≤ 128`. This
  matches the `teams.code` check (after the `btrim`) and prevents
  injection of display-text look-alikes. A `bucket_key` that
  passes the wire check but is not a real `teams.code` (and is not
  the `__unknown__` sentinel) is rejected as `INVALID_FILTER`.
- `bucket_key` is **never** the `team_id` UUID, **never** the
  `display_name`, and **never** the `recruiter_key` /
  `project_key` / `scope_team_id` / `auth_subject` / `app_user_id`.
  The `bucket_key` is the chart ↔ drill-down token only; the
  read-model pins this rule.
- `bucket_key` is the only field the chart emits to identify a
  bucket. The chart's bucket shape is
  `{ bucket_key: string, display: string, recruitedCount: number }`
  (additive on the BoD team's response). The drill-down response
  echoes `bucket: { key: string, display: string }` round-trip.

**§2.5.3 (locked — drill-down row shape, no internal team id):** the drill-down response row carries exactly the
seven sanitized fields listed in §2.5. The server test rejects any
added field. The row is keyed by the row's `business_date` /
`recruiter_display` / `entry_id` (the existing grain tie-breaker);
the row does not carry any team identifier because the team identity
is implicit in the request's `bucket_key`. The client does not need
`team_id`, `team_code`, `bucket_key`, or any other internal team
identifier on each row to render the drill-down; the chart's
`bucket.display` and the panel title already identify the team.

**§2.5.4 (locked — unknown panel split, legacy aggregate honest):**
when the user opens the unknown bucket (`bucket_key = "__unknown__"`),
the panel renders two clearly-labelled sections in this order:
- **Section A: legacy aggregate total** — a single card that
  shows one number (`sum(recruited_count)` over the legacy aggregate
  rows in the current filter window), the `business_date` range,
  and the `cutover` date. The card is labelled "Tổng hợp từ dữ liệu
  cũ (tổng hợp theo ngày, không phải entry-level)". The card is
  **not** paginated. The card does **not** render any
  entry-level rows. The card does **not** carry `entry_id`,
  `submission_id`, `recruiter_key`, or any other internal
  identifier (the legacy aggregate has no `entry_id`; the card
  shows the aggregate `recruited_count` and the date range only).
  The server's response carries this section as
  `{ legacy_aggregate_total: { recruited_count, from, to,
  cutover_date } }` (a non-paginated object). The card's
  `recruited_count` is the unknown bucket's legacy contribution
  alone — Direct Entry defensive null / orphan rows are **not**
  part of this card (see §2.3.3).
- **Section B: Direct Entry anomaly row list** — a paginated,
  bounded, sanitized list (rows shaped per §2.5 / §2.5.3) over
  Direct Entry facts whose `team_id IS NULL` or whose `team_id`
  is an orphan. The list is empty unless the read-model finds
  defensive null / orphan rows. The list's `total` is the
  defensive null / orphan count alone (not the legacy aggregate
  count). The list's sort, `limit`, `cursor` and `INVALID_FILTER`
  rules are the same as the standard drill-down. The list is
  labelled "Anomaly Direct Entry (không gán được team)" so the
  user is never misled into thinking these rows are legacy
  rows. The list's `total` and the unknown bucket's Direct
  Entry contribution are the same number; the BoD total
  invariant (`total = sum(byTeam) + unknownBucketCount`) is
  pinned by `E1` and `E3`.

The unknown panel is the only place where legacy aggregate data is
shown in W05B; the BoD team chart emits a single unknown bucket
whose `recruitedCount` equals the sum of section A and section B
above. The drill-down never re-renders the legacy aggregate as
entry-level rows. The alternative of paging legacy aggregate-grain
rows (clearly labelled as aggregate facts, with their own cursor /
order / total, and never called entry-level rows) is **not** part
of the W05B contract; it is a deferred extension (see §6 and the
"Unknown drill-down legacy rows" deferred item).

### 2.6 Architecture (reuse, no N+1, exactly one append-only migration)

- **Reuse W05A:** the BoD team chart and the drill-down both consume the
  **same** audience predicate (`direct_entry_reporting_authorized_entries`)
  and the **same** eligibility filter (state='SUBMITTED', deleted_at IS
  NULL, first_work_date >= cutoff, all audience). The W05A RPC
  `direct_entry_reporting_scoped_facts` is the **single source of facts**
  for both the BoD chart and the drill-down. The drill-down is a
  **separate** RPC (`direct_entry_reporting_team_drill_down`, locked name)
  that intersects the authorized set with the requested `bucket_key` set
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
  RPC). The legacy aggregate total in the unknown panel is part of the
  same RPC response; it is not a second call.
- **Migration (one, append-only, no number reserved in this memo):**
  W05B implementation requires **exactly one** append-only
  migration. The migration is added on top of the current `main` SHA
  (the migration number is **not** reserved in this memo; T0 allocates
  the slot when the W05B implementation task is scheduled). The
  migration does:
  - alter the in-place projection of `direct_entry_reporting_facts_v01`
    to LEFT JOIN `public.teams` on `direct_entries.team_id` and
    project `team_id`, `team_code` (= `teams.code` per the W01C-A
    stable-code invariant) and `team_display_name` (= the current
    `teams.display_name`, or `NULL` for null / orphan). The existing
    projected columns stay unchanged. The view's ACL stays
    `service_role` only;
  - extend `direct_entry_reporting_scoped_facts` to add three
    additive keys per fact: `team_id` (the row's stored `team_id`),
    `team_code` (the joined `teams.code` or `NULL`) and
    `team_display_name` (the joined `teams.display_name` or `NULL`).
    The existing keys (`audience`, `facts`, `sources`,
    `latest_runs`, `presence`) are unchanged. The fact ordering is
    unchanged. The W05A `SECURITY DEFINER` + fixed
    `search_path = pg_catalog, public` posture is reused;
  - create the new RPC `direct_entry_reporting_team_drill_down`
    (locked name) with the signature
    `(p_auth_subject uuid, p_app_user_id uuid, p_bucket_key text,
    p_filters jsonb, p_cursor text, p_limit integer)` returning
    `jsonb` with the shape in §2.5 / §2.5.4. The RPC re-resolves
    audience via `direct_entry_reporting_resolve_audience`; if the
    resolved audience is not `all`, it returns the
    `REPORTING_QUERY_FAILED` error. The RPC uses the shared
    authorized-row predicate
    (`direct_entry_reporting_authorized_entries`) plus a
    `bucket_key` → fact-row set mapping. The new RPC reuses the
    W05A `SECURITY DEFINER` + fixed `search_path` posture and is
    `service_role` only (`public`, `anon`, `authenticated`
    revoked). The new RPC carries no new dependency, no new role
    engine, no new capability token, no new grant creation rule.
  The migration is **non-breaking** on the read path: the additive
  view columns and the additive RPC keys do not change any existing
  read-path behavior; existing tests and consumers stay green. The
  legacy migrations stay byte-identical. The "additive / in-place"
  language in this memo describes the **compatibility** of the
  migration (existing keys unchanged, existing ACL posture reused),
  not the absence of a migration.
- **No new dependency, no new package, no new RPC framework.** Reuses
  the W05A `service_role` only execute grant and the
  `SECURITY DEFINER` + fixed `search_path` posture.

### 2.7 Allowed / denied matrix (audit-grade)

The matrix below pins what each actor kind sees for each new surface.
`bucket_key` is the chart-to-drill-down token (§2.5.2); it is **not** a
display text, **not** a UUID.

| Surface | `all` (DB-confirmed) | `team` (DB-confirmed) | `own` (DB-confirmed) | anonymous / failed actor / malformed audience |
|---|---|---|---|---|
| BoD layout (`mode.kind === "all"`) | Renders, including the new BoD-by-team chart and totals | Never reached (W06C dispatch fails closed) | Never reached | Never reached (W06C error mode) |
| BoD team chart bucket count | Renders per-team buckets (active + inactive, inactive labelled " (Đã ngừng hoạt động)") plus "Không xác định" (only when unknown bucket count > 0) | Never reached | Never reached | Never reached |
| BoD team chart total vs. `recruitedTotal` | Equal (`recruitedTotal = sum(perTeamBuckets) + unknownBucketCount`; server test pin) | Never reached | Never reached | Never reached |
| BoD team chart bucket identity | Each bucket carries `{ bucket_key, display, recruitedCount }`; UI never infers `bucket_key` from `display` | n/a | n/a | n/a |
| Team drill-down endpoint (new RPC) | Renders sanitized rows for the requested `bucket_key` (or the unknown panel for `__unknown__`); respects filter parser; respects bounded pagination | Rejected with `REPORTING_QUERY_FAILED` (the caller's audience is `team`; no leak, no 404) | Rejected with `REPORTING_QUERY_FAILED` (same reason) | Rejected with `REPORTING_QUERY_FAILED` (audience is null / not `all`) |
| Team drill-down row shape | Only `business_date, project_display, recruiter_display, provider_type_display, employment_type_display, recruited_count, first_work_date` (no `entry_id`, no `team_id`, no `team_code`, no `bucket_key`, no internal id) | n/a | n/a | n/a |
| Team drill-down `limit` | Default 25, max 100; >100 → `INVALID_FILTER`; `limit = 0` → `INVALID_FILTER`; non-numeric `limit` → `INVALID_FILTER` | n/a | n/a | n/a |
| Team drill-down `cursor` | Opaque server string; out-of-range returns empty page + `nextCursor: null`; undecodable `cursor` → `INVALID_FILTER` | n/a | n/a | n/a |
| Team drill-down `bucket_key` validation | Matches `^[A-Za-z0-9_]+$` and `1 ≤ length ≤ 128`; exactly one row in `public.teams`; or the literal sentinel `__unknown__`. Any other value → `INVALID_FILTER` (no 404 leak) | n/a | n/a | n/a |
| Filter outside the W05A parser | Rejected as `INVALID_FILTER` | n/a | n/a | n/a |
| Unknown bucket contributors | Legacy aggregate + Direct Entry defensive null / orphan only (see §2.3 / §2.3.3) | n/a | n/a | n/a |
| Inactive-team rows in BoD team chart | Render under the team's own bucket with display label suffixed " (Đã ngừng hoạt động)"; `bucket_key` and `recruitedCount` unchanged (see §2.3.1) | n/a | n/a | n/a |
| Unknown panel section A (legacy aggregate total) | Single non-paginated card: `{ recruited_count, from, to, cutover_date }`; never row-by-row; never entry-level rows | n/a | n/a | n/a |
| Unknown panel section B (Direct Entry anomaly) | Paginated, bounded, sanitized row list (shape per §2.5 / §2.5.3) over Direct Entry facts with `team_id IS NULL` or orphan `team_id`; empty unless defensive null / orphan rows exist | n/a | n/a | n/a |

### 2.8 Acceptance / mutation plan

The T0 acceptance gates are:

- **E1: BoD by team happy path.** With a DB-confirmed `all` audience
  and a known filter window, the BoD layout renders the team chart
  card and the new buckets. Each bucket's `recruitedCount` equals
  the sum of `recruited_count` over the matching fact rows (and the
  unknown bucket equals the sum of the legacy aggregate plus
  Direct Entry defensive null / orphan). The total of the buckets
  plus the unknown bucket equals `recruitedTotal`. The
  `recruitedTotal` equals the team-of-row sum computed from the
  authorized-fact set.
- **E2: historical attribution.** A Direct Entry row whose
  `team_id = T1` and whose recruiter later transfers to team `T2`
  is bucketed under `T1` (display name is the current
  `T1.display_name`) for every filter window covering that fact's
  `business_date`. The test seeds a fact with `team_id = T1` then a
  recruiter transfer, and asserts the BoD team chart and the team
  drill-down both show `T1`. The bucket's `bucket_key` is
  `T1.code` (the team's `code` is stable across the W01C-A
  revision history).
- **E3: unknown bucket.** The unknown bucket equals the sum of
  (a) the legacy aggregate's `recruited_count` for the current
  filter window and (b) the Direct Entry defensive null / orphan
  row count for the same filter window. The unknown bucket is
  emitted in the chart only if (a) + (b) > 0. The unknown panel
  renders two sections (legacy aggregate total + Direct Entry
  anomaly row list). The legacy aggregate total equals (a) and
  matches the BoD `cutover` date and the `business_date` range.
- **E4: drill-down happy path.** A BoD request with a valid
  `bucket_key` (a real `teams.code` or `__unknown__`), a valid
  filter set and `limit=25` returns the first page in
  `business_date` / `recruiter_display` / `entry_id` order, the
  `nextCursor` matches the next page, the second page returns the
  remainder, and the `nextCursor` is null on the last page. The
  total returned equals the team's per-team total for the same
  filter set. The unknown panel returns the legacy aggregate
  total + the bounded anomaly row list (the legacy aggregate
  total is **not** paginated).
- **E5: drill-down re-derives audience.** A drill-down request
  whose caller is a `team` or `own` actor is rejected with
  `REPORTING_QUERY_FAILED`. The drill-down never reuses a caller-
  supplied audience value; the W05A resolver is the only authority
  inside the RPC.
- **E6: drill-down row shape.** The response row contains exactly
  the seven sanitized fields listed in §2.5. A test pins the
  response row shape and rejects any added field (especially
  `entry_id`, `team_id`, `team_code`, `bucket_key`, `recruiter_key`).
- **E7: drill-down bounded.** A `limit=101` request is rejected
  with `INVALID_FILTER`. A `limit=0` is rejected with
  `INVALID_FILTER`. A request with a non-numeric `limit` is
  rejected. A request with a `cursor` that does not decode to a
  real offset is rejected.
- **E8: drill-down filter parity.** A drill-down request with
  `from > to` is rejected as `INVALID_FILTER`. The drill-down
  reuses the W05A filter parser, so the same filter errors
  propagate.
- **E9: BoD team chart card placement.** The card is rendered only
  inside the BoD `mode.kind === "all"` branch. A `team` audience
  sees no BoD card. A `own` audience sees no BoD card. A failed
  read sees the W06C error mode.
- **E10: no client-side scope widening.** Removing the audience
  resolver in the drill-down RPC (or in the BoD server) makes the
  drill-down fail with `REPORTING_QUERY_FAILED` and the BoD team
  chart fail with the W06C error mode. The test pins this in both
  directions.
- **E11: `bucket_key` is opaque and stable.** A bucket for team
  `T1` is keyed by `T1.code` in both the chart and the
  drill-down response. The test seeds a team, asserts the chart's
  `bucket_key` equals `T1.code`, asserts the drill-down's
  `bucket.key` round-trips, then renames the team's
  `display_name` and re-asserts (the `bucket_key` is unchanged).
- **E12: inactive team stays in its own bucket.** A team is
  deactivated (`active = false`) and the BoD chart is read again.
  The team's bucket still appears, with `bucket_key = T.code`
  unchanged, `display` suffixed " (Đã ngừng hoạt động)", and
  `recruitedCount` unchanged. The total of all buckets still
  equals `recruitedTotal`.
- **E13: orphan and defensive null go to unknown.** A Direct
  Entry row whose `team_id` is hard-orphaned (no row in `teams`)
  falls into the unknown bucket. The unknown panel's section B
  contains the row (paginated, sanitized, no `entry_id` /
  `team_id` / `bucket_key` in the row). The unknown panel's
  section A does **not** include this row (section A is legacy
  aggregate only).
- **E14: unknown panel section A is non-paginated, no entry-level
  rows.** A read of the unknown panel returns
  `legacy_aggregate_total.recruited_count` equal to the legacy
  aggregate's sum for the current filter window. The unknown
  panel does **not** carry `rows` for the legacy aggregate. The
  legacy aggregate total does **not** carry `entry_id`,
  `submission_id`, `recruiter_key`, or any other internal
  identifier. The legacy aggregate total is labelled
  "Tổng hợp từ dữ liệu cũ" in the UI.
- **E15: one migration append-only.** After the W05B
  implementation lands, `pnpm db:migrate -- --offline` reports
  exactly one new migration appended after the current `main` SHA
  (no number reserved in this memo; T0 allocates the slot), all
  earlier migrations stay byte-identical, and the new migration's
  body is the additive in-place view projection + additive RPC
  keys + new `direct_entry_reporting_team_drill_down` RPC.

**Mutation cases** (each makes the corresponding E test fail, then
is restored to byte-equivalent code; the migration file hash stays
unchanged):

| Mutation | Failing E test(s) |
|---|---|
| Drop `team_id` / `team_code` / `team_display_name` from the view | E1, E2, E11 |
| Use `recruiter_team_memberships` (or `recruiter_provider_memberships`) to attribute a fact to a current team | E2 |
| Skip the unknown bucket | E3, E13 |
| Add `entry_id` / `team_id` / `team_code` / `bucket_key` to the drill-down row | E6 |
| Remove the drill-down audience re-check | E5, E10 |
| Cap `limit` at 200 in the server | E7 |
| Apply the W05A filter parser to a new filter key in the drill-down (e.g. an unrestricted text search) | E8 |
| Render the BoD team chart for a `team` audience | E9, E10 |
| Remove the legacy aggregate from the unknown bucket | E3, E14 |
| Compute the team bucket on the client (the W05A page-test pin) | E1 |
| Use `display_name` as `bucket_key` (or return `display_name` as `bucket_key` to the client) | E11 |
| Reject only the `__unknown__` sentinel at `bucket_key` validation while accepting any other string | E11 |
| Bucket an inactive team into "Không xác định" | E12 |
| Render the legacy aggregate as entry-level rows in the unknown panel | E14 |
| Skip the unknown panel section A (legacy aggregate total) and only show anomaly rows | E3, E14 |
| Add a second migration (the W05B implementation must add exactly one) | E15 |

## 3. Boundary (what this memo does NOT do)

- No source, migration, API, dependency, route, UI, or Production
  change in **this survey**. No `pnpm install`, no
  `package.json` / `pnpm-lock.yaml` edit, no `tsconfig.json` edit.
  No Production query, no apply, no deploy, no browser, no CUA, no
  screenshot, no UAT. The W05B implementation (T1B + T1A) is the
  follow-up work; this memo is the contract lock.
- **Migration is required in the implementation (not in this
  survey).** W05B implementation adds **exactly one** append-only
  migration on top of the current `main` SHA (see §2.6). The
  migration number is **not reserved in this memo**; T0 allocates
  the slot when the W05B implementation task is scheduled. The
  migration is **non-breaking** on the read path (existing keys
  unchanged, existing ACL posture reused; the additive view
  projection and additive RPC keys do not change any existing
  read-path behavior). The "additive / in-place" language describes
  the **compatibility** of the migration, not the absence of a
  migration.
- No new RPC framework, no new capability token, no new role
  engine, no new grant creation rule, no new rev-grant pattern, no
  new `search_path` policy. The W05A `SECURITY DEFINER` + fixed
  `search_path = pg_catalog, public` posture is reused for the new
  drill-down RPC.
- No edit to the W05A RPC's existing keys (audience, facts,
  sources, latest_runs, presence). The new
  `team_id` / `team_code` / `team_display_name` fields are
  additive on the fact grain. The W05A tests stay green.
- No edit to `docs/P3.1.md`, `docs/P4.md`, `docs/master-plan.md`,
  `package.json`, `pnpm-lock.yaml` or any existing
  `src/**` / `supabase/**` / `scripts/**` / `docs/**` file in this
  survey.
- No split into T1B / T1A in this memo. The proposed split is
  recorded in §4 for T0's review but is **not committed** until T0
  approves the contract.

## 4. Proposed T1B / T1A split (for T0's review, not committed)

The split is proposed only; the implementation does not start until T0
approves the contract above.

### 4.1 T1B (backend / SQL)

- Add **one append-only migration** (no number reserved here; T0
  allocates the slot) on top of the current `main` SHA. The
  migration:
  - alters the in-place projection of
    `direct_entry_reporting_facts_v01` to LEFT JOIN `public.teams`
    on `direct_entries.team_id` and project `team_id` (the row's
    stored `team_id`), `team_code` (= `teams.code`; the W01C-A
    stable-code invariant) and `team_display_name` (= the current
    `teams.display_name`, or `NULL` for null / orphan). The
    existing projected columns stay unchanged. The view's ACL
    stays `service_role` only;
  - extends `direct_entry_reporting_scoped_facts` to add three
    additive keys per fact: `team_id` (the row's stored `team_id`),
    `team_code` (the joined `teams.code` or `NULL`) and
    `team_display_name` (the joined `teams.display_name` or
    `NULL`). The existing keys (`audience`, `facts`, `sources`,
    `latest_runs`, `presence`) are unchanged. The fact ordering
    is unchanged;
  - creates the new RPC
    `direct_entry_reporting_team_drill_down` with the signature
    `(p_auth_subject uuid, p_app_user_id uuid, p_bucket_key text,
    p_filters jsonb, p_cursor text, p_limit integer)` returning
    `jsonb` with the shape in §2.5 / §2.5.4. The RPC
    re-resolves the audience via
    `direct_entry_reporting_resolve_audience`; if the resolved
    audience is not `all`, it returns the
    `REPORTING_QUERY_FAILED` error code. The RPC uses the shared
    authorized-row predicate
    (`direct_entry_reporting_authorized_entries`) plus a
    `bucket_key` → fact-row set mapping. The new RPC reuses the
    W05A `SECURITY DEFINER` + fixed `search_path` posture and is
    `service_role` only (`public`, `anon`, `authenticated`
    revoked).
- Extend the read-model in `p1-reporting.ts` to compute
  `byTeam` from the same scoped-fact array. `byTeam` is keyed
  by `bucket_key` (= `teams.code` for known teams; the literal
  `__unknown__` for the unknown bucket). The bucket's `display`
  is the joined `teams.display_name`, suffixed with " (Đã ngừng
  hoạt động)" when `teams.active = false`. The unknown sentinel
  is used for null / orphan Direct Entry rows; the legacy
  aggregate contributes to the same unknown bucket. The
  `recruitedTotal` invariant (`total = sum(byTeam)`) is a
  server test pin.
- Add a new server endpoint
  `fetchCutoverTeamDrillDown(params, actor)` in
  `p2-w04a-reporting-server.ts` (or a new sibling) that calls
  the new RPC, applies the same filter parser, applies the
  same `dbKind === "all"` gate, validates `bucket_key` per
  §2.5.2 (the wire check, then the one-row-in-`teams` check;
  the `__unknown__` sentinel bypasses the row check and maps
  to the unknown bucket), validates `limit` (default 25, max
  100), validates `cursor` (server-issued opaque string; an
  undecodable `cursor` is rejected as `INVALID_FILTER`), and
  returns the sanitized shape. The existing
  `fetchCutoverReporting` is unchanged. The unknown panel
  response carries both sections (§2.5.4): the non-paginated
  `legacy_aggregate_total` object and the paginated
  `rows` array for the Direct Entry anomaly list. The
  `legacy_aggregate_total` is computed inside the same RPC; it
  is not a second call.
- Update `ReportingData` to add
  `byTeam: Record<string, ReportingBucket>` keyed by
  `bucket_key` (additive). The bucket shape is
  `{ key: bucket_key, display, recruitedCount }`. The
  read-model also adds a helper to compute the
  `legacy_aggregate_total` for the unknown panel (used only
  when the user opens the unknown bucket).
- Tests:
  - extend `p3-w05a-page.test.mjs` to pin "no client-side team
    join" and "byTeam is computed in the read-model, not on the
    client" and "fetchCutoverReporting carries byTeam in the
    result";
  - add `p3-w05b-team-drill-down.test.mjs` that pins the row
    shape (E6), the bounded pagination (E7), the audience
    re-check (E5, E10), the filter parity (E8), the unknown
    bucket and panel split (E3, E13, E14), the historical
    attribution rule (E2), the `bucket_key` validation
    (E11), the inactive-team rule (E12), and the row-shape
    rejection of `team_id` / `team_code` / `bucket_key` on
    the response row (E6);
  - add `p3-w05b-by-team.test.mjs` that pins the `byTeam`
    aggregate against the `recruitedTotal` invariant (E1) and
    the inactive-team label suffix (E12);
  - add a PGlite / PostgreSQL migration test that asserts the
    one-migration append-only invariant (E15): the new
    migration is appended after the current `main` SHA, all
    earlier migrations stay byte-identical, and the new
    migration's body is the additive view projection + the
    additive RPC keys + the new
    `direct_entry_reporting_team_drill_down` RPC.

### 4.2 T1A (UI)

- Add a new card to `DashboardBody` in
  `src/components/dashboard/dashboard-view.tsx` rendering the
  `byTeam` chart (donut or bar) and a per-team list. The card is
  rendered only inside the BoD branch (no `team` / `own` audience
  reaches it). Each bucket is rendered as
  `<display> — <recruitedCount> người`; for an inactive team, the
  `<display>` is suffixed " (Đã ngừng hoạt động)" (the same label
  the drill-down panel title uses). The card does **not** show
  the `bucket_key` to the user; the user sees only `<display>`.
- Add a new team drill-down panel inside the BoD layout. The
  panel opens when the user focuses or clicks a team bucket
  (keyboard activation also supported). The panel calls
  `fetchCutoverTeamDrillDown({ bucket_key, ...filters, cursor,
  limit })` and renders the sanitized rows. The panel does
  **not** include any other field. A "no data" empty state
  renders when the team has no fact in the current filter
  window.
- The panel respects the same date / project / provider /
  employment / recruiter filter pipeline as the BoD page. The
  unknown panel is split into two clearly-labelled sections
  per §2.5.4:
  - **Section A: legacy aggregate total** — a single
    non-paginated card labelled "Tổng hợp từ dữ liệu cũ (tổng
    hợp theo ngày, không phải entry-level)". The card shows
    the `recruited_count`, the `business_date` range, and the
    `cutover` date. The card does **not** show `entry_id`,
    `submission_id`, `recruiter_key`, or any row-by-row list.
  - **Section B: Direct Entry anomaly row list** — a
    paginated, bounded, sanitized list (rows shaped per
    §2.5 / §2.5.3) over Direct Entry facts with
    `team_id IS NULL` or orphan `team_id`. The list is empty
    unless the read-model finds defensive null / orphan rows.
    The list is labelled "Anomaly Direct Entry (không gán
    được team)" so the user is never misled into thinking
    these rows are legacy rows.
- The panel paginates with a "Tải thêm" button; the cursor is
  opaque and is the next page's `nextCursor`. The button is
  disabled when `nextCursor` is null. There is no
  infinite-scroll, no auto-fetch. The button is **not** shown
  for the legacy aggregate total card (section A is not
  paginated).
- Reuse `Card`, `KpiCard`, `EmptyState`, `ErrorState`, `Alert`,
  the `ProjectDonut` / `ProviderDonut` / `RecruiterBarChart`
  chart components, and the design tokens. No new visual
  primitive. The chart never shows `bucket_key`; the user
  sees only `display` (with the " (Đã ngừng hoạt động)"
  suffix for inactive teams).
- No new dependency. The drill-down URL is a server route
  guarded by the same session/actor check as the BoD page (the
  page-level `decideSessionPageAccess` runs first, then the
  server endpoint re-derives the audience).

### 4.3 Out of scope for both lanes (explicit)

- A second drill-down dimension (project / provider / employment). A
  future W05C may add it; it is **not** part of W05B.
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
  legacy-side join to a team is added. The unknown panel renders the
  legacy aggregate as a single non-paginated total card (see §2.5.4
  and §6); it does **not** paginate legacy aggregate-grain rows.
- A change to the W05A source filter posture. The drill-down never
  exposes `source`; the BoD team chart is filter-narrowing only.
- A client-side toggle to "include inactive teams". Active and
  inactive teams are always included in W05B; a future toggle is a
  deferred extension (see §6).
- Paging legacy aggregate-grain rows in the unknown panel. The
  locked W05B contract is a non-paginated `legacy_aggregate_total`
  card plus a paginated Direct Entry anomaly list (see §2.5.4). A
  future extension may add paginated legacy aggregate-grain rows
  provided they are clearly labelled as aggregate facts (not
  entry-level rows), with their own cursor / order / total, and
  never called "entry-level rows" in the UI. That extension is
  **not** part of W05B and is a deferred item (see §6).

## 5. Risk register

- **R1 — recruiter's current team accidentally used.** Risk: a
  developer joins `recruiter_team_memberships` to "fix" the unknown
  bucket. Mitigation: the master-plan guarantee and §2.2.2 lock the
  rule. E2 / M2 / M9 / M10 fail closed.
- **R2 — legacy rows mis-attributed to a team.** Risk: a developer
  re-joins the legacy `daily_recruitment_breakdown` to a current team
  via `recruiter_key`. Mitigation: §1.1 + §2.3 lock the rule; the
  legacy aggregate is bucketed as "Không xác định" in full and is
  never paginated as entry-level rows in the unknown panel (E3,
  E14 / M9 / M17 fail closed).
- **R3 — drill-down PII leak.** Risk: a developer adds `entry_id`,
  `team_id`, `team_code` or `bucket_key` to the drill-down row.
  Mitigation: §2.5, §2.5.3, §2.7 lock the row shape and the
  `bucket_key` round-trip; E6 / M4 / M12 fail closed.
- **R4 — drill-down audience bypass.** Risk: a developer trusts a
  caller-supplied audience. Mitigation: §2.4 + §2.5 lock the
  server-side re-check; E5 / E10 / M3 / M9 fail closed.
- **R5 — unbounded drill-down.** Risk: a developer removes the
  `limit` cap. Mitigation: §2.5 + §2.7 lock the cap at 100; E7 / M6
  fail closed.
- **R6 — `bucket_key` instability.** Risk: a developer uses
  `display_name` as `bucket_key` (display name can be renamed or
  duplicated) or returns `team_id` as `bucket_key` (UUID leaks).
  Mitigation: §2.5.2 locks the contract: `bucket_key = teams.code`
  for known teams and `__unknown__` for the unknown bucket; the
  server validates the wire format and the one-row-in-`teams`
  constraint; the chart never shows `bucket_key` to the user.
  E11 / M11 / M12 fail closed.
- **R7 — inactive team misclassified as Unknown.** Risk: a
  developer drops inactive teams into the unknown bucket. Mitigation:
  §2.3.1 + §2.7 lock the rule: an inactive team stays in its own
  bucket with the " (Đã ngừng hoạt động)" label suffix and an
  unchanged `bucket_key`. E12 / M13 fail closed.
- **R8 — legacy aggregate rendered as entry-level rows.** Risk: a
  developer pages legacy aggregate-grain rows in the unknown panel
  and the UI calls them "entry-level rows". Mitigation: §2.5.4
  locks the unknown panel split: section A is a non-paginated
  `legacy_aggregate_total` card with the "Tổng hợp từ dữ liệu cũ"
  label; section B is the paginated Direct Entry anomaly list.
  E3, E14 / M14 / M15 / M17 fail closed.
- **R9 — migration slot collision or extra migration.** Risk: a
  parallel task reserves the migration slot W05B would use, or the
  W05B implementation adds a second migration. Mitigation: §2.6 +
  §3 + §4.1 lock "exactly one append-only migration" (E15 / M16
  fail closed); the slot is not reserved in this memo, T0 allocates
  it.
- **R10 — read-model N+1.** Risk: a developer computes `byTeam` in
  a loop on the client, or the unknown panel triggers a second RPC
  for the legacy aggregate total. Mitigation: §2.6 + the W05A
  page-test pin "no client-side audience join"; the W05B by-team
  test pin extends the same principle. The legacy aggregate total
  is part of the same RPC response as the anomaly row list. E1 /
  M10 fail closed.
- **R11 — `team` audience accidentally reaches the BoD team
  chart.** Risk: the W06C dispatch regresses. Mitigation: §2.4 +
  E9 + M8 pin "card is rendered only inside the BoD branch". The
  W06C dispatch is unchanged in W05B.
- **R12 — `bucket_key` validation is too loose.** Risk: a
  developer accepts any string at the `bucket_key` wire check and
  lets the server `JOIN teams ON teams.code = p_bucket_key` match
  a row only by accident, leaking the row's `team_id` to the
  wire. Mitigation: §2.5.2 + §2.7 lock the wire check
  (`^[A-Za-z0-9_]+$`, `1 ≤ length ≤ 128`), the one-row-in-`teams`
  check, and the explicit "the response's `bucket.key` is the
  request's `bucket_key` round-trip" rule. E11 / M11 / M12 fail
  closed.

## 6. Deferred (recorded, not in W05B)

- A second drill-down dimension (project / provider / employment) in
  a W05C follow-up.
- A client-side toggle to "include inactive teams" in a W05D
  follow-up. W05B includes both active and inactive teams in the
  BoD chart and labels the inactive ones with the
  " (Đã ngừng hoạt động)" suffix; the toggle would let the user
  hide inactive teams and is out of scope here.
- Paging legacy aggregate-grain rows in the unknown panel in a
  W05E follow-up. If added, those rows must be clearly labelled as
  aggregate facts (not entry-level rows), carry their own cursor /
  order / total, and never be called "entry-level rows" in the UI.
  W05B's locked contract is the non-paginated
  `legacy_aggregate_total` card plus the paginated Direct Entry
  anomaly list (§2.5.4).
- A `team_display_at_fact` snapshot for audit-grade history in a
  future follow-up. W05B uses the current `teams.display_name` (see
  §2.2.1).
- A cross-team comparison panel (e.g. period-over-period by team) in
  a P4 follow-up.
- Per-team KPI / target / achievement in a P4 follow-up. W05B only
  exposes the recruitment count; P4 will compose KPI formulas on
  top of W05B's `byTeam` aggregate.
- A "team-of-the-day" attribution mode that uses a membership
  effective at a specific business date to attribute a fact whose
  `team_id` is null or orphan. This is **explicitly out of scope**
  in W05B (see §2.2.2); the master plan does not require it.
- The Owner browser UAT. No Production access, no migration apply,
  no deploy. Release A / 2A sequencing stays T0's call.

## 7. Authority, decisions recorded, and review pass

- **Authority (locked, in order):** `docs/master-plan.md` §9 + §10 →
  `docs/handoffs/p3-w05a-actor-scoped-reporting-team-scope.md` →
  `docs/handoffs/p3-w06c-bod-team-own-dashboard.md` →
  `supabase/migrations/20261008080000_p3_w05a_actor_scoped_reporting.sql`
  → `supabase/migrations/20261007020000_p2_w04a_direct_entry_reporting_cutover.sql`
  → `docs/handoffs/p3-1-w01c-b-team-membership.md` and
  `p3-1-hf-legacy-team-leader-scope.md` →
  `supabase/migrations/20261009050000_p3_1_w01c_a_team_catalog.sql`
  (the W01C-A append-only team revision ledger that locks
  `teams.code` as the team's stable business identity).
- **Decisions recorded (locked in this memo):** team attribution is
  the row's stored `team_id`; the team display name is the current
  `teams.display_name`; "Không xác định" is a mandatory bucket whose
  contributors are the legacy aggregate and Direct Entry defensive
  null / orphan only (an inactive team is **not** in the unknown
  bucket — it stays in its own bucket with the
  " (Đã ngừng hoạt động)" label suffix); the BoD team chart and
  the team drill-down are reachable only for a DB-confirmed `all`
  audience; the drill-down is server-side, bounded (default 25,
  max 100), filter-narrowing, sanitized (no UUID, no recruiter_key,
  no project_key, no team_id, no team_code, no bucket_key, no
  entry_id, no submission_id, no source_id, no drive_file_id, no
  auth subject, no app_user_id); the drill-down first dimension is
  recruiter; `bucket_key` is the chart-to-drill-down token, derived
  as `teams.code` for known teams and the literal `__unknown__` for
  the unknown bucket, validated server-side via the wire check
  (`^[A-Za-z0-9_]+$`, `1 ≤ length ≤ 128`) and the one-row-in-`teams`
  constraint; the unknown drill-down panel is split into a
  non-paginated `legacy_aggregate_total` card (the legacy aggregate
  is never paginated as entry-level rows) and a paginated Direct
  Entry anomaly row list; the W05B implementation adds **exactly
  one** append-only migration (no number reserved in this memo;
  T0 allocates the slot) with an additive in-place view projection,
  additive RPC keys on the W05A scoped facts RPC, and a new
  `direct_entry_reporting_team_drill_down` RPC; no new dependency,
  no new RPC framework, no new grant creation rule; the W05A
  `SECURITY DEFINER` + fixed `search_path` posture is reused.
- **Decisions NOT recorded (deferred, see §4.3 and §6):** second
  drill-down dimension; inactive-team toggle; team-display-at-fact
  snapshot; cross-team period comparison; per-team KPI; legacy
  aggregate-grain paginated rows in the unknown panel; Owner
  browser UAT.
- **Review pass:** this memo is `PASS_AWAITING_T0_REVIEW` (R1 of
  the S0 survey). T0's review will check the four locked decisions
  in §2.2, §2.3 / §2.3.1, §2.4, §2.5 / §2.5.2 / §2.5.3 / §2.5.4,
  the acceptance / mutation plan in §2.8 (E1-E15), the migration
  posture in §2.6 / §3, the T1B / T1A split in §4, and the risk
  register in §5.
