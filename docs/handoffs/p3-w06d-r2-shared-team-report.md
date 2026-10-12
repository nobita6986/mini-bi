# P3-W06D-R2 — Shared team report for Team Leader and BoD

## Status

`P3_W06D_R2_SHARED_TEAM_REPORT_LOCAL_PASS_BOD_PER_TEAM_BLOCKED_AWAITING_T0_REVIEW`

The Team Leader report and the BoD "Báo cáo chi tiết nhóm" now render **one**
report implementation. The BoD tab is wired to that shared component, but a
per-selected-team view of it is **not** deliverable on the current backend
(§5), so this lane is **not** reported as fully complete.

## Base / branch / worktree

- Repo: `C:\CodeApp\BI`
- Worktree: `C:\CodeApp\BI-p3-w06d-r2-shared-team-report`
- Branch: `feature/p3-w06d-r2-shared-team-report`
- Base: `origin/main@2a235b038cbd3ae845de0a935c052f7956ae4aa0`
- Implementation commit: `701cabd`
- No backend/API/RPC/schema/migration/dependency change.
- Primary checkout (and its uncommitted metadata-title edits) untouched.

## 1. What was asked (review)

- Team Leader report: remove the "Theo HRP/Vendor của nhóm" card; move the
  per-row detail list to the END of the report.
- BoD detailed team report: use the SAME component and the same
  summary/member-contribution sections; (hide/not-load the detail list —
  deferred by the reviewer).
- One implementation, not two. Keep server-side scope; do not bypass the
  drill-down RPC audience gate.

Reviewer decisions used: the "danh sách chi tiết từng dòng" is the **existing
entry-level drill-down table**; the shared base is **extracted from
`TeamDashboardView`**.

## 2. The real Team Leader surface

`src/components/dashboard/team-dashboard-view.tsx` (DB audience `team`,
eyebrow `Trưởng nhóm · Báo cáo nhóm`) is the only report with the
"Theo HRP/Vendor của nhóm" card, so it is the donor report. The BoD team tab
(`src/components/dashboard/bod-dashboard-tabs.tsx`, `tab=team`) is the
recipient.

## 3. Change summary

- **New** `src/components/dashboard/team-report-view.tsx` — the single shared
  report body: header/KPIs, scope note, filters, member contribution, trend,
  project + employment breakdowns, optional project/provider mix, and the
  entry-level detail at the END. Renders only the scoped `ReportingData` it is
  handed; uses `sortBuckets(data.byTeam)`; no client team/membership join, no
  Admin Catalog, no `.rpc(`, no reporting re-fetch.
- **New** `src/components/dashboard/team-entry-detail.tsx` — the shared
  entry-level drill-down (team picker + sanitized 7-field table, opaque cursor +
  `Tải thêm`, Unknown split, loading/error/retry/empty, reset on bucket/filter
  change). Renamed from the old BoD-only `team-reporting-panel.tsx`; the picker
  buckets are now a prop so both audiences reuse it unchanged. Only calls
  `GET /api/reporting/team-drill-down`; never sends `source`; no infinite
  scroll, no N+1, no figure derivation from the paginated rows.
- **Modified** `src/components/dashboard/team-dashboard-view.tsx` — now a thin
  adapter mapping `ScopedDashboardView` → `TeamReportViewConfig` and rendering
  `<TeamReportView>`.
- **Modified** `src/components/dashboard/bod-dashboard-tabs.tsx` — the team tab
  renders `<TeamReportView view={bodTeamReportConfig}>` (the SAME component) and
  receives `generatedAt`. Tab label `Báo cáo theo nhóm` is unchanged.
- **Modified** `src/components/dashboard/dashboard-view.tsx` — passes
  `generatedAt` into `BodDashboardTabs`.
- **Deleted** `src/components/dashboard/team-reporting-panel.tsx`.
- **Tests** `team-reporting-ui.test.mjs` (updated + new R2 cases) and
  `p3-w06c-dashboard-audience.test.mjs` (roster assertion now reads the shared
  body).

## 4. Shared report contract

- Both audiences render `TeamReportView`. Section order:
  header → scope note → filters → **member contribution** → trend → project →
  employment → [project/provider mix] → **entry-level detail (LAST)**.
