# P3-W05B-S0 — BoD recruitment reporting by team (Survey / Contract Lock)

> **Status:** `P3_W05B_S0_R5_BOD_TEAM_REPORTING_SURVEY_PASS_AWAITING_T0_REVIEW`
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
saved** (Direct Entry: `direct_entries.team_id`; legacy: bucket
`unknown`, the namespaced unknown literal from §2.5.2),
never the team of the recruiter today, never the team of the actor looking at
the report. The chart-to-drill-down identity is the server-issued,
namespaced `bucket_key` token (§2.5.2 namespace A:
`team.<base64url(UTF-8(teams.code))>` for known teams, namespace
B: the literal `unknown` for the unknown bucket) — the W05B
chart never uses the raw `teams.code` on the wire, the
`display_name`, or the `team_id` UUID. The namespaced token
is built on top of the W01C-A stable-code invariant (the
canonical `teams.code` is preserved across versions), so the
namespaced token is itself stable for the lifetime of the
team. Inactive teams stay in their own bucket
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
- **Buckets are keyed by an opaque, stable, server-owned
  `bucket_key` token with two disjoint namespaces.** The chart
  bucket identity is `bucket_key` (NOT the `display_name`, NOT
  the `team_id` UUID, NOT the raw `teams.code`). The token has
  two namespaces: known-team tokens are
  `team.<base64url_no_padding(UTF-8(teams.code))>` (namespace A);
  the unknown literal is the bare `unknown` (namespace B). The
  two namespaces are disjoint by construction, so a team whose
  `code` is the literal `__unknown__` (or any other string) is
  always a known-team token, never collides with the unknown
  literal. `bucket_key` is a sanitized routing key the server
  maps one-to-one to the team fact rows (see §2.5.2 for the
  full contract and the wire-format rules). The UI never
  infers `bucket_key` from display text, never decodes it, and
  never shows it to the user; the server is the single source
  of truth. The `display` field on the bucket is a current
  best-effort display label, joined from `teams.display_name`
  at query time; if the team is `active = false`, the display
  label is suffixed with " (Đã ngừng hoạt động)" (the chart
  card and the drill-down title render the same suffix; see
  §2.3.1 for the attribution rule and §2.5.2 for the
  bucket_key contract). A fact whose `team_id` matches no row
  in `public.teams` (orphan) or whose `team_id IS NULL` falls
  into the "Không xác định" bucket, which is the **only**
  bucket whose `bucket_key` is the unknown literal (namespace
  B in §2.5.2), not a team token.
