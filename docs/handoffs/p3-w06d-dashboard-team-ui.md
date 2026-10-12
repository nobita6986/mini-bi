# P3-W06D — Dashboard BoD team reporting UI handoff

## Status

`P3_W06D_DASHBOARD_TEAM_UI_LOCAL_PASS_AWAITING_T0_REVIEW`

## Base / branch

- Repo: `C:\CodeApp\BI`
- Worktree: `C:\CodeApp\BI-p3-w06d-dashboard-team-ui`
- Branch: `feature/p3-w06d-dashboard-team-ui`
- Base: `origin/main@48bb83b2572ff241a9acecd2db54e53a5d245a55`
- Backend dependency consumed from base: W05B-A `ReportingData.byTeam` and `GET /api/reporting/team-drill-down`.
- No backend/API/RPC/schema/migration/dependency changes.

## What changed

### BoD two-tab UI

- `src/components/dashboard/dashboard-view.tsx`
  - Keeps DB-authoritative `error`/`team`/`own` dispatch unchanged.
  - Only the `all` branch reaches `BodDashboardTabs`.
  - Existing BoD hero, KPIs, filters, trend, project/provider/employment/recruiter cards remain Tab 1 content.

- `src/components/dashboard/bod-dashboard-tabs.tsx`
  - Client tab shell with exact `tab=general|team` contract.
  - Missing/invalid tab normalizes to `general`.
  - Tab changes use nuqs history `push`, `shallow:false`, `scroll:false`.
  - `role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls`, linked IDs, roving `tabIndex`, ArrowLeft/ArrowRight/Home/End.
  - Keeps existing `source` on general tab; removes it when entering team tab.

- `src/app/dashboard/page.tsx`
  - Direct `tab=team&source=...` normalization happens before reporting fetch.
  - Removes `source`, preserves `from/to/project/recruiter/provider/employment`, redirects to the normalized team URL, then performs the authoritative server reload.
  - Does not modify `parseReportingFilters` or `ReportingFilters`.

### Team report

- `src/components/dashboard/team-reporting-panel.tsx`
  - Consumes server-provided `data.byTeam`; no client regrouping, team join, membership join or Admin Catalog call.
  - Uses server `display` and `recruitedCount`; never renders/decodes/logs `bucket_key` or internal IDs.
  - Accessible native bucket buttons with `aria-pressed`.
  - Calls only `GET /api/reporting/team-drill-down` after explicit bucket selection.
  - Sends allowed filters, opaque bucket key/cursor and `limit=25`; never sends `source`.
  - Exact seven sanitized row fields only.
  - Unknown split:
    - `Tổng hợp từ dữ liệu cũ (tổng hợp theo ngày, không phải entry-level)`.
    - `Anomaly Direct Entry (không gán được team)`.
  - Handles loading, unavailable/error, retry, empty aggregate, empty detail, selected bucket, loading-more and end-of-results.
  - Uses abort/request generation guards; resets detail on bucket/filter changes; no optimistic append, infinite scroll or auto-fetch.
  - Remounts the detail state on authoritative filter signature changes, avoiding stale rows and synchronous effect resets.

- `src/components/dashboard/team-bucket-chart.tsx`
  - Small team-specific horizontal-bar sibling.
  - Reuses stable theme color slots; `RecruiterBarChart` remains unchanged/non-generic.
  - Responsive one-column layout with bounded inner detail-table overflow only.

### Admin label copy

- `src/lib/admin/admin-navigation.ts`
  - `Nhân sự` → `Nhân sự tuyển dụng`.
  - `Tài khoản` → `Tài khoản truy cập`.
  - Routes, predicates, page gates and behavior unchanged.

## Tests

- `src/components/dashboard/team-reporting-ui.test.mjs`
  - Audience all/team/own dispatch.
  - Tab default/history/ARIA/keyboard contract.
  - Source normalization and filter preservation contract.
  - `byTeam` consumption without client regrouping.
  - No internal ID rendering.
  - Drill-down route/filter/cursor/row allowlist.
  - Unknown split, retry, reset, load-more/end states.
  - Mobile overflow contract.
  - Approved Admin labels and lane registration.

- `src/lib/admin/admin-navigation.test.mjs`
  - Pins `Nhân sự tuyển dụng` and `Tài khoản truy cập` labels.

- `src/components/admin/account-manager.test.mjs`
  - Pins `Tài khoản truy cập` label in the existing W05-A source contract.

- `package.json`
  - Adds `test:p3-w06d` exactly once to the canonical `test` chain.

## Verification

### Focused and regression lanes

- Focused W06D lane: `pnpm test:p3-w06d` — 9/9 PASS.
- W05B-A: `pnpm test:p3-w05b-a-team-reporting` — 13/13 PASS.
- W05A: `pnpm test:p3-w05a` — 46/46 PASS.
- W06C: `pnpm test:p3-w06c` — 22/22 PASS.
- W05-A account lane: PASS.
- Admin direct catalog navigation lane: 98/98 PASS.
- `next typegen`: PASS.
- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS, 0 errors and 13 pre-existing warnings outside this change.
- `pnpm build`: PASS; `/dashboard` and `/api/reporting/team-drill-down` generated.
- `pnpm docs:check`: PASS, 6/6.
- `pnpm secrets:check`: PASS, no secrets found.
- `pnpm db:migrate -- --offline`: PASS, 85 migrations validated, no database access.
- `git diff --check`: PASS.

### Mutation probes

Each mutation was made red, then restored byte-identically and returned green:

1. Removed the `all` audience guard before the BoD tab shell → focused lane RED.
2. Preserved `source` when entering the team tab → focused lane RED.
3. Rendered `bucket.key` in the team chart → focused lane RED.
4. Removed filter-signature remount/reset behavior → focused lane RED.
5. Removed `aria-controls` from the tab contract → focused lane RED.

All restored source hashes matched the pre-probe hashes; focused lane returned to 9/9.

### Canonical test

Canonical `pnpm test` reached `test:p3-w06d` and the remaining chain. It recorded one known pre-existing `G4-I` failure in `test:main`:

- Base `48bb83b`, with frozen offline dependencies installed, reproduces the same `G4-I` failure.
- Base `test:main`: 447 tests, 446 pass, 1 fail; `G4-I2` passes.
- No G4-I code was modified.
- All lanes after `test:main` were run as compensating coverage and completed through the final W05-A lane, including W06D and Admin regressions green.

## Scope boundaries

- No migration, RPC, API, schema, backend, dependency or shared parser changes.
- No client-side authority inference, team/membership join, Admin Catalog call or source-filtered stale aggregate rendering.
- No Production query/apply, deploy, merge main or browser/UAT.
- Browser UAT was intentionally not run per task boundary; UI behavior is covered by focused source-contract tests and production build.

## Review target

T0 should review the two-tab flow, direct `tab=team&source=...` normalization, bucket/detail accessibility, Unknown split, Admin label copy, and the known canonical G4-I exception.