- Removed: the "Theo HRP/Vendor của nhóm" card (`ProviderDonut` is no longer
  imported by the shared report).
- The per-row detail list is the last section, rendered by the shared
  `TeamEntryDetail`.
- Team Leader scope stays DB-authoritative: the adapter receives only the W05A
  scoped `data`/`view`/`optionsResult`; no client authority.

## 5. Backend-contract gap (T1B) — BoD / detail NOT fully wired

Two gaps remain because authority stays server-side and the RPC audience gate is
not bypassed.

**B1 — BoD per-selected-team aggregate/member contribution (primary block).**
The shared report for the BoD audience can only render the `all`-scoped payload
from `fetchCutoverReporting` (company-wide). There is no server contract that
returns the aggregate/member contribution for **one selected team** to the BoD
audience:
- `ReportingData.byTeam` exposes per-team totals only (`key`/`display`/
  `recruitedCount`) — no per-team recruiter/project/employment breakdown.
- The drill-down RPC returns entry rows, not aggregates; deriving figures from
  the paginated rows is forbidden.
- `parseReportingFilters` has no `team` filter, so a team selection cannot
  re-scope the server read.

⇒ The BoD team tab currently renders the shared report over the company-wide
aggregate. Rendering it for a BoD-selected team needs a T1B projection — an
authoritative per-team `ReportingData` (or a locked `team` filter in the
reporting read).

**B2 — entry-level detail for the Team Leader (audience `team`).**
`public.direct_entry_reporting_team_drill_down` re-resolves the audience and
raises `42501` for any non-`all` audience (migration #85). The Team Leader's
trailing detail section therefore renders but its request is denied, surfacing
the sanitized "Bạn không có quyền xem báo cáo theo nhóm." message. The client
does hold the team's `bucket_key` via `data.byTeam`; the block is purely the
audience gate. To let the Team Leader load its own team's row list, T1B must
allow the `team` audience to drill into teams within its granted scope (or
provide an equivalent team-scoped detail read).

**Deferred (per review):** hiding / not-loading the BoD detail table is
explicitly postponed to a follow-up. Both sides currently render the shared
detail section; the follow-up only needs a config flag + a "no request issued"
test.

## 6. Verification

- Focused W06D lane `pnpm test:p3-w06d` — 16/16 PASS.
- W06C `pnpm test:p3-w06c` — 22/22 PASS.
- W05B-A `pnpm test:p3-w05b-a-team-reporting` — 13/13 PASS.
- W05A `pnpm test:p3-w05a` — 46/46 PASS.
- Admin direct-catalog navigation — 98/98 PASS.
- W05-A existing-account — 29/29 PASS.
- `next typegen` PASS; `pnpm typecheck` PASS.
- `pnpm lint` — 0 errors, 13 pre-existing warnings (outside this change).
- `pnpm build` PASS (`/dashboard` + `/api/reporting/team-drill-down` generated).
- `pnpm docs:check` PASS 6/6; `pnpm secrets:check` PASS (0 secrets, 1931 files).
- `git diff --check` PASS.
- Not run (task boundary): DB apply/query, deploy, browser/UAT, merge to main,
  push.

## 7. Mutation probes

Each mutation made the focused lane RED; each file was restored byte-identically
(hash match) and the lane returned GREEN 16/16.

1. BoD tab import `./team-report-view` → `./team-reporting-panel`
   (BoD no longer shares) → RED.
2. Drill-down adds `params.set("source", ...)` → RED.
3. `sortBuckets(data.byTeam)` → `Object.values(data.byTeam)` (client regroup) →
   RED.
4. Remove `key={querySignature}` remount (no reset on filter change) → RED.

## 8. Scope boundaries

- No migration/RPC/API/schema/backend/dependency/package change.
- No client-side authority inference, team/membership join, Admin Catalog call,
  or figure derivation from the paginated drill-down.
- The drill-down RPC audience gate is unchanged.
- No Production query/apply, deploy, browser/UAT, merge to main, or push.

## 9. Review target

T0 should confirm: the shared component and section order are correct; the
HRP/Vendor card is gone; the entry-level detail is last; and accept that the
BoD per-selected-team report (B1) and the Team Leader's own-team detail (B2)
remain blocked pending the T1B projection, plus the deferred BoD detail hide.