- A "Không xác định" bucket MUST exist whenever any Direct
  Entry fact in the result has no resolvable team (see §2.3.1)
  and MUST be displayed last, with the same shared display
  rules as `p1-reporting.ts::selectDisplay`. The legacy
  aggregate contributes fully to this bucket because it has
  no team column (see §1.1). The bucket's label is fixed:
  "Không xác định". The bucket's `bucket_key` is the literal
  unknown sentinel `"unknown"` (see §2.5.2 for the rule that
  the server is the only authority that maps a sentinel to a
  set of rows).
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
  "unknown"` (the namespaced unknown literal from §2.5.2), not
  silently dropped and not re-attributed to a current
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
sentinel `bucket_key` in W05B is the literal string `"unknown"`
(namespace B in §2.5.2), reserved for the unknown bucket. No
other sentinel is allowed; the `__system_vendor__` reserved team
identity is a `teams.code` (a real row in `public.teams`) and is
treated like any other team in the **W05B BoD chart
aggregation for the audience `all`**: its bucket shows
up as a known-team bucket if it has facts in the
result, with a token of the form
`team.<base64url("__system_vendor__")>`. The Vendor
system team is **not** a business team (W07A-R3
trigger
`direct_entry_reject_system_vendor_business_team`
blocks `recruiter_team_memberships` and
`direct_entry_scope_grants` and labels the row "not a
business team") and is **not** selectable as a
report-audience team for the `team` / `own` audience —
so a `team` / `own` audience actor never sees the
Vendor bucket in the chart (their `team_ids` never
resolve to the system team), and the W05B drill-down
RPC is `dbKind === "all"` gated and rejects
`team` / `own` / anonymous actors with
`REPORTING_QUERY_FAILED`. The legacy R1 sentinel
`__unknown__` is **not** a valid token in W05B and the server
rejects it (the `__` decoration is a stale alias; the namespace
contract locks the unknown literal as the bare `unknown` with no
underscores). The unknown bucket is emitted **only** if the
unknown bucket's count is greater than zero; if no fact falls
into it, the chart and the totals still reconcile
(`total = sum(knownTeamBuckets)`) and the unknown bucket is
omitted from the chart visually. The drill-down panel for the
unknown bucket is reachable only via the chart bucket (or, in a
no-facts-fall-into-it case, not at all).

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

- **Request:** `{ bucket_key: string, from?: string, to?: string,
  project?: string, recruiter?: string, provider?: string,
  employment?: string, cursor?: string, limit?: number }`.
  `bucket_key` is the **opaque, stable, server-issued,
  namespaced token** the chart emits for the team bucket; see
  §2.5.2 for the contract (namespace A: `team.<base64url>`;
  namespace B: literal `unknown`). The unknown literal
  `bucket_key = "unknown"` is also accepted and renders the
  unknown bucket's contents (see §2.5.4 for the unknown panel
  split). The R1 sentinel `__unknown__` is **not** a valid
  token in W05B and is rejected as `INVALID_FILTER` (§2.5.2).
  `bucket_key` is **not** a `team_id` UUID, **not** a
  `recruiter_id`, **not** a `scope_team_id`, **not** a
  `display_name`, **not** the raw `teams.code`, and **not**
  any user-inferable text. The server is the **single**
  authority that maps a `bucket_key` to a fact-row set; the UI
  never tries to decode or guess it.
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

**§2.5.2 (locked — `bucket_key` contract, namespaced token, no UUID, no
display text, no raw `teams.code`):** `bucket_key` is the
sanitized identity the chart emits for each team bucket and the
drill-down accepts back. The contract has two disjoint namespaces
so that no known-team token can ever equal the unknown literal
(even when a team's `code` happens to be the string
`__unknown__` or `unknown`). The two namespaces are:

- **Namespace A — known-team token:**
  `bucket_key = "team." || base64url_no_padding(UTF-8(teams.code))`,
  where `base64url_no_padding` is the RFC 4648 §5 alphabet
  (`A-Z a-z 0-9 - _`) without the `=` padding. The literal
  prefix `team.` is a **serialization-only marker**: it is
  appended by the server when constructing the wire token, and
  the server never parses a raw `teams.code` looking for the
  `team.` prefix. (A team's `code` itself can contain `.` —
  the W01C-A canonical rule only forbids whitespace and
  control characters in the canonical `teams.code`, per
  `p3_1_w01c_a_team_catalog.sql` line 404's
  `v_code ~ '[[:space:][:cntrl:]]'` guard, and the
  W01C-A **catalog-mutation** create guard (line 410)
  forbids the reserved literal `__system_vendor__` for
  catalog create. The W01C-A reserved-literal rejection
  is a **mutation** guard only; the W05B reporting read
  path **accepts** a known-team token whose decoded
  canonical `code` is the literal `__system_vendor__`
  provided the row exists in `public.teams` (see §2.5.2
  step 7 and E22 — the W07A-R3 / R4 migrations install
  and use that row as the canonical Vendor team for all
  `provider_type='vendor'` facts). The `.` character
  itself is allowed in a canonical `teams.code`, and the
  server does not interpret that as a namespace marker —
  the marker exists only in the wire serialization, not in
  the stored `code`.) The payload is the canonical
  `teams.code` (the same value stored on the team's row,
  which is `unique` and has a
  `length(btrim(code)) between 1 and 128` per
  `p1_6_direct_entry_foundation.sql` lines 22–26; the W01C-A
  append-only revision ledger
  `p3_1_w01c_a_team_catalog.sql` keeps `code` stable for a
  team across versions). The `team.` prefix and the
  base64url encoding together guarantee:
  - no known-team token starts with the unknown literal
    `unknown` (every known-team token starts with `team.`);
  - no two distinct teams ever produce the same token
    (`base64url` is bijective, `teams.code` is unique, and
    the canonical `teams.code` is preserved across
    versions);
  - a team whose `code` is the literal string `__unknown__`
    (or `unknown`, or any other string, including a string
    that happens to begin with `team.`) produces a
    known-team token of the form
    `team.<base64url("__unknown__")>`, which is a
    **known-team** token, not the unknown literal.
- **Namespace B — unknown literal:** the literal string
  `unknown` (no prefix, no payload, no decoration). This is
  the **only** sentinel. Every other sentinel is rejected.
  The literal `__unknown__` is **not** a valid token in
  W05B; it is a stale alias from R1 and the server rejects
  it. The unknown literal is the only token that maps to
  the unknown bucket's contents (see §2.5.4); every other
  token is a known-team token and must resolve to exactly
  one row in `public.teams`.

The token rules in detail:

- `bucket_key` is **opaque** to the UI and the wire format:
  it is a `text` token the server derives and the UI passes
  verbatim. The UI never decodes it, never infers it from
  display text, and never shows it to the user as a "code"
  or "id" (the user sees only `display`). The chart never
  renders `bucket_key` to the user; the user sees only
  `display` (with the " (Đã ngừng hoạt động)" suffix for
  inactive teams).
- `bucket_key` is **stable** across reads: the same team
  yields the same `bucket_key` in the chart, in the
  drill-down response, and in any future paginated request.
  The derivation is the one in namespace A above; the
  W01C-A append-only revision ledger locks `code` for a
  team across versions, so the token is stable for the
  lifetime of the team.
- `bucket_key` is **non-colliding with the unknown literal**
  by construction: every known-team token starts with
  `team.`; the unknown literal is the bare `unknown`. There
  is no string that is both a known-team token and the
  unknown literal. There is no `teams.code` whose token
  equals `unknown`. There is no `teams.code` whose token
  starts with `unknown`.
- `bucket_key` is **sanitized for the wire**, with byte
  bounds that **cover every legal canonical `teams.code`**.
  The DB-level constraint on `teams.code` is
  `length(btrim(code)) between 1 and 128` (per
  `p1_6_direct_entry_foundation.sql` line 22; PostgreSQL
  `length()` on `text` counts **characters**, not bytes).
  The W01C-A app-level rule additionally forbids whitespace
  and control characters
  (`v_code ~ '[[:space:][:cntrl:]]'`, per
  `p3_1_w01c_a_team_catalog.sql` line 404) and the
  catalog-mutation create guard (line 410) forbids the
  reserved literal `__system_vendor__` for catalog
  create. The W01C-A reserved-literal rejection is a
  **mutation** guard only — it is not applied to the
  W05B reporting read path (see §2.5.2 step 7 and E22).
  A canonical
  `teams.code` is therefore at most 128 characters long;
  its UTF-8 byte size is at most `4 * 128 = 512` bytes
  (UTF-8 encodes any Unicode code point in at most 4 bytes).
  The server validates the wire format BEFORE any decode.
  The wire validation accepts exactly two forms:
  - unknown literal: `bucket_key = "unknown"` (length 7,
    no other string);
  - known-team token: `bucket_key` matches the regex
    `^team\.[A-Za-z0-9_-]+$` with `7 ≤ length ≤ 688`.
    The lower bound 7 covers the `team.` prefix (5 chars)
    plus the minimum payload (2 base64url chars for a
    1-byte `teams.code` — a 1-char ASCII code such as
    `f` encodes to `Zg`, which is 2 chars; the server
    separately validates the decoded payload against the
    canonical `teams.code` rule — see below). The upper
    bound 688 covers the **worst-case** legal canonical
    `teams.code`:     a 128-character code whose UTF-8 form is
    512 bytes encodes to **683** base64url chars. The
    exact math: `512 = 170 * 3 + 2` (170 full 3-byte
    groups plus 2 remaining bytes); 170 full groups
    produce `170 * 4 = 680` base64url chars; the 2
    remaining bytes produce 3 base64url chars (no
    padding for base64url); total payload is
    `680 + 3 = 683`. (Note: `ceil(512 / 3) * 4 = 684`
    overcounts by one — the `ceil(512/3) = 171` form
    assumes a `=` padding char for the 2 remaining
    bytes, which is **not** present in
    `base64url_no_padding`; the correct count is
    `170 * 4 + 3 = 683`, verified: Node's
    `Buffer.from(512-byte buffer).toString('base64url')
    === 683 chars`.) Plus the 5-char `team.` prefix, the
    total wire length is `5 + 683 = 688`. The bound is **tight** — every
    legal canonical `teams.code` (per the DB-level check
    and the W01C-A rule) is representable, and any wire
    payload longer than 688 chars is rejected without
    allocation. The **128-character 4-byte-UTF-8
    boundary** (a code of 128 chars × 4 UTF-8 bytes/char
    = 512 bytes, e.g. 128 copies of the unicorn emoji
    `🦄` U+1F984) produces a token of exactly 688 chars
    (the upper bound); a 129-character 4-byte-UTF-8 code
    (129 × 4 = 516 bytes) produces a 693-char token and
    is rejected; a 689-char known-team token is rejected
    (the wire bound is 688, not 689 — see E20).

  Any `bucket_key` that does not match one of those two
  forms — including the stale R1 sentinel `__unknown__`,
  the literal `team.` with no payload, the literal `team`
  with no `.`, whitespace, punctuation outside the
  base64url alphabet, a token shorter than 7 chars, or a
  known-team token longer than 688 chars — is rejected
  as `INVALID_FILTER`. There is no fallback and no 404
  leak. The wire bound 688 is the **floor** of the legal
  maximum; lowering it (e.g. to 256, R2's mistake) would
  reject a legal canonical Unicode `teams.code` of 128
  characters, so the bound is pinned at 688 (and 256 is a
  regression that the test in §2.8 catches — see M22).
- `bucket_key` is **decoded, UTF-8 validated, canonically
  re-encoded and byte-for-byte compared** for known-team
  tokens. The pipeline is:
  1. Strip the `team.` prefix; the remainder is the
     request's payload string `P_request`.
  2. base64url-decode `P_request` to bytes
     `B_request`. Decode is non-strict (RFC 4648 §3.5
     permits lenient decode); the canonical check below
     rejects any non-canonical encoding.
  3. Interpret `B_request` as UTF-8 with strict
     well-formedness; reject if not well-formed UTF-8.
  4. Compute `B_canonical = bytes_of_UTF-8(B_request)` —
     this is the canonical byte sequence of the decoded
     string, identical to `B_request` when the request
     was well-formed UTF-8.
  5. Compute `P_canonical = base64url_no_padding(B_canonical)`.
  6. **Byte-for-byte compare `P_canonical` to
     `P_request`.** If they differ, the request encoded
     a non-canonical alias (e.g. `team.Zh` for the
     canonical `team.Zg` of the team whose `code = "f"`:
     Node's lenient decoder decodes `Zh` to `f`, but
     `re-encode("f") = "Zg" ≠ "Zh"`); the token is
     rejected as `INVALID_FILTER`. This comparison is
     the canonical-form check; it is the only defense
     against non-canonical base64url aliases, and dropping
     it makes E21 fail (see §2.8 / M21).
  7. Apply the full canonical `teams.code` rule from
     W01C-A: `btrim` non-empty, `length(btrim(code))
     between 1 and 128` (character count, per PG
     `length(text)`), no whitespace (`[[:space:]]`),
     no control characters (`[[:cntrl:]]`).
     A payload that fails any of these checks is rejected
     as `INVALID_FILTER`. (The character-count check
     `length(btrim(code)) between 1 and 128` is the
     **same** as the DB-level CHECK constraint on
     `public.teams.code` — the server applies the same
     rule the schema applies, in addition to the
     whitespace / control guard from the W01C-A
     canonical rule.)
     The W01C-A **reserved-literal rejection**
     (`v_code = '__system_vendor__'` in
     `direct_entry_create_team`, line 410 of
     `p3_1_w01c_a_team_catalog.sql`) is a
     **catalog-mutation** guard: it stops the catalog
     operator from creating a new team with that
     `code`. It is **not** a read-path guard. W07A-R3
     (`p3_w07a_r3_vendor_hidden_team_and_document_upload.sql`,
     migration #65) and W07A-R4
     (`p3_w07a_r4_vendor_historical_team_backfill.sql`,
     migration #66) install a single canonical
     `__system_vendor__` row in `public.teams` and
     route every `provider_type='vendor'` Direct Entry
     fact to that row's `team_id`. The
     `__system_vendor__` row is a **system team**,
     not a business team: the row is **active** in
     `public.teams` (canonical, unique), but W07A-R3
     explicitly labels the reserved row as "not a
     business team" (the trigger
     `direct_entry_reject_system_vendor_business_team`
     raises `'reserved Vendor team is not a business
     team'` on every attempt to insert the row into
     `public.recruiter_team_memberships` or into
     `public.direct_entry_scope_grants` with
     `scope_kind = 'team'`). W07A-R3 also comments
     the trigger as "Prevent the reserved row from
     becoming a selectable recruiter team or a
     report audience, including through later
     administrative provisioning." — the system team
     is not selectable as a business team, not
     selectable as a report `team` / `own` audience
     team, and not a target for catalog
     create / update / activate. The W05B reporting
     read path therefore **accepts** a known-team
     token whose decoded canonical `code` is the
     literal `__system_vendor__`, provided the row
     exists in `public.teams` (W07A-R4 lines 39–49
     guarantee the row is canonical, unique, and
     active before any backfill). The bucket and the
     drill-down are reachable only for the BoD
     audience `all`: the W05A
     `direct_entry_reporting_resolve_audience` RPC
     returns `audience = 'all'` only when the actor
     has an active `all` scope grant, and the
     `all`-scope authorized-entries view reads every
     Vendor Direct Entry fact (the Vendor team's
     `team_id` is in the join, but the audience is
     not filtered by `team_ids`); a `team` / `own`
     audience never includes the Vendor system team
     in its `team_ids` (the W07A-R3 trigger blocks
     the team-scope grant, so no actor has a
     `team_ids` that resolves to `__system_vendor__`),
     and the W05B drill-down RPC also gates on
     `dbKind === "all"` and rejects `team` / `own` /
     anonymous actors with `REPORTING_QUERY_FAILED`.
     The W05B acceptance of the reserved literal is
     therefore **read-path-only, BoD-only**, and
     does **not** infer any business-team permission
     or any `team` / `own` audience scope. The two
     rules — W01C-A mutation (catalog
     create / update / activate reject) and W05B
     reporting resolution (read path accepts, BoD
     audience only) — are **deliberately disjoint**;
     this memo locks the read-path rule.
  8. Look up the canonical `code` against
     `public.teams.code` (the `unique` index). The
     payload must match exactly one row. Zero or more
     than one row → `INVALID_FILTER` (no 404 leak, no
     row data exposed).

  The drill-down RPC pins every step of this pipeline
  with a server test (E21 covers the canonical re-encode
  comparison; E20 covers the 128-character Unicode
  payload; E16-E19 cover the namespace disjointness and
  the unknown literal; E22 covers the read-path
  acceptance of the W01C-A reserved `__system_vendor__`
  literal as a known-team token).
