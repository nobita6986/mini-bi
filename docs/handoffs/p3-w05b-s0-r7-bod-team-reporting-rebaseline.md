# P3-W05B-S0-R7 — BoD team reporting contract rebaseline (current main)

> **Status:** `P3_W05B_S0_R7_CURRENT_MAIN_REBASELINE_PASS_AWAITING_T0_REVIEW`
> **Base:** `origin/main@0c1676e17c27e4ea715d1c817d95a2ffe6efc9ba`
>   (`fix(admin): serialize navigation sections`; migration ledger = **84** files).
> **Branch:** `audit/p3-w05b-s0-r7-bod-team-reporting-rebaseline`
> **Worktree:** `C:\CodeApp\BI-p3-w05b-s0-r7-bod-team-reporting-rebaseline`
>
> **Rebaseline source (the contract this memo re-grounds):**
> `origin/audit/p3-w05b-s0-bod-team-reporting-survey@e91362437cd4755898a3028cbed14216f26c34e2`
>   (R6 memo `docs/handoffs/p3-w05b-s0-bod-team-reporting-survey.md`),
>   which was written against `origin/main@5f41caf689dbfd52bb889744f227aa659da393db`.
>
> **This memo does NOT modify** the R6 memo, the R6 branch, any source, API, UI,
> migration, contract doc, `package.json`, dependency or lockfile. It is docs-only
> and adds exactly one new file. No stub, no placeholder, no Production access,
> no apply, no deploy, no browser/UAT, no merge to `main`.
>
> **Authority (locked sources, priority order):**
>   1. `docs/master-plan.md` §9 (P3 — Authentication + Organization + Permission)
>      and §10 (P4 — KPI & Performance). Locked guarantees quoted verbatim:
>      §9 line 220 — "Nhân viên chuyển team không làm thay đổi phân bổ kết quả
>      lịch sử. Quyền Leader xem dữ liệu trước/sau thời điểm nhận team phải có
>      quy tắc được duyệt và ca kiểm tra riêng; không mặc định mọi Leader hiện
>      tại thấy toàn bộ lịch sử."; §9 line 211 — "team lịch sử xác định theo
>      business date.".
>   2. `docs/handoffs/p3-w05a-actor-scoped-reporting-team-scope.md`
>      (`direct_entry_reporting_resolve_audience`, `_authorized_entries`,
>      `_scoped_facts`, `_scoped_options`).
>   3. `docs/handoffs/p3-w06c-bod-team-own-dashboard.md` (audience-aware
>      BoD/Team/Own dashboard dispatch).
>   4. `supabase/migrations/20261008080000_p3_w05a_actor_scoped_reporting.sql`
>      (migration #48) and
>      `supabase/migrations/20261007020000_p2_w04a_direct_entry_reporting_cutover.sql`
>      (migration #40; view `direct_entry_reporting_facts_v01`).
>   5. `docs/handoffs/p3-1-w01c-b-team-membership.md` and
>      `docs/handoffs/p3-1-hf-legacy-team-leader-scope.md` (team membership
>      history and legacy leader-scope rules).
>   6. `supabase/migrations/20261009050000_p3_1_w01c_a_team_catalog.sql`
>      (the W01C-A append-only team revision ledger; `teams.code` is immutable).
>   7. **NEW (R7):** `supabase/migrations/20261011120000_p3_1_w02c_labor_type_catalog.sql`
>      (#79) + R2 (#80) + R3 (#81), which **patch the live reporting view and
>      function bodies in place**. This is now a first-class authority for the
>      W05B migration strategy (see §6).
> Where this memo and those sources differ, those sources win.

---

## 0. Purpose and non-goals

P3.1 Core is CLOSED/ACCEPTED; the active phase is **P3.1 Core Release**, which
composes:

- **P3-W05B-A** reporting backend/API by team (this contract),
- **P3-W06D** Dashboard BoD **two tabs**,
- release regression, Owner UAT, deploy VPS.

**W03B is parked outside `main`** and is NOT part of this base; it is not in the
authority list and **no migration slot is reserved for it**.

R6 was written on a base (`5f41caf`) that predates W02A, W02B, W02C (#79–#81),
W03A (#82–#84) and the W04-C/D admin UI. This R7 re-grounds the W05B contract on
current `main` (`0c1676e`), re-derives every factual claim from the current
source/migrations/tests, and locks one new UX decision from the Owner (the
two-tab BoD layout, §5).

**Non-goals:** this memo implements nothing. It locks the contract, the read-model
shape, the RPC/server boundary, the validation/error taxonomy, the label
authority, the migration strategy, the acceptance/mutation matrix, the
T1B/T1A split and the dependency graph, so that a later implementation task has
zero open contract questions.

---

## 1. Factual truth at `0c1676e` (verified against current source)

### 1.1 Read-model types (`src/lib/reporting/p1-reporting.ts`)

`ReportingFact` = `{ source_id, business_date, project_key, project_display,
recruiter_key, recruiter_display, provider_type_key, provider_type_display,
employment_type_key, employment_type_display, recruited_count }`. **No team
field.**

`ReportingBucket` = `{ key: string, display: string, recruitedCount: number }`.

`ReportingData` = `{ applied, recruitedTotal, byDate, byProject, byRecruiter,
byProvider, byEmployment, projectProviderMix, coverage, sources, dateExtent,
empty }`. **No `byTeam`.**

Locked error identifiers: `REPORTING_QUERY_FAILED_CODE = "REPORTING_QUERY_FAILED"`
(`p1-reporting.ts`), `INVALID_FILTER_CODE = "INVALID_FILTER"` (`p1-filter.ts`),
`P2_W04A_CUTOVER_BLOCKER_CODE = "REPORTING_CUTOVER_BLOCKER"`,
`P2_W04A_CUTOVER_FAILED_CODE = "REPORTING_QUERY_FAILED"` (`p2-w04a-cutover.ts`).
`P2_W04A_CUTOVER_DATE = "2026-09-30"`,
`P2_W04A_DIRECT_ENTRY_SOURCE_ID = "00000000-0000-4000-8000-0000de000001"`.

### 1.2 Filter parser (`src/lib/reporting/p1-filter.ts`)

`parseReportingFilters(params, scopeSourceIds?)` is the single filter parser for
`from`, `to`, `project`, `recruiter`, `provider`, `employment`, `source`.
`from > to` → `INVALID_FILTER`; `source` must be a UUID. Provider/employment
closed sets: `PROVIDER_FILTER_VALUES = ["hrp","vendor","__unknown__","__invalid__"]`,
`EMPLOYMENT_FILTER_VALUES = ["thời vụ","chính thức","__unknown__","__invalid__"]`.

### 1.3 DB facts projection (`direct_entry_reporting_facts_v01`)

Defined once in W04A migration #40 (`20261007020000`, lines 273–319). Current
**effective** column list (locked by the W04A self-check, line 568) is exactly:

```
source_id, business_date, project_key, project_display, recruiter_key,
recruiter_display, provider_type_key, provider_type_display,
employment_type_key, employment_type_display, recruited_count,
first_work_date, entry_id, submission_id, cutoff_date
```

**No team column.** Eligibility: `submission.state='SUBMITTED'`,
`direct_entries.deleted_at IS NULL`, `first_work_date >= cutoff`. The view runs as
owner (`security_invoker=false`), is `service_role`-only (`anon`/`authenticated`
revoked).

**CRITICAL (R7):** the view body is **no longer** the W04A original. W02C section
7b (#79) patched it **in place** via `direct_entry_w02c_replace_view_source`,
replacing the duplicated `CASE e.labor_type ... END` label map with
`public.direct_entry_reporting_employment_display(e.labor_type)`. Re-emitting the
W04A body would revert that patch.

### 1.4 Scoped facts RPC (`direct_entry_reporting_scoped_facts`)

Defined in W05A migration #48 (`20261008080000`, lines 259–421). Signature
`(p_auth_subject uuid, p_app_user_id uuid, p_filters jsonb) returns jsonb`.
Top-level envelope: `{ audience, facts, sources, latest_runs, presence }`. Each
`facts[]` element carries **exactly 15 keys**:

```
source_id, business_date, project_key, project_display, recruiter_key,
recruiter_display, provider_type_key, provider_type_display,
employment_type_key, employment_type_display, recruited_count,
first_work_date, entry_id, submission_id, cutoff_date
```

`facts` is built by reading `public.direct_entry_reporting_facts_v01` (Direct
Entry branch, `f.entry_id in (authorized_entries)`) `UNION ALL`
`daily_recruitment_breakdown` (legacy branch, `all` only, `< cutoff`).
Ordering tie-breakers include `entry_id`, `submission_id`. **No team key.**
`SECURITY DEFINER`, fixed `search_path = pg_catalog, public`, `service_role`
EXECUTE only.

### 1.5 Audience model (W05A)

`direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id)` returns a
sanitized jsonb `{ audience, label, team_ids, recruiter_id }` with kinds
`all`/`team`/`own` and priority **`all > team > own`**. The shared predicate
`direct_entry_reporting_authorized_entries` materializes the eligible `entry_id`
set; the facts RPC, the options RPC and the server read path all consume it, so
the audience rule is expressed exactly once. `team` filters on
`e.team_id = any(v_team_ids)` — the row's **stored** `team_id`, never the
recruiter's current membership.

### 1.6 Server read path (`src/lib/reporting/p2-w04a-reporting-server.ts`)

`fetchCutoverReporting(params, actor)`:
1. runtime blocker RPC `direct_entry_reporting_pre_cutover_blocker_count`;
2. `parseReportingFilters(params, undefined)`;
3. RPC `direct_entry_reporting_scoped_facts` with
   `{ p_auth_subject, p_app_user_id, p_filters }`;
4. `resolveReportingAudienceProjection(payload.audience)` (null → fail closed
   with `REPORTING_QUERY_FAILED`); `dbKind = audience.kind`;
5. `dbKind === "all"` → `validateAllSourceFilter`; else `filters.source = undefined`;
6. split Direct Entry vs legacy, mask, reconcile, `combineReportingFacts`,
   `computeReporting`.

`fetchCutoverReportingOptions(actor)` calls RPC
`direct_entry_reporting_scoped_options` → `{ dimensions, sources }`.
**No server-side drill-down function exists.**

### 1.7 Dashboard dispatch and UX (`p3-w06c-audience-view.ts`, components)

`resolveDashboardMode({ ok, audience })` → `error` | `all` | `team{view}` |
`own{view}`. `all` renders `DashboardBody` (BoD hero "BoD · Báo cáo điều hành" and
sections "Xu hướng tuyển dụng" + "Phân bổ tuyển dụng"). `team` renders
`TeamDashboardView` (member roster). `own` renders `OwnDashboardView`. A
successful read without a usable audience renders a neutral error, never facts.

**No tab/tabbed UI exists anywhere in `src/components/dashboard/**`.** Search
result: zero occurrences of a tab primitive in the dashboard components.

`/dashboard` is a **server component** (`src/app/dashboard/page.tsx`) that runs
`decideSessionPageAccess(actor)` then
`Promise.all([fetchCutoverReporting(params, actor.actor), fetchCutoverReportingOptions(actor.actor)])`.
**There is no reporting API route today**; interactive reads use Route Handlers
under `src/app/api/**` (e.g. `src/app/api/direct-entry/session/route.ts`).

### 1.8 `public.teams` schema and the reserved Vendor system team

`public.teams` (`20261002170000_p1_6_direct_entry_foundation.sql` lines 20–27):
`team_id uuid PK default gen_random_uuid()`, `code text not null unique
check(length(btrim(code)) between 1 and 128)`, `display_name text not null
check(length(btrim(display_name)) between 1 and 256)`, `active boolean not null
default true`, `version integer not null default 1`, `created_at timestamptz`.

W01C-A (`20261009050000`): create guard rejects non-canonical codes
(`btrim`, `length<=128`, no `[[:space:][:cntrl:]]`, line 405) and the reserved
literal `__system_vendor__` (line 410, `errcode='22023'`). `code` is immutable
after create — `direct_entry_update_team` writes **only** `display_name` (line
540), `set-active` writes **only** `active`; the team revision ledger
(`direct_entry_team_revisions`, guarded by `direct_entry_reject_immutable_change`)
is append-only. So `teams.code` is stable for the lifetime of a team.

W07A-R3 (`20261009010000`) installs the reserved row
(`public.direct_entry_system_vendor_team_id()` inserts
`teams(code='__system_vendor__', display_name='Vendor', active=true)`) and adds
the trigger `direct_entry_reject_system_vendor_business_team` which raises
`'reserved Vendor team is not a business team'` (`errcode='23514'`) on any attempt
to insert it into `recruiter_team_memberships` or `direct_entry_scope_grants`
(`scope_kind='team'`). W07A-R4 (`20261009020000`) backfills **every**
`provider_type='vendor'` entry onto that row and asserts no `team` dimension
appears in `direct_entry_reporting_dimension_options_v01`.

### 1.9 Migration ledger

84 `.sql` files on `main`; last by name is
`20261011170000_p3_1_w03a_r2_r1_account_read_repair.sql` (#84). W02C consumed
#79/#80/#81, W03A consumed #82/#83/#84 → **next available slot is #85** (an
OBSERVATION, not a reservation — see §11).

### 1.10 What does not exist yet

- No `byTeam` on `ReportingData`; no team key on the scoped fact payload.
- No `direct_entry_reporting_team_drill_down` RPC (name absent repo-wide).
- No `bucket_key`, no `fetchCutoverTeamDrillDown`, no two-tab BoD UI.
- No team option in `direct_entry_reporting_dimension_options_v01` (W07A-R4
  self-check pins this).

---

## 2. Factual delta vs R6 (`5f41caf` → `0c1676e`)

23 commits landed between the R6 base and current main. The ones that matter for
W05B:

| Delta | What changed | Impact on the W05B contract |
|---|---|---|
| W02C #79 + R1/R2/R3 #80/#81 | The labor-type **catalog** replaced the closed TEMPORARY/PERMANENT set; `direct_entry_reporting_employment_display()` / `_key()` added; the facts view + dimension-options view + `direct_entry_reporting_de_options_scoped` were **patched in place** by source replacement (commit `3019661` "patch live function and view bodies instead of re-emitting"). | **Decisive.** W05B MUST patch the live `direct_entry_reporting_facts_v01` and `direct_entry_reporting_scoped_facts` bodies, never re-emit them (§6). |
| W02A #72, W02B #75, W01D scope hotfix | Team-leader/PM authority, vendor lifecycle, leader scope. | No change to the reporting read path; no change to attendance rules. |
| W03A #82/#83/#84 | App-user lifecycle + account read. | Reporting untouched (no `reporting` symbol in any W03A migration). |
| W04-C / W04-D admin UI, W05-A admin UI | Vendor + labor-type + existing-account admin screens. | Admin-side only; W05B must still not call the Admin Catalog to build reporting labels. |
| Migration slot | Ledger grew from (R6-era) to **84**; W05B slot moves to next-available #85. | Recorded as an observation only (§11); R6's "no number reserved" rule is kept. |

**Net factual corrections to R6:** none of R6's locked contract *decisions* are
contradicted by current main. The corrections are (a) the migration strategy must
be patch-in-place (R6 said "alter the in-place projection" but did not name the
`pg_get_viewdef`/`pg_get_functiondef` + expected-count mechanism that W02C now
establishes as precedent), and (b) the Owner UX is the two-tab layout (§5), not
"add a card to the current dashboard" as R6 §2.1 described.

---

## 3. Locked contract — authority, attribution, buckets (carried from R6)

These R6 decisions are **kept verbatim** because current main proves no conflict:

- **Authority is entirely DB/server.** The audience resolver
  `direct_entry_reporting_resolve_audience` with priority `all > team > own` is
  the sole authority. No client-side role check widens data.
- **Cross-team surfaces and drill-down are available only when the DB-confirmed
  `audience.kind === "all"`.**
- **Historical attribution = `direct_entries.team_id` stored on the fact.** Not
  the recruiter's current team.
- **No join to `recruiter_team_memberships` / `recruiter_provider_memberships`**
  to re-attribute history.
- **Display name = current `teams.display_name`** (rename is visible
  retroactively; no `team_display_at_fact` snapshot).
- **Inactive teams keep their own bucket**, label suffixed
  `" (Đã ngừng hoạt động)"`; `bucket_key` and `recruitedCount` unchanged. No
  "include inactive" toggle.
- **Unknown / "Không xác định" bucket contains only:** the legacy aggregate and
  Direct Entry `team_id IS NULL` / orphan rows.
- **The Vendor system team (`__system_vendor__`) is a known-team bucket** on the
  reporting read path, `display = "Vendor"`, `bucket_key =
  team.<base64url("__system_vendor__")>`; its facts never fall into Unknown.
- **`bucket_key`:** known team = `"team." || base64url_no_padding(UTF-8(teams.code))`
  (namespace A); unknown = the bare literal `unknown` (namespace B). Never raw
  `teams.code`, never `display_name`, never a UUID. Canonical decode →
  UTF-8 well-formedness → byte-for-byte re-encode comparison → W01C-A canonical
  `teams.code` check → one-row `public.teams.code` lookup. Wire bound
  `7 ≤ length ≤ 688` for `^team\.[A-Za-z0-9_-]+$` (688 covers 128 chars × 4
  UTF-8 bytes/char = 512 bytes → 683 base64url chars + 5-char prefix). The R1
  sentinel `__unknown__` is rejected. The UI never shows `bucket_key`.
- **Drill-down:** server-side; default `limit` 25, max 100; opaque cursor;
  filters only narrow; audience re-resolved inside the RPC; sanitized row = the
  seven fields below; no N+1; no client-side team join; no Admin Catalog call.
- **Unknown panel:** Section A = legacy aggregate total (non-paginated, no
  entry-level rows); Section B = paginated Direct Entry null/orphan anomaly rows.

---

## 4. Locked implementation contract (exact)

### 4.1 Read-model shape and invariants

- `ReportingData` gains **one additive** field:
  `byTeam: Record<string, ReportingBucket>` keyed by `bucket_key`
  (reuses the existing `ReportingBucket = { key, display, recruitedCount }`).
- `byTeam` is computed in the read-model from the **same** scoped-fact array used
  for the rest of `ReportingData`. It is never computed on the client and never
  via a second RPC for the chart.
- **Invariant `I-1`:** `recruitedTotal === Σ byTeam[k].recruitedCount` over all
  buckets, **including** the `unknown` bucket (`byTeam["unknown"]`). The R6
  phrasing "total = sum(byTeam) plus the unknown bucket" is reconciled here: the
  unknown bucket **is** a member of `byTeam` keyed by the literal `unknown`, so
  the sum is over all buckets.
- **Invariant `I-2`:** `byTeam` display is the joined current
  `teams.display_name`; an inactive team's display carries the
  `" (Đã ngừng hoạt động)"` suffix; the `unknown` bucket's display is the fixed
  `"Không xác định"`.
- **Invariant `I-3`:** the unknown bucket is emitted only when its count > 0;
  otherwise `byTeam` has no `unknown` key and `I-1` still holds.
- **Invariant `I-4`:** a team's `bucket_key` is independent of `display_name`
  and of `active`; renaming/reactivating never changes it.
- The legacy aggregate contributes its `sum(recruited_count)` to the **unknown**
  bucket only; it is never re-attributed to a team.

### 4.2 Scoped fact payload extension (additive keys)

`direct_entry_reporting_scoped_facts` gains **three additive keys per fact**:
`team_id` (the row's stored `direct_entries.team_id`; the legacy branch emits
`null`), `team_code` (joined `teams.code` or `null`), `team_display_name`
(joined current `teams.display_name` or `null`). The existing 15 keys and the
fact ordering are unchanged. For the legacy branch all three new keys are `null`.

The `direct_entry_reporting_facts_v01` view gains the same three columns via a
`LEFT JOIN public.teams t ON t.team_id = e.team_id` in its Direct Entry branch
(legacy is a separate `UNION ALL` and needs no team columns). Existing columns
and their order stay unchanged; the three new columns are appended.

### 4.3 Drill-down RPC (locked name and signature)

```
public.direct_entry_reporting_team_drill_down(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bucket_key   text,
  p_filters      jsonb,
  p_cursor       text,
  p_limit        integer
) returns jsonb
```

- **No audience parameter.** The RPC re-resolves the audience internally via
  `direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id)`; if
  the resolved audience is not `all`, it returns the `REPORTING_QUERY_FAILED`
  error (no 404 leak, no empty list).
- Fact set = the shared authorized set (`direct_entry_reporting_authorized_entries`)
  intersected with the `bucket_key`→row mapping, with the same eligibility filter.
- `p_bucket_key` validated per §3 (wire check before any decode; unknown literal
  or namespace-A token; canonical re-encode; one-row lookup).
- `p_limit`: default 25, max 100, `0`/non-numeric/`>100` → `INVALID_FILTER`.
- `p_cursor`: opaque server-issued; undecodable → `INVALID_FILTER`; beyond the
  last row → empty page + `nextCursor: null` (no error).
- Sorting: `recruiter_display` asc → `business_date` desc → `entry_id` asc (the
  existing grain tie-breaker).

**Response envelope (locked):**

```json
{
  "bucket": { "key": "<echo of p_bucket_key>", "display": "<current label>" },
  "rows": [ { "business_date": "YYYY-MM-DD", "project_display": "...",
              "recruiter_display": "...", "provider_type_display": "...",
              "employment_type_display": "...", "recruited_count": 1,
              "first_work_date": "YYYY-MM-DD" } ],
  "nextCursor": "opaque | null",
  "total": 0,
  "applied": { "from": "...", "to": "...", "project": "...", "recruiter": "...",
               "provider": "...", "employment": "..." },
  "legacy_aggregate_total": { "recruited_count": 0, "from": "YYYY-MM-DD",
                              "to": "YYYY-MM-DD", "cutover_date": "2026-09-30" }
}
```

- `rows[]` carries **exactly** the seven sanitized fields — never
  `entry_id`, `submission_id`, `source_id`, `drive_file_id`, `file_name`,
  `recruiter_key`, `project_key`, `provider_type_key`, `employment_type_key`,
  `team_id`, `team_code`, `bucket_key`, `auth_subject`, `app_user_id`.
- `legacy_aggregate_total` is present (non-null) **only** for
  `p_bucket_key = "unknown"`; it is computed inside the same RPC (not a second
  call) and equals the legacy aggregate sum for the current filter window; the
  `rows` array for the unknown bucket is the Direct Entry null/orphan anomaly
  list alone (its `total` is the anomaly count alone).

### 4.4 Server boundary

- The BoD chart's `byTeam` rides on the **existing**
  `fetchCutoverReporting` result (no new call for the chart).
- The drill-down is a **new interactive endpoint**. Locked convention: a Next.js
  Route Handler under `src/app/api/**` (matching the existing `src/app/api/**/route.ts`
  pattern), guarded by the same session/actor resolution as `/dashboard`. The
  handler calls a new server function `fetchCutoverTeamDrillDown(params, actor)`
  (new sibling module under `src/lib/reporting/`, or in
  `p2-w04a-reporting-server.ts`), which:
  1. resolves the actor,
  2. calls the `direct_entry_reporting_team_drill_down` RPC,
  3. maps RPC errors to the locked taxonomy (§4.5),
  4. returns only the sanitized envelope.
  No API route exists today for reporting; this is additive and does not change
  `/dashboard`.
- **Reuse** `parseReportingFilters` for the query string; add `bucket_key`,
  `cursor`, `limit` parsing in the same module. The request body/query carries
  only `{ bucket_key, from, to, project, recruiter, provider, employment, cursor, limit }`.

### 4.5 Validation and error taxonomy (locked)

| Condition | Result |
|---|---|
| `dbKind !== "all"` (team/own/anonymous/failed actor) | `REPORTING_QUERY_FAILED` |
| `bucket_key` fails the wire/canonical/lookup checks | `INVALID_FILTER` |
| `limit` > 100, `= 0`, or non-numeric | `INVALID_FILTER` |
| `cursor` undecodable | `INVALID_FILTER` |
| `from > to`, bad date, bad provider/employment, bust UUID source | `INVALID_FILTER` |
| cursor beyond last row | `{ rows: [], nextCursor: null, total, applied, bucket }` (no error) |
| RPC/transport failure | `REPORTING_QUERY_FAILED` (sanitized; the raw DB code/message never reaches the client) |

`source` is **not exposed** to the drill-down (Direct Entry scoped).

### 4.6 Authoritative label source

Team labels resolve from `public.teams.display_name` (joined at query time, the
current value). No label is derived from the Admin Catalog API, from
`bucket_key`, or from client-side decoding. Labor-type/employment labels keep
using the W02C `direct_entry_reporting_employment_display()` lookup.

### 4.7 Security / ACL / search_path

- The new RPC and the extended view/RPC keep `SECURITY DEFINER` + fixed
  `search_path = pg_catalog, public`.
- The new RPC is `service_role` EXECUTE only (`public`/`anon`/`authenticated`
  revoked). The drill-down Route Handler uses the service-role client only after
  the page-level actor check, and the RPC re-derives the audience server-side.
- `bucket_key` is a routing key, **not** an authority token; it carries no
  capability/grant/audience/PII.
- No new dependency, no new package, no parallel RPC framework, no second
  aggregate dimension.

---

## 5. UX lock — Owner two-tab BoD (replaces R6 "add a card")

R6 described adding a card to the current dashboard. **R7 replaces that** with the
locked Owner contract:

1. For `audience.kind === "all"`, the BoD layout renders **two tabs**:
   - **Tab 1 "Báo cáo tổng quát" — DEFAULT.** Renders the **current** BoD
     dashboard unchanged (hero, KPIs, "Xu hướng tuyển dụng", "Phân bổ tuyển dụng"
     with all existing cards).
   - **Tab 2 "Báo cáo theo nhóm".** Renders: the by-team chart (donut or bar,
     chosen in T1A) over all buckets; the bucket list; and the drill-down for the
     selected bucket. Drill-down rows already carry both `recruiter_display` and
     `project_display`.
2. **No second aggregate dimension.** The team report is by team only. Do **not**
   build a parallel aggregate by project / provider / employment inside the team
   report.
3. `team` and `own` audiences go **straight** to the existing
   `TeamDashboardView` / `OwnDashboardView`; they never see the two BoD tabs and
   never see the team chart.
4. `TeamDashboardView` is **not** reused as the BoD cross-team report.
5. The drill-down panel opens from the chart bucket; the unknown bucket opens the
   two-section unknown panel (§3). Cursor paging via a "Tải thêm" button, disabled
   when `nextCursor` is null; no infinite scroll; the legacy total card is not
   paginated.
6. The UI never renders `bucket_key`; the user sees only `display` (with the
   inactive suffix where applicable).

---

## 6. Migration strategy (locked) — patch live definitions, never re-emit

W05B requires **exactly one** append-only migration on top of `0c1676e`. The
migration MUST patch the current live definitions; it must **not** copy/rebuild
the view or RPC bodies from the W04A/W05A original sources, because W02C (#79) and
its follow-ups already patched them in place.

Required mechanism (establishes as precedent by W02C, files
`20261011120000` §7b and `20261011130000`):

- For a view: read `pg_get_viewdef(p_view)`, require the exact expected source
  fragment to appear **exactly** the expected number of times
  (`(length(def) - length(replace(def, expected, ''))) / length(expected)`), then
  `execute 'create or replace view ' || <catalog-resolved qualified name> || ' as '
  || replace(def, expected, replacement)`. Abort the whole migration with
  `errcode = '55000'` on any drift.
- For a function: read `pg_get_functiondef(p_signature)`, apply the same exact
  expected-count guard, then `execute replace(def, expected, replacement)`
  (which preserves ownership, ACL and volatility).
- The helper used to do this must be created and **dropped within the same
  migration**, revoked from every role (exactly as W02C does at §7e).
- The migration must add a self-check (in-transaction `do $$ ... $$`) asserting
  the post-state: the three new view columns exist; the scoped-facts RPC body
  carries `team_id`/`team_code`/`team_display_name`; the new drill-down RPC exists
  with the locked signature, is `SECURITY DEFINER`, and is `service_role`-only;
  the W05A existing keys are unchanged; the W02C employment-display patch is still
  present (i.e. the facts view does not carry a `CASE e.labor_type` label map).

Non-breaking requirement: existing read-path behavior, existing keys, the view's
`service_role`-only ACL, and all earlier migrations (byte-identical) stay
unchanged. The migration adds **no** team dimension to
`direct_entry_reporting_dimension_options_v01` / `reporting_dimension_options_v01`
(preserving the W07A-R4 invariant that the options view emits no `team` row).

---

## 7. Reuse matrix (mandatory)

| Reuse from | What to reuse | Do NOT |
|---|---|---|
| `src/lib/reporting/p1-filter.ts` | `parseReportingFilters`, `INVALID_FILTER_CODE`, `PROVIDER_FILTER_VALUES`, `EMPLOYMENT_FILTER_VALUES` | introduce a second filter parser |
| `src/lib/reporting/p1-reporting.ts` | `ReportingFact`, `ReportingBucket`, `ReportingData`, `selectDisplay`, `groupByDimension` semantics, `reportingQueryFailed`, `REPORTING_QUERY_FAILED_CODE` | fork a parallel bucket type |
| `src/lib/reporting/p1-reporting-server.ts` | existing read-model grouping conventions | — |
| `src/lib/reporting/p2-w04a-reporting-server.ts` | `fetchCutoverReporting` shape (`CutoverFetchResult`), the `dbKind === "all"` gate block, `logSafeError` sanitization | add a second audience inference |
| `src/lib/reporting/p2-w04a-options-server.ts` | `fetchCutoverReportingOptions` pattern for the new drill-down server fn | — |
| `src/lib/reporting/p3-w05a-audience.ts` | `ReportingAudience`, `resolveReportingAudienceProjection` (reuse for the new RPC's audience null-check) | re-derive audience client-side |
| `src/lib/reporting/p3-w05a-source-filter.ts` | `validateAllSourceFilter` posture (reference only; `source` is not exposed to the drill-down) | expose `source` to the drill-down |
| `src/lib/reporting/p3-w06c-audience-view.ts` | `resolveDashboardMode`, `DashboardMode`, `ScopedDashboardView`, `buildMemberContributions` | reuse `TeamDashboardView` as the BoD cross-team report |
| `src/lib/reporting/p2-w04a-cutover.ts` | `P2_W04A_CUTOVER_DATE`, `P2_W04A_DIRECT_ENTRY_SOURCE_ID`, masking/combine helpers | re-implement masking |
| `src/lib/reporting/p1-dashboard.ts` / `p1-chart-data.ts` | `sortBuckets`, `topBuckets`, `buildDailyTrend`, `buildProjectDonutData`, `buildBarData`, `buildCategorySegments`, `stableColorForKey` | a new chart-data engine |
| `src/lib/reporting/p1-reporting-pagination.ts` | validation/error posture only | `paginateAll`-style full materialization of the drill-down |
| `src/components/dashboard/dashboard-view.tsx` | `DashboardView` / `DashboardBody` as **Tab 1**; add the tab shell around it | replace the existing BoD content |
| `src/components/dashboard/team-dashboard-view.tsx` / `own-dashboard-view.tsx` | keep as the `team`/`own` endpoints (untouched) | route them through the BoD tabs |
| `src/components/dashboard/dashboard-shared.tsx` | `FiltersOrError`, `NoMatchesBlock`, `ScopeNote`, `BucketList` | duplicate these |
| `src/components/dashboard/dashboard-filters.tsx` | `DashboardFilters` (with `showRecruiter`) | fork filter UI |
| `src/components/ui/card.tsx` (`Card`,`CardHeader`), `src/components/ui/alert.tsx` (`Alert`), `src/components/reporting/empty-state.tsx` (`EmptyState`), `src/components/reporting/error-state.tsx` (`ErrorState`), `src/components/dashboard/kpi-card.tsx` (`KpiCard`), charts `project-donut.tsx` (`ProjectDonut`), `provider-donut.tsx` (`ProviderDonut`), `recruiter-bar-chart.tsx` (`RecruiterBarChart`), `trend-chart.tsx` (`TrendChart`), `employment-composition.tsx` (`EmploymentComposition`), `project-provider-mix.tsx` (`ProjectProviderMixCard`) | all visual primitives and charts | any new visual primitive |
| `src/app/dashboard/page.tsx` | the actor/`decideSessionPageAccess` gate pattern for the new Route Handler | widen `/dashboard`'s fetch contract |

**No client-side team join. No `paginateAll` to materialize the whole drill-down.
No Admin Catalog call to build labels.**

---

## 8. Acceptance matrix (27 — E1–E22 carried from R6, E23–E27 new in R7)

| ID | Acceptance |
|---|---|
| E1 | BoD by-team happy path: each bucket's count = Σ `recruited_count` of matching facts; invariant `I-1` holds (`recruitedTotal === Σ byTeam`). |
| E2 | Historical attribution: a fact stored with `team_id=T1` whose recruiter later moved to `T2` is bucketed under `T1`; `bucket_key = team.<base64url(T1.code)>`. |
| E3 | Unknown bucket = legacy aggregate + Direct Entry null/orphan; emitted only when > 0. |
| E4 | Drill-down happy path: page 1 with `limit=25`, `nextCursor` chains, last page `nextCursor=null`, `total` = the bucket's per-team total. |
| E5 | Drill-down re-derives audience; a `team`/`own` caller → `REPORTING_QUERY_FAILED`. |
| E6 | Drill-down row shape is exactly the seven fields; any added field fails. |
| E7 | `limit=101`, `limit=0`, non-numeric `limit`, undecodable `cursor` → `INVALID_FILTER`. |
| E8 | Drill-down filter parity: `from > to` etc. → `INVALID_FILTER`. |
| E9 | The team chart card renders only inside the BoD `all` branch. |
| E10 | Removing the audience re-check fails closed in both directions. |
| E11 | `bucket_key` is namespaced/opaque/stable across a `display_name` rename. |
| E12 | Inactive team stays in its own bucket with the suffix; total still reconciles. |
| E13 | Orphan/`null` `team_id` → unknown; appears in Section B, not Section A. |
| E14 | Section A is non-paginated, no entry-level rows, no internal identifiers. |
| E15 | Exactly one append-only migration after `0c1676e`; earlier migrations byte-identical. |
| E16 | Chart `bucket_key` is the namespaced token, never the raw `teams.code`. |
| E17 | A team with `code="__unknown__"` produces its own known-team bucket. |
| E18 | A team with `code="unknown"` produces its own known-team bucket. |
| E19 | The unknown bucket uses the bare `unknown` literal; `__unknown__` is rejected. |
| E20 | A canonical 128-char 4-byte-UTF-8 `teams.code` → exactly a 688-char token; 689/693 reject. |
| E21 | Canonical-form re-encode rejects non-canonical base64url aliases; lookup-miss branch fails closed. |
| E22 | The reserved `__system_vendor__` literal is accepted as a known-team token on the read path (Vendor bucket + drill-down; Unknown unchanged). |
| **E23 (new)** | BoD `all` renders exactly two tabs; Tab 1 is the unchanged current dashboard (default); Tab 2 renders chart + bucket list + drill-down, whose rows carry both `recruiter_display` and `project_display`. |
| **E24 (new)** | `team`/`own` audiences never see the two BoD tabs or the team chart; they render `TeamDashboardView`/`OwnDashboardView` directly. |
| **E25 (new)** | No second aggregate dimension is built for the team report (no project/provider/employment re-bucketing inside Tab 2). |
| **E26 (new)** | The migration patches live definitions (`pg_get_viewdef`/`pg_get_functiondef`) with exact expected replacement counts and aborts on drift; it does not re-emit the W04A/W05A bodies (the W02C employment-display patch survives). |
| **E27 (new)** | `direct_entry_reporting_dimension_options_v01` still emits no `team` dimension (W07A-R4 invariant preserved). |

## 9. Mutation matrix (32 — M1–M29 carried from R6, M30–M32 new in R7)

The R6 mutation set (M1–M29) is retained unchanged, including the M29
drill-down-validation-only rule. New in R7:

| Mutation | Failing test(s) |
|---|---|
| **M30** Re-emit the facts view / scoped-facts RPC from the original W04A/W05A source (dropping the W02C `direct_entry_reporting_employment_display` patch) | E26 |
| **M31** Build a second aggregate dimension (by project/provider/employment) inside the team report | E25 |
| **M32** Render the two BoD tabs (or the team chart) for a `team`/`own` audience | E24 |

Plus the R6 mutation set covers: dropping team keys (E1/E2/E11); membership join
(E2); skipping unknown (E3/E13); leaking ids into the drill-down row (E6);
removing the audience re-check (E5/E10); capping limit at 200 (E7); extra filter
keys (E8); rendering the chart for `team` (E9/E10); dropping legacy from unknown
(E3/E14); client-side bucketing (E1); using `display_name`/raw code as
`bucket_key` (E11/E16/E17/E18); reverting the unknown literal (E17/E18/E19);
loosening the lookup/canonical checks (E16/E20/E21); rejecting `__system_vendor__`
on the read path (E22); lower bound 256 (E20); inactive→unknown (E12); legacy as
entry-level rows (E14); missing Section A (E3/E14); a second migration (E15).

---

## 10. T1B / T1A split and dependency graph

**T1B (backend / SQL) — first:**

1. One append-only migration (§6): patch the facts view (+3 columns via LEFT JOIN
   `teams`), patch the scoped-facts RPC (+3 additive keys), create
   `direct_entry_reporting_team_drill_down`, keep ACL/`search_path` posture, drop
   the patch helper within the migration, self-check.
2. Read-model: compute `byTeam` (reuse `groupByDimension` semantics) in
   `p1-reporting.ts`; extend `ReportingData` additively; pin `I-1`..`I-4`.
3. Server: `fetchCutoverTeamDrillDown(params, actor)` + the Route Handler
   (`bucket_key`/`cursor`/`limit` validation; error taxonomy §4.5).
4. Tests: `p3-w05b-by-team.test.mjs`, `p3-w05b-team-drill-down.test.mjs`,
   extend `p3-w05a-page.test.mjs` ("no client-side team join", "byTeam computed in
   the read-model"), and a migration test asserting E15/E26.

**T1A (UI) — after T1B lands:**

1. Tab shell in `DashboardView` for `mode.kind === "all"` (Tab 1 = current
   `DashboardBody`; default Tab 1).
2. Tab 2: team chart (`ProjectDonut`/`RecruiterBarChart` family) + `BucketList`
   + drill-down panel (paged, sanitized rows) + the two-section unknown panel.
3. No new visual primitive; reuse §7 primitives.

**Dependency graph / integration order:**
`migration (T1B)` → `read-model byTeam (T1B)` → `drill-down RPC + server fn +
Route Handler (T1B)` → `T1B tests green` **→** `tab shell + Tab 2 UI (T1A)` →
`T1A tests green` → `release regression` → `Owner UAT` → `deploy VPS`.
W05B-A (backend) must not depend on W06D; W06D consumes the W05B-A contract.

---

## 11. Migration slot — observation only

- Ledger on `0c1676e` = **84** migrations; last = #84; **next available = #85**.
- This is an **observation, not a reservation**. R7 reserves **no** slot; T0
  allocates the W05B slot when the implementation task is scheduled.
- **W03B is parked outside `main`; no migration slot is reserved for W03B** and
  W03B is not part of this base.

---

## 12. Risk register (R7 additions on top of R6)

- **R13 — re-emission reverts the W02C patch.** A developer copies the facts view
  or scoped-facts RPC body from W04A/W05A and silently drops
  `direct_entry_reporting_employment_display`. Mitigation: §6 patch-in-place +
  E26 / M30.
- **R14 — a second BoD aggregate dimension.** A developer builds a
  project/provider/employment re-bucketing inside Tab 2. Mitigation: §5.2 +
  E25 / M31.
- **R15 — the BoD tabs leak to `team`/`own`.** Mitigation: §5.3 + E24 / M32.
- R6's R1–R12 (recruiter's current team used; legacy mis-attributed; drill-down
  PII leak; audience bypass; unbounded drill-down; `bucket_key` instability /
  collision / non-canonical alias; inactive misclassified; legacy as entry-level
  rows; migration-slot collision; read-model N+1; `team` reaching the BoD chart;
  loose `bucket_key` validation) carry over unchanged.

---

## 13. Boundary (what this memo does NOT do)

- No source, migration, API, route, UI, dependency, contract-doc,
  `package.json`, `pnpm-lock.yaml` or `tsconfig.json` change. No `pnpm install`.
- No edit to the R6 memo
  (`docs/handoffs/p3-w05b-s0-bod-team-reporting-survey.md`) or its branch.
- No Production query, no apply, no deploy, no browser, no CUA, no screenshot,
  no UAT, no merge to `main`.
- No migration number reserved; no W03B slot; no stub/placeholder.
- The T1B/T1A split and the acceptance/mutation matrices are locked here for T0
  approval; implementation does not start until T0 accepts this contract.

---

## 14. Review pass

This memo is
`P3_W05B_S0_R7_CURRENT_MAIN_REBASELINE_PASS_AWAITING_T0_REVIEW`.
It re-grounds R6 on `origin/main@0c1676e` (84 migrations). T0's review should
check: the factual truth (§1), the delta table (§2), the preserved decisions (§3),
the exact implementation contract (§4), the Owner two-tab UX lock (§5), the
patch-in-place migration strategy (§6), the reuse matrix (§7), the acceptance /
mutation matrices (§8 / §9 — 27 / 32), the T1B/T1A split and dependency graph
(§10) and the migration-slot observation (§11).
