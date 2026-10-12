# P3-W06D-R3 — BoD team report requires an explicit team selection

## Status

`P3_W06D_R3_TEAM_REPORT_SELECTION_GATE_LOCAL_PASS_AWAITING_T0_REVIEW`

The BoD team tab no longer renders company-wide figures when no team is
selected: it shows only the filters, the team picker and a neutral prompt until
a team is chosen. The Team Leader report is unchanged.

## Base / branch / worktree

- Repo: `C:\CodeApp\BI`
- Worktree: `C:\CodeApp\BI-p3-w06d-r3-team-report-selection-gate`
- Branch: `feature/p3-w06d-r3-team-report-selection-gate`
- Base: `origin/main@30d9864` (`merge: sync W06D team report with current main`),
  fetched and confirmed before starting.
- Commits: `5af03f8` (gate + regressions) plus this handoff commit.
- No migration/API/RPC/schema/client-aggregation change; UI + state only.
- Primary checkout untouched.

## 1. Problem

`/dashboard?tab=team` (BoD, audience `all`) rendered the team picker plus the
audience-scoped KPI / member contribution / trend / project / employment /
detail sections while no team was chosen, so company-wide numbers read as if
they were a team report.

## 2. Change

- `src/components/dashboard/team-report-view.tsx`
  - `TeamReportViewConfig` gains `requireTeamSelection: boolean`.
  - The no-selection render is now:
    `selectedBucket !== null ? <TeamReportSelection/> : view.requireTeamSelection ? <prompt/> : <TeamReportBody data={data}/>`.
    A required-selection view therefore shows ONLY the filters + picker + prompt
    — no KPI, member contribution, trend, project/employment or detail.
  - The single-bucket auto-select applies only when the view does NOT require a
    selection (`!view.requireTeamSelection && buckets.length === 1`), so BoD
    never renders a body without an explicit pick.
  - The selection stays signature-keyed on the DB-applied filters, so a filter
    change clears it and `<TeamReportSelection>` (and its fetch) unmounts
    immediately — no company-wide or stale team figures flash while loading.
- `src/components/dashboard/bod-dashboard-tabs.tsx`: `requireTeamSelection: true`,
  and the scope note now reads "Chọn một nhóm để xem báo cáo chi tiết của nhóm đó."
- `src/components/dashboard/team-dashboard-view.tsx`:
  `requireTeamSelection: false` (Team Leader behaviour unchanged).
- No endpoint, server authorization, request shape, or CCCD/Vendor/Unknown code
  was touched.

## 3. Regressions added (`team-reporting-ui.test.mjs`)

1. BoD with no selection: picker < selection < required gate < prompt <
   fallback body; the only team-report `fetch` sits inside
   `TeamReportSelection`, which is rendered only when a bucket is selected — so
   no request is issued without a pick; a required view never auto-selects a
   single bucket.
2. Selecting a team renders `<TeamReportBody data={report} .../>` from
   `payload.report` (that team), never the audience `data`.
3. A filter change resets the selection; the loading state replaces the body.
4. The Team Leader keeps `requireTeamSelection: false`.
5. The CCCD tab / `DuplicateCccdReportPanel` wiring is unchanged.

## 4. Gates

- `pnpm test:p3-w06d` — **28/28 PASS**.
- W06C — 22/22; W05B-A — 13/13; CCCD report UI lane — 18/18 + 7/7.
- `next typegen` PASS; `pnpm typecheck` PASS.
- `pnpm lint` — 0 errors, 13 pre-existing warnings.
- `pnpm build` PASS (`/dashboard`, `/api/reporting/team-report`,
  `/api/reporting/team-drill-down`, `/api/direct-entry/duplicate-cccd-report`).
- `pnpm docs:check` PASS; `pnpm secrets:check` PASS (0 secrets, 1962 files);
  offline migration validation 85 migrations VALID (no DB access);
  `git diff --check` PASS.
- Full canonical `pnpm test` NOT run (task scope). Known pre-existing blocker:
  the `G4-I` failure in `test:main` recorded by earlier W06D handoffs is on the
  base and unrelated to this change.
- No Production access, deploy or browser/UAT.

## 5. Mutation probes

Each mutation made the focused lane RED; each file was restored byte-identically
(hash match) and the lane returned GREEN 28/28.

1. Remove the `view.requireTeamSelection` gate (`: false ?`) → RED.
2. `requireTeamSelection: true` → `false` on the BoD config → RED.
3. `requireTeamSelection: false` → `true` on the Team Leader config → RED.
4. Allow the single-bucket auto-select even when required → RED.
5. Drop the filter signature from the selection → RED.

## 6. Review target

T0 should confirm: BoD shows no report body (and issues no team-report request)
until a team is picked; a picked team renders only that team's report; a filter
change hides the body until re-picking; the Team Leader report is unchanged; and
no migration/API/RPC/schema or CCCD/Vendor/Unknown behaviour changed.