- `bucket_key` is **never** the `team_id` UUID, **never**
  the raw `teams.code`, **never** the `display_name`, and
  **never** any of `recruiter_key` / `project_key` /
  `scope_team_id` / `auth_subject` / `app_user_id`. The
  drill-down response **row** does not carry `bucket_key`,
  `team_id`, `team_code`, `recruiter_key`, `project_key`,
  or any other internal team identifier either; the team
  identity is implicit in the request's `bucket_key` (see
  §2.5.3) and the response's top-level `bucket.key` echoes
  the request's `bucket_key` (round-trip). The read-model
  pins this rule.
- `bucket_key` is the only field the chart emits to
  identify a bucket. The chart's bucket shape is
  `{ bucket_key: string, display: string, recruitedCount:
  number }` (additive on the BoD team's response). The
  drill-down response echoes
  `bucket: { key: string, display: string }` round-trip;
  the echoed `key` is the request's `bucket_key` (the
  namespaced token, not the raw `teams.code`).
- `bucket_key` is a **routing key, not an authority
  token**. The drill-down RPC re-resolves the audience
  via `direct_entry_reporting_resolve_audience` (§2.4)
  and validates the `bucket_key` server-side. The token
  does not carry any capability, grant, audience, or PII
  claim; it is a lookup handle. The drill-down RPC
  signature
  `(p_auth_subject uuid, p_app_user_id uuid,
  p_bucket_key text, p_filters jsonb, p_cursor text,
  p_limit integer)` has **no** audience parameter; the
  caller never supplies a resolved audience. Audience is
  **always** re-resolved server-side from
  `(p_auth_subject, p_app_user_id)`; the server rejects
  any call where the resolved audience is not `all` (a
  `team` / `own` / anonymous actor is rejected with
  `REPORTING_QUERY_FAILED`, no 404 leak). The drill-down
  is therefore BoD-authoritative by construction, with
  no trust in any caller-supplied audience.

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
when the user opens the unknown bucket (`bucket_key = "unknown"`),
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

- **Reuse W05A:** the BoD team chart and the drill-down both
  consume the **same** audience predicate
  (`direct_entry_reporting_authorized_entries`) and the
  **same** eligibility filter (state='SUBMITTED',
  deleted_at IS NULL, first_work_date >= cutoff, all
  audience). The W05A RPC
  `direct_entry_reporting_scoped_facts` is the **single
  source of facts** for both the BoD chart and the
  drill-down. The drill-down is a **separate** RPC
  (`direct_entry_reporting_team_drill_down`, locked name)
  that intersects the authorized set with the requested
  `bucket_key` set and applies the same filter parser. The
  drill-down RPC signature
  `(p_auth_subject uuid, p_app_user_id uuid,
  p_bucket_key text, p_filters jsonb, p_cursor text,
  p_limit integer)` has **no** audience parameter; the
  caller never supplies a resolved audience, and the
  contract does not have any "caller passes the resolved
  audience" field. The drill-down RPC **internally**
  re-resolves the audience via
  `direct_entry_reporting_resolve_audience` from
  `(p_auth_subject, p_app_user_id)`; if the resolved
  audience is not `all`, the RPC returns
  `REPORTING_QUERY_FAILED`. The drill-down is therefore
  BoD-authoritative by construction, with no trust in any
  caller-supplied audience and no client-side audience
  inference.
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
| Team drill-down endpoint (new RPC) | Renders sanitized rows for the requested `bucket_key` (or the unknown panel for the `unknown` literal); respects filter parser; respects bounded pagination | Rejected with `REPORTING_QUERY_FAILED` (the caller's audience is `team`; no leak, no 404) | Rejected with `REPORTING_QUERY_FAILED` (same reason) | Rejected with `REPORTING_QUERY_FAILED` (audience is null / not `all`) |
| Team drill-down row shape | Only `business_date, project_display, recruiter_display, provider_type_display, employment_type_display, recruited_count, first_work_date` (no `entry_id`, no `team_id`, no `team_code`, no `bucket_key`, no `teams.code`, no internal id) | n/a | n/a | n/a |
| Team drill-down `limit` | Default 25, max 100; >100 → `INVALID_FILTER`; `limit = 0` → `INVALID_FILTER`; non-numeric `limit` → `INVALID_FILTER` | n/a | n/a | n/a |
| Team drill-down `cursor` | Opaque server string; out-of-range returns empty page + `nextCursor: null`; undecodable `cursor` → `INVALID_FILTER` | n/a | n/a | n/a |
| Team drill-down `bucket_key` validation | Wire check (BEFORE any decode) accepts exactly two forms: the unknown literal `"unknown"` (length 7), OR a known-team token matching `^team\.[A-Za-z0-9_-]+$` with `7 ≤ length ≤ 688` (the upper bound covers the worst-case legal canonical `teams.code`: 128 characters × max 4 UTF-8 bytes/char = 512 bytes; `512 = 170*3 + 2` → `170*4 + 3 = 683` base64url chars + 5-char `team.` prefix = 688; verified against Node's `Buffer.from(512-byte buffer).toString('base64url') === 683` chars). For known-team tokens the server then strips the `team.` prefix, base64url-decodes the payload (canonical base64url — RFC 4648 §5 no-padding alphabet `A-Z a-z 0-9 - _`), validates the canonical-form check (UTF-8 well-formedness + byte-for-byte re-encode comparison, see §2.5.2), validates the canonical `teams.code` check (`btrim` non-empty, `length(btrim(code)) between 1 and 128` character count, no whitespace `[[:space:]]`, no control `[[:cntrl:]]`), and resolves the canonical `code` against `public.teams.code` (must match exactly one row). **The W05B known-team validation has no `__system_vendor__` rejection** — the W01C-A reserved-literal rejection (`p3_1_w01c_a_team_catalog.sql` line 410) is a **catalog-mutation** guard only and is **not** applied here; the W05B reporting read path **accepts** a known-team token whose decoded canonical `code` is the literal `__system_vendor__` provided the row exists in `public.teams` (W07A-R3 / R4 install and use that row as the canonical Vendor **system** team — not a business team — for all `provider_type='vendor'` facts; see E22). The system team is read-accessible on the W05B reporting read path only, and the drill-down is reachable only for the BoD audience `all`. Anything else — including the R3 stale `__unknown__`, the literal `team.` with no payload, the literal `team` with no `.`, whitespace, punctuation outside the base64url alphabet, a payload that decodes to a non-`teams.code` string (whitespace, control, length > 128), a payload that fails the canonical re-encode comparison (non-canonical base64url alias), a known-team token shorter than 7 chars, a known-team token longer than 688 chars, or a payload that matches zero or more than one `public.teams` row — is rejected as `INVALID_FILTER` (no 404 leak). The drill-down RPC is also `dbKind === "all"` gated; a `team` / `own` / anonymous actor is rejected with `REPORTING_QUERY_FAILED` (see §2.5). The RPC signature has no audience parameter; the audience is always re-resolved server-side from `(p_auth_subject, p_app_user_id)` (see §2.6). | n/a | n/a | n/a |
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
  drill-down both show `T1`. The bucket's `bucket_key` is the
  namespaced canonical token
  `team.<base64url_no_padding(UTF-8(T1.code))>` (per §2.5.2
  namespace A; the team's `code` is stable across the W01C-A
  revision history, so the token is stable for the lifetime
  of the team).
- **E3: unknown bucket.** The unknown bucket equals the sum of
  (a) the legacy aggregate's `recruited_count` for the current
  filter window and (b) the Direct Entry defensive null / orphan
  row count for the same filter window. The unknown bucket is
  emitted in the chart only if (a) + (b) > 0. The unknown panel
  renders two sections (legacy aggregate total + Direct Entry
  anomaly row list). The legacy aggregate total equals (a) and
  matches the BoD `cutover` date and the `business_date` range.
- **E4: drill-down happy path.** A BoD request with a valid
  `bucket_key` (a known-team token in namespace A, or the
  `unknown` literal in namespace B), a valid filter set and
  `limit=25` returns the first page in `business_date` /
  `recruiter_display` / `entry_id` order, the `nextCursor`
  matches the next page, the second page returns the
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
- **E11: `bucket_key` is opaque, stable and namespaced.** A
  bucket for team `T1` is keyed in namespace A:
  `bucket_key = "team." || base64url_no_padding(UTF-8(T1.code))`
  in both the chart and the drill-down response. The test seeds
  a team, asserts the chart's `bucket_key` matches the
  `team.<base64url(T1.code)>` form, asserts the drill-down's
  `bucket.key` round-trips the same namespaced token, then
  renames the team's `display_name` and re-asserts (the
  `bucket_key` is unchanged — `display_name` is not part of
  the token derivation). Renaming the team's `code` is not
  allowed by the W01C-A append-only revision ledger, so it is
  not tested here.
- **E12: inactive team stays in its own bucket.** A team is
  deactivated (`active = false`) and the BoD chart is read again.
  The team's bucket still appears, with `bucket_key` unchanged
  (the namespaced token derived from `T.code`), `display`
  suffixed " (Đã ngừng hoạt động)", and `recruitedCount`
  unchanged. The total of all buckets still equals
  `recruitedTotal`.
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
- **E16: `bucket_key` is in the namespaced form, never the raw
  `teams.code` on the wire.** The chart's `bucket_key` for a
  known team is always `team.<base64url(teams.code)>`. A test
  reads the BoD team chart for a team with a known `code` and
  asserts: (a) `bucket_key` matches `^team\.[A-Za-z0-9_\-]+$`,
  (b) `bucket_key` does **not** equal the raw `teams.code`,
  (c) `bucket_key` does **not** start with `unknown`, (d) the
  payload portion decodes (base64url) to the canonical
  `teams.code` (UTF-8, `btrim` length 1-128). The drill-down
  response's `bucket.key` is the same namespaced token (round-
  trip). The drill-down row does not carry `bucket_key` (the
  chart's bucket identity is implicit in the request's
  `bucket_key`).
- **E17: a team whose `code = "__unknown__"` produces its own
  known-team bucket, never the unknown literal.** A test seeds
  a real team `T_unknown_with_sentinel_code` with
  `code = "__unknown__"` (the schema reserves only
  `__system_vendor__`, so this is a legal `code` per
  `p1_6_direct_entry_foundation.sql`), seeds one Direct Entry
  fact whose `team_id` resolves to that team, and reads the BoD
  team chart. The test asserts: (a) the chart emits a
  known-team bucket with `bucket_key = "team." ||
  base64url("__unknown__") = "team.X191bmtub3duX18"`, (b) the
  chart does **not** emit a bucket with `bucket_key = "unknown"`
  (the unknown literal) just because of this row, (c) the
  chart's totals still reconcile (the team's contribution
  stays in the team's bucket), (d) opening the drill-down for
  that team resolves to the team's rows (not the legacy
  aggregate or the defensive null / orphan list). The test
  also asserts that a chart emitted while this team has zero
  facts and the unknown bucket has facts still emits the
  unknown bucket as the bare `unknown` literal (no `team.`
  prefix). This is the non-collision invariant from §2.5.2.
- **E18: a team whose `code = "unknown"` (no underscores)
  also produces its own known-team bucket, never the unknown
  literal.** A test seeds a real team `T_unknown_no_underscore`
  with `code = "unknown"` (legal per the schema; length 7 ≤
  128), seeds one Direct Entry fact whose `team_id` resolves to
  that team, and reads the BoD team chart. The test asserts:
  (a) the chart emits a known-team bucket with
  `bucket_key = "team." || base64url("unknown") =
  "team.dW5rbm93bg"`, (b) the chart does **not** emit a bucket
  with `bucket_key = "unknown"`, (c) the team's contribution
  stays in the team's bucket (not in the unknown bucket). The
  unknown bucket, if it has facts (legacy aggregate or
  defensive null / orphan), still emits `bucket_key =
  "unknown"` (the literal). Two distinct namespaces coexist
  cleanly.
- **E19: the unknown bucket uses the bare `unknown` literal,
  never the stale R1 `__unknown__` sentinel.** A test seeds a
  legacy aggregate row (no `team_id`) and reads the BoD team
  chart. The test asserts: (a) the chart emits a bucket with
  `bucket_key = "unknown"` (length 7, no `team.` prefix, no
  underscores), (b) the chart does **not** emit a bucket with
  `bucket_key = "__unknown__"` (length 11, R1 sentinel). A
  second test calls the drill-down with `bucket_key =
  "__unknown__"` and asserts the response is
  `INVALID_FILTER` (the R1 sentinel is rejected; see §2.5.2
  wire check and §2.5 server validation). A third test calls
  the drill-down with `bucket_key = "unknown"` and asserts the
  unknown panel renders Section A (legacy aggregate total) +
  Section B (defensive null / orphan row list, empty in this
  fixture).
- **E20: a canonical 128-character 4-byte-UTF-8 `teams.code`
  is accepted and its wire token is exactly 688 chars (the
  upper bound).** A test seeds a team whose `code` is **128
  copies of the unicorn emoji `🦄` U+1F984** — each code
  point is 4 UTF-8 bytes, so 128 chars × 4 bytes/char = 512
  UTF-8 bytes, the worst-case legal canonical `teams.code`.
  The test asserts: (a) the BoD team chart emits a known-team
  bucket with `bucket_key = "team." ||
  base64url_no_padding(UTF-8(code))`, (b) the wire token is
  **exactly 688 chars** (5-char `team.` prefix + 683-char
  base64url payload, computed as
  `170 * 4 + 3 = 683` from the
  `512 = 170 * 3 + 2` group split — verified: Node's
  `Buffer.from(512-byte buffer).toString('base64url') ===
  683` chars; Node's
  `Buffer.from('🦄'.repeat(128), 'utf8').toString('base64url')` is
  also 683 chars), (c) the drill-down request with that
  688-char token is accepted and resolves to the team's
  rows, (d) the canonical-form re-encode comparison passes
  (`P_canonical == P_request`), (e) the W01C-A rule passes
  (`btrim` non-empty, `length(btrim) = 128`, no whitespace,
  no control), (f) the `public.teams.code` lookup matches
  exactly one row. A second test seeds a team whose `code`
  is 64 × `ê` (128 UTF-8 bytes, 128 chars) and asserts the
  token is exactly 5 + 172 = 177 chars
  (within the wire bound). A third test seeds a team whose
  `code` is 128 × `ê` (256 UTF-8 bytes, 128 chars) and
  asserts the token is exactly 5 + 344 = 349 chars. A
  fourth test seeds a team whose `code` is 4 ASCII chars
  with a 4-byte UTF-8 payload and asserts the token is
  exactly 11 chars (`team.` + 6 base64url chars); a fifth
  test seeds a team whose `code` is 1 ASCII char and asserts
  the token is exactly 7 chars (`team.` + 2 base64url
  chars). All five tokens are within the wire bound 7..688.
  **Boundary rejection cases** (a separate fixture, no real
  team): (g) a synthetic `bucket_key` of 689 chars (a
  canonical `team.<...>` form with a 684-char base64url
  payload) is rejected as `INVALID_FILTER` at the wire
  check (length 689 > 688 — the wire bound is 688, not 689);
  (h) a synthetic `bucket_key` derived from a 129 × `🦄`
  code (516 UTF-8 bytes, 693-char token) is also rejected
  at the wire check (length 693 > 688). The 128 × `🦄`
  boundary is the **tightest** legal maximum; anything
  longer is rejected without allocation.
- **E21: canonical-form re-encode comparison rejects
  non-canonical base64url aliases.** A test seeds a team
  whose `code = "f"`. The canonical payload for that
  team is `Zg` (Node:
  `Buffer.from("f", "utf8").toString("base64url") ===
  "Zg"`); the canonical token is `team.Zg` (7 chars, the
  minimum). The test asserts: (a) the chart emits
  `bucket_key = "team.Zg"` for that team, (b) a drill-down
  request with `bucket_key = "team.Zg"` is accepted and
  resolves to that team's rows. The test then sends a
  non-canonical alias: (c) a drill-down request with
  `bucket_key = "team.Zh"` is rejected as `INVALID_FILTER`
  (Node's lenient base64url decoder decodes `Zh` to `f`,
  but the canonical re-encode of `f` is `Zg`, which is
  byte-for-byte different from `Zh`; the canonical-form
  re-encode comparison in §2.5.2 step 6 catches the
  alias). A third assertion (separate fixture, **no
  team whose `code = "f"`**): (d) a drill-down request
  with `bucket_key = "team.Zg"` is rejected as
  `INVALID_FILTER` (the canonical-form re-encode
  comparison passes: P_canonical = "Zg" decodes to "f"
  and re-encodes to "Zg" — the request is well-formed
  UTF-8, passes the W01C-A canonical `teams.code` rule,
  and the payload matches the canonical form), but the
  `public.teams.code` lookup matches **zero rows** (no
  team with `code = "f"` in the fixture); zero rows
  → `INVALID_FILTER`. This is the **lookup-miss
  branch** of the read-path pipeline — the canonical
  re-encode is **not** the only gate, and the
  one-row-in-`public.teams` check is the final defense
  against a payload that decodes to a `code` that is
  not a real team).
- **E22: the W01C-A reserved `__system_vendor__` literal
  is a known-team token on the read path (a Vendor
  bucket, not Unknown).** A test seeds a real team
  whose `code = "__system_vendor__"`,
  `display_name = "Vendor"`, `active = true` (this is
  the canonical, unique, active system-team row that
  W07A-R3 installs in `public.teams` and that W07A-R4
  keeps canonical — both migrations precondition the
  row before any backfill; the W07A-R3 trigger
  `direct_entry_reject_system_vendor_business_team`
  raises `'reserved Vendor team is not a business
  team'` on every attempt to insert the row into
  `public.recruiter_team_memberships` or into
  `public.direct_entry_scope_grants` with
  `scope_kind = 'team'`, so the system team is not a
  business team, is not a selectable recruiter team,
  and is not a selectable report-audience team — the
  row is a system team that exists in `public.teams`
  for the read path only). The test
  then seeds N Vendor Direct Entry facts whose
  `team_id` resolves to that team (W07A-R3 / R4 route
  every `provider_type='vendor'` fact to that team_id).
  The test reads the BoD team chart and asserts: (a)
  the chart emits a known-team bucket with
  `bucket_key = "team." || base64url("__system_vendor__")
  = "team.X19zeXN0ZW1fdmVuZG9yX18"` (28 chars, verified
  against Node: `Buffer.from("__system_vendor__",
  "utf8").toString("base64url") === "X19zeXN0ZW1fdmVuZG9yX18"`,
  23 chars; + 5 = 28), (b) the chart does **not** emit
  a bucket with `bucket_key = "unknown"` just because
  of the Vendor facts (the Vendor facts are a
  known-team bucket, not Unknown), (c) the bucket's
  `display` is the current `teams.display_name` =
  `"Vendor"`, (d) the unknown bucket's count equals
  only the legacy aggregate plus Direct Entry
  defensive null / orphan (the N Vendor facts do
  **not** contribute to the unknown bucket; the
  `recruitedTotal` invariant still holds). The test
  then opens the BoD drill-down for the Vendor
  bucket and asserts: (e) the drill-down request with
  `bucket_key = "team.X19zeXN0ZW1fdmVuZG9yX18"` is
  accepted (the W01C-A reserved-literal rejection is a
  catalog-mutation guard only; the W05B read path
  accepts), (f) the response's
  `bucket: { key, display }` round-trips
  `key = "team.X19zeXN0ZW1fdmVuZG9yX18"` and
  `display = "Vendor"`, (g) the sanitized
  `DrillDownRow[]` contains the N Vendor facts (with
  the same shape as E6: `business_date`,
  `project_display`, `recruiter_display`,
  `provider_type_display`, `employment_type_display`,
  `recruited_count`, `first_work_date` — no
  `entry_id`, `team_id`, `team_code`, `bucket_key`,
  `auth_subject`, `app_user_id`, or any other
  internal identifier), (h) the drill-down RPC
  re-resolves audience to `all` (the BoD-only gate;
  a `team` / `own` actor calling the same
  `bucket_key` is rejected with
  `REPORTING_QUERY_FAILED`; no membership or scope is
  added for the reserved team). The test pins that
  the reserved `__system_vendor__` literal flows
  through the W05B read path as a normal known-team
  token.

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
| Use `display_name` as `bucket_key` (or return `display_name` as `bucket_key` to the client) | E11, E16 |
| Reject only the `__unknown__` sentinel at `bucket_key` validation while accepting any other string | E11, E16, E17, E19 |
| Revert the chart to `bucket_key = teams.code` (drop the `team.` prefix and base64url encoding) | E11, E16, E17, E18 |
| Revert the unknown literal to the R1 sentinel `__unknown__` (or to any other non-`unknown` literal) | E17, E18, E19 |
| Accept a known-team token whose decoded payload does not match exactly one `public.teams` row (e.g. `team.<base64url("not_a_team")>`) | E16 |
| Accept a known-team token whose decoded payload fails the canonical `teams.code` check (empty, leading / trailing whitespace, length > 128, not valid UTF-8) | E16 |
| Accept the R1 stale sentinel `__unknown__` at the wire check (no `team.` prefix, has `__` decoration) | E19 |
| Accept a known-team token at the unknown-bucket drill-down (e.g. `bucket_key = "team.<base64url(...)">` mapped to the legacy aggregate card) | E17, E18, E19 |
| Emit the raw `teams.code`, the `team_id` UUID, or any other internal id on a drill-down row | E6, E16 |
| Drop the canonical-form re-encode comparison (skip the byte-for-byte `P_canonical == P_request` check in §2.5.2 step 6; keep the decode and the `public.teams.code` lookup) | E21 |
| Lower the wire upper bound from 688 to 256 (or any bound below 688 that does not cover the worst-case 512-byte canonical `teams.code`) | E20 |
| Accept a `bucket_key` whose decoded payload is not well-formed UTF-8 (skip the UTF-8 well-formedness check in §2.5.2 step 3) | E20, E21 |
| Accept a `bucket_key` whose decoded payload contains whitespace or control characters (skip the W01C-A `[[:space:]]` / `[[:cntrl:]]` guard in §2.5.2 step 7) | E20, E21 |
| Accept a `bucket_key` whose decoded `teams.code` is longer than 128 characters (skip the W01C-A character-count check in §2.5.2 step 7) | E20 |
| **Reject a `bucket_key` whose decoded canonical `code` is the W01C-A reserved `__system_vendor__` literal at the drill-down validation step** (treat the reserved literal as a drill-down `INVALID_FILTER` like the R3 contract did — the chart aggregation is **not** affected, the canonical row is still in `public.teams`, and the Vendor facts are still charted under the Vendor bucket; the mutation only fails E22's drill-down request with `INVALID_FILTER`) | E22 |
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
  by `bucket_key`, derived per §2.5.2 namespace A
  (`team.<base64url_no_padding(UTF-8(teams.code))>`) for known
  teams and the literal `unknown` (namespace B) for the unknown
  bucket. The bucket's `display` is the joined
  `teams.display_name`, suffixed with " (Đã ngừng hoạt động)"
  when `teams.active = false`. The unknown literal is used
  for null / orphan Direct Entry rows; the legacy aggregate
  contributes to the same unknown bucket. The `recruitedTotal`
  invariant (`total = sum(byTeam)`) is a server test pin. The
  read-model never emits the raw `teams.code` as
  `bucket_key`, never emits a `team_id` UUID as `bucket_key`,
  and never emits the R1 stale `__unknown__` sentinel. The
  read-model constructs the namespaced token by appending
  the `team.` prefix to the base64url of the UTF-8 bytes of
  the canonical `teams.code`; it does not parse the canonical
  `teams.code` looking for the `team.` prefix (a team's
  `code` is allowed to contain `.` per the W01C-A canonical
  rule — see §2.5.2 namespace A; the prefix is a
  serialization-only marker, not a name in the stored
  `code`). The token's wire length is bounded by the worst-
  case 512-byte canonical `teams.code` (128 characters ×
  4 UTF-8 bytes/char) → 5 + 683 = 688 chars; the read-model
  emits exactly that bound, never longer.
- Add a new server endpoint
  `fetchCutoverTeamDrillDown(params, actor)` in
  `p2-w04a-reporting-server.ts` (or a new sibling) that calls
  the new RPC, applies the same filter parser, applies the
  same `dbKind === "all"` gate, validates `bucket_key` per
  §2.5.2 (the wire check `7 ≤ length ≤ 688` for known-team
  tokens matching `^team\.[A-Za-z0-9_-]+$`, or the unknown
  literal `unknown`; the base64url decode + UTF-8
  well-formedness + canonical-form re-encode byte-for-byte
  comparison + the full W01C-A canonical `teams.code` rule
  (`btrim` non-empty, `length(btrim(code)) between 1 and 128`
  character count, no whitespace `[[:space:]]`, no control
  `[[:cntrl:]]`)
  + the one-row-in-`public.teams` check; the `unknown`
  literal bypasses the decode / canonical / row check and
  maps to the unknown bucket; the R1 stale `__unknown__`
  sentinel is rejected as `INVALID_FILTER` at the wire
  check; the W01C-A reserved-literal rejection
  (`__system_vendor__`) is a **catalog-mutation** guard
  only and is **not** applied here — a known-team token
  whose decoded canonical `code` is the literal
  `__system_vendor__` is **accepted** on the read path
  provided the row exists in `public.teams` — see E22
  and §2.5.2 step 7; the M29 mutation **reject a
  known-team token whose decoded canonical `code` is
  the reserved `__system_vendor__` literal** fails E22
  closed **at the drill-down validation step only** —
  the chart aggregation is unaffected (the Vendor
  bucket is still emitted because the canonical row
  exists), but the Vendor drill-down request is
  rejected with `INVALID_FILTER` (the chart's
  Vendor bucket key no longer opens a drill-down
  result); W07A-R3 / R4
  guarantee the row exists, so the read path's
  acceptance is exact — see E22), validates `limit` (default 25, max 100), validates
  `cursor` (server-issued opaque string; an undecodable
  `cursor` is rejected as `INVALID_FILTER`), and
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
    (E11, E16, E17, E18, E19, E20, E21, E22), the
    inactive-team rule (E12), the row-shape rejection of
    `team_id` / `team_code` / `bucket_key` on the
    response row (E6, E16), the
    `code = "__unknown__"` non-collision invariant (E17),
    the 128-character 4-byte-UTF-8 boundary acceptance
    (E20: 128 × `🦄` = 512 bytes → 688-char token; 689
    and 693 reject), the canonical-form re-encode
    comparison non-canonical-alias rejection (E21), the
    lookup-miss branch (E21(d): canonical decode pass +
    zero-row lookup), and the W01C-A reserved
    `__system_vendor__` literal accepted as a known-team
    token on the read path (E22: Vendor bucket + drill-
    down + audience re-resolve + Unknown unchanged);
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
- **R6 — `bucket_key` instability, collision, or non-canonical
  alias.** Risk: a developer uses `display_name` as
  `bucket_key` (display name can be renamed or duplicated),
  returns `team_id` as `bucket_key` (UUID leaks), uses the
  raw `teams.code` as `bucket_key` (collides with the unknown
  literal when a real team's `code` happens to be
  `__unknown__` or `unknown`), reverts the unknown literal
  to the R1 sentinel `__unknown__` (collides with a real
  team's code), drops the canonical-form re-encode
  comparison (a non-canonical base64url alias like `team.Zh`
  silently resolves to a different real team's row whose
  `code` decodes to the same bytes), or pins the wire upper
  bound at 256 (rejects a legal canonical 128-character
  Unicode `teams.code` whose UTF-8 size is up to 512 bytes,
  with a wire token of up to 688 chars); or **treats the
  W01C-A reserved `__system_vendor__` literal as a
  read-path `INVALID_FILTER`** (R3's wrong rule,
  which would reject every Vendor drill-down
  request as `INVALID_FILTER` — see E22 / M29;
  the chart's Vendor bucket is **not** affected
  by the M29 validation-only mutation, only the
  drill-down endpoint is). Mitigation: §2.5.2
  locks the namespaced contract — known-team tokens are
  `team.<base64url(UTF-8(teams.code))>` (namespace A), the
  unknown literal is the bare `unknown` (namespace B); the
  two namespaces are disjoint by construction; the server
  validates the wire format (the unknown literal, or a
  known-team token matching `^team\.[A-Za-z0-9_-]+$` with
  `7 ≤ length ≤ 688` — the upper bound covers the worst-
  case 512-byte canonical `teams.code`); the server then
  base64url-decodes the payload, validates UTF-8
  well-formedness, **byte-for-byte compares the
  re-encoded canonical form to the request's payload**
  (catches non-canonical base64url aliases), validates the
  full W01C-A canonical `teams.code` rule (`btrim`
  non-empty, `length(btrim(code)) between 1 and 128`
  character count, no whitespace, no control) —
  **the W01C-A reserved-literal rejection is a
  catalog-mutation guard only and is NOT applied to
  the read path** (the W05B reporting read path accepts
  a known-team token whose decoded canonical `code` is
  the literal `__system_vendor__`, provided the row
  exists in `public.teams` — W07A-R3 / R4 install and
  use that row as the canonical Vendor team for all
  `provider_type='vendor'` facts) — and resolves the
  canonical `code` against `public.teams.code` (must match
  exactly one row); the chart never shows `bucket_key` to
  the user; the R1 stale `__unknown__` sentinel is rejected
  at the wire check.   E11, E16, E17, E18, E19, E20, E21,
  E22 / M11, M12, M17, M18, M19, M20, M21, M22, M29 fail
  closed.
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
- **R12 — `bucket_key` validation is too loose, has the
  wrong bound, or skips the canonical re-encode.** Risk: a
  developer accepts any string at the `bucket_key` wire
  check and lets the server `JOIN teams ON teams.code =
  p_bucket_key` match a row only by accident, leaking the
  row's `team_id` to the wire; or a developer drops the
  base64url decode and lets a
  `team.<base64url("not_a_team")>` token resolve to zero
  rows (silent drop) or to a real team whose `code` decodes
  to the same payload (collision); or a developer accepts
  the R1 stale `__unknown__` sentinel at the wire check;
  or a developer pins the wire upper bound at 256 (rejects
  a legal canonical 128-character Unicode `teams.code`);
  or a developer drops the canonical-form re-encode
  comparison (a non-canonical base64url alias like
  `team.Zh` silently resolves to a different real team's
  row whose `code` decodes to the same bytes — Node's
  lenient base64url decoder accepts `Zh` for the canonical
  `Zg` of the team whose `code = "f"`). Mitigation: §2.5.2
  + §2.7 lock the wire check (the unknown literal
  `"unknown"`, or a known-team token matching
  `^team\.[A-Za-z0-9_-]+$` with `7 ≤ length ≤ 688` — the
  upper bound covers the worst-case 512-byte canonical
  `teams.code`), the base64url decode, the UTF-8
  well-formedness check, the **byte-for-byte canonical
  re-encode comparison** (catches non-canonical base64url
  aliases), the full W01C-A canonical `teams.code` check
  (`btrim` non-empty, `length(btrim(code)) between 1 and
  128` character count, no whitespace, no control) —
  the W01C-A reserved-literal rejection is a
  catalog-mutation guard only and is NOT applied to
  the read path (the W05B reporting read path accepts
  the `__system_vendor__` literal provided the row
  exists in `public.teams` — see E22 / M29), the
  one-row-in-`public.teams` check, and the explicit
  rejection of the R1 `__unknown__` sentinel; the
  response's `bucket.key` is the request's `bucket_key`
  round-trip.   E11, E16, E17, E18, E19, E20, E21, E22 /
  M11, M12, M17, M18, M19, M20, M21, M22, M29 fail
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
  " (Đã ngừng hoạt động)" label suffix; the W01C-A reserved
  `__system_vendor__` team is also **not** in the unknown
  bucket — it is a known-team bucket with
  `display = "Vendor"` and
  `bucket_key = "team.X19zeXN0ZW1fdmVuZG9yX18"`, and every
  Vendor Direct Entry fact (W07A-R3 / R4 backfilled) is
  charted there; the W01C-A reserved-literal rejection is
  a **catalog-mutation** guard only, deliberately disjoint
  from the W05B reporting resolution rule that accepts
  the literal on the read path — see §2.5.2 step 7 and
  E22; the `__system_vendor__` team is a **system
  team**, not a business team — it is excluded from
  the business catalog (W01C-A line 410 rejects the
  reserved literal on catalog create), blocked from
  `recruiter_team_memberships` and
  `direct_entry_scope_grants` (W07A-R3 trigger
  raises `'reserved Vendor team is not a business
  team'`), and not a selectable report-audience team;
  the W05B bucket and drill-down are reachable only
  for the BoD audience `all`, and the W05B drill-down
  RPC re-resolves the audience server-side and
  rejects `team` / `own` / anonymous actors with
  `REPORTING_QUERY_FAILED`); the BoD team chart and
  the team drill-down are reachable only for a DB-confirmed `all`
  audience; the drill-down is server-side, bounded (default 25,
  max 100), filter-narrowing, sanitized (no UUID, no recruiter_key,
  no project_key, no team_id, no team_code, no bucket_key, no
  entry_id, no submission_id, no source_id, no drive_file_id, no
  auth subject, no app_user_id); the drill-down first dimension is
  recruiter; `bucket_key` is the chart-to-drill-down token,
  derived per §2.5.2 namespace A
  (`team.<base64url_no_padding(UTF-8(teams.code))>`) for known
  teams and the literal `unknown` (namespace B) for the
  unknown bucket, validated server-side via the wire check
  (the unknown literal, or a known-team token matching
  `^team\.[A-Za-z0-9_-]+$` with `7 ≤ length ≤ 688` — the
  upper bound covers the worst-case 512-byte canonical
  `teams.code`, where `teams.code` is 1-128 characters per
  the DB-level check and at most 4 UTF-8 bytes/char), the
  base64url decode, the UTF-8 well-formedness check, the
  **byte-for-byte canonical re-encode comparison** (catches
  non-canonical base64url aliases), the full W01C-A
  canonical `teams.code` rule (`btrim` non-empty,
  `length(btrim(code)) between 1 and 128` character count,
  no whitespace, no control, not the reserved
  `__system_vendor__`), and the one-row-in-`public.teams`
  constraint; the R1 stale `__unknown__` sentinel is
  rejected as `INVALID_FILTER`; the token is a routing key,
  not an authority token; the drill-down RPC signature has
  no audience parameter, the audience is always re-resolved
  server-side from `(p_auth_subject, p_app_user_id)`, and
  the RPC validates the token server-side; the unknown
  drill-down panel is split into a
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
- **Review pass:** this memo is
  `P3_W05B_S0_R5_BOD_TEAM_REPORTING_SURVEY_PASS_AWAITING_T0_REVIEW`
  (R5 of the S0 survey; R1 locked the four prior blockers;
  R2 locked the namespaced `bucket_key` contract to remove
  the `teams.code` vs unknown-sentinel collision; R3 locked
  the byte-bound correctness for 128-character Unicode
  `teams.code` (1-128 chars × up to 4 UTF-8 bytes/char =
  up to 512 bytes payload → 5 + 683 = 688-char wire
  tokens), the canonical-form re-encode comparison to
  reject non-canonical base64url aliases, and the two
  factual corrections: the `team.` prefix is a
  serialization-only marker (a real `teams.code` can
  contain `.` per the W01C-A canonical rule, and the
  server does not parse the raw `code` looking for the
  prefix), and the drill-down RPC signature has no
  audience parameter — the audience is always re-resolved
  server-side from `(p_auth_subject, p_app_user_id)`, with
  no "caller passes the resolved audience" field in the
  contract; **R4 locks the read-path acceptance of the
  W01C-A reserved `__system_vendor__` literal as a
  known-team token** — the W01C-A reserved-literal
  rejection is a **catalog-mutation** guard only and is
  deliberately disjoint from the W05B reporting
  resolution rule; W07A-R3 / R4 install and use the
  reserved team as the canonical Vendor team for all
  `provider_type='vendor'` Direct Entry facts, and the
  W05B read path must accept
  `team.<base64url("__system_vendor__")> =
  team.X19zeXN0ZW1fdmVuZG9yX18` as a normal known-team
  token (Vendor bucket, drill-down success, audience
  re-resolve to `all`, no change to Unknown count, no
  membership / scope for the reserved team); R4 also
  locks the tight 128-character 4-byte-UTF-8 boundary
  acceptance (128 × `🦄` = 512 bytes → 688-char token;
  689 and 693 reject), the lookup-miss branch (E21(d):
  canonical decode pass + zero-row lookup), and the
  E2 historical-attribution bucket_key is the namespaced
  canonical token, not the raw `teams.code`); R4 also adds
  a new M29 mutation: **reject a known-team token whose
  decoded canonical `code` is the literal
  `__system_vendor__`** (i.e. treat the reserved literal
  as a read-path `INVALID_FILTER` like the R3 contract
  did) → E22 fails closed **at the drill-down
  validation step only** — the chart's Vendor bucket
  is unaffected (the canonical row still exists in
  `public.teams`, so the chart aggregation still
  emits the Vendor bucket), but the Vendor
  drill-down request is rejected with
  `INVALID_FILTER`; the Vendor facts are **not**
  dropped into Unknown and the `recruitedTotal`
  invariant still holds. **R5 refines the Vendor
  system-team terminology and narrows the M29
  mutation to the drill-down validation step**:
  (a) the `__system_vendor__` row is a **system
  team**, not a business team — the row is active
  in `public.teams` (canonical, unique) for the read
  path only; W07A-R3 explicitly labels the row "not
  a business team" (the trigger
  `direct_entry_reject_system_vendor_business_team`
  raises `'reserved Vendor team is not a business
  team'` on every attempt to insert the row into
  `public.recruiter_team_memberships` or
  `public.direct_entry_scope_grants` with
  `scope_kind = 'team'`); W07A-R3 also comments the
  trigger as "Prevent the reserved row from becoming
  a selectable recruiter team or a report audience,
  including through later administrative
  provisioning"; (b) the W05B bucket and drill-down
  are reachable only for the BoD audience `all`
  (the W05A `direct_entry_reporting_resolve_audience`
  RPC returns `audience = 'all'` only when the actor
  has an active `all` scope grant; the W07A-R3
  trigger blocks the team-scope grant, so a `team` /
  `own` audience never has a `team_ids` that resolves
  to `__system_vendor__`); (c) the W05B
  known-team validation has **no `__system_vendor__`
  rejection** — the W01C-A reserved-literal
  rejection (line 410) is catalog-mutation only and
  is not applied to the read path; the W05B rule is
  btrim non-empty, 1..128 characters, no
  whitespace, no control, canonical base64url, and
  one-row `public.teams.code` lookup — the W05B rule
  **allows** the reserved literal if the canonical
  row exists; (d) the M29 mutation is
  **drill-down-validation-only** — the mutation
  rejects a Vendor drill-down request with
  `INVALID_FILTER` at the §2.5.2 step 7 wire check,
  but the chart's Vendor bucket is **not** affected
  (the canonical row still exists in `public.teams`,
  so the chart aggregation still emits the Vendor
  bucket for the BoD audience `all`); the Vendor
  facts are **never** silently dropped to Unknown by
  the M29 mutation; the `recruitedTotal` invariant
  still holds under M29. R5 removes all R3 / R4
  wording that says the Vendor bucket "disappears
  from the chart" or the Vendor facts are "silently
  dropped" under M29 — those claims were
  over-scoping the M29 mutation (the mutation is
  validation-only, not aggregation). T0's review will check the locked decisions
  in §2.1, §2.2, §2.3 / §2.3.1 / §2.3.2, §2.4,
  §2.5 / §2.5.2 / §2.5.3 / §2.5.4, the acceptance /
  mutation plan in §2.8 (E1-E22, M1-M29), the migration
  posture in §2.6 / §3, the T1B / T1A split in §4, and
  the risk register in §5.
