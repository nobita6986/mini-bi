# P3-W06C — BoD / Team / Own dashboard UX (Handoff)

**Status:** `P3-W06C_BOD_TEAM_OWN_DASHBOARD_UX_LOCAL_PASS_AWAITING_T0_REVIEW`
**Base:** `origin/feature/p3-w05a-actor-scoped-reporting-team-scope@869397a788564fdcae95a8df9a5e968d4cb4c729`
**Branch:** `feature/p3-w06c-bod-team-own-dashboard` (commits on top of W05A; no amend/rebase)

## What changed

Audience-aware dashboard UX over the W05A DB-authoritative scoped payload. No backend,
migration, auth, grant, schema or Production change. No new dependency.

| Area | Change |
|---|---|
| `src/lib/reporting/p3-w06c-audience-view.ts` (new) | Pure audience→view contract: `resolveDashboardAudience`, `resolveDashboardAudienceKind`, `resolveScopedDashboardView`, `buildMemberContributions`. Missing/unknown audience fails closed to `own`. |
| `src/components/dashboard/dashboard-view.tsx` | Dispatches on the DB audience. The BoD layout renders only for a DB-confirmed `all`; `team`/`own` render their own views; a failed read renders a scope-neutral error shell. |
| `src/components/dashboard/team-dashboard-view.tsx` (new) | Team UX: scope banner, team KPIs (total / members / average per member), member contribution roster with share bars, team trend, team project/provider/employment breakdown. |
| `src/components/dashboard/own-dashboard-view.tsx` (new) | Personal UX: personal summary, personal trend, own project breakdown, employment mix. No roster, no recruiter filter. |
| `src/components/dashboard/dashboard-shared.tsx` (new) | Shared `FiltersOrError`, `NoMatchesBlock`, `ScopeNote`, `BucketList`; contains no audience decision. |
| `src/components/dashboard/dashboard-filters.tsx` | Optional `showRecruiter` so `own` hides the single-person recruiter filter. |
| `src/app/dashboard/page.tsx` | Passes `audience={report.ok ? report.audience : null}` taken from the scoped payload. |

Reused: existing scoped reporting closures, `Card`/`KpiCard`/`EmptyState`/`ErrorState`/`Alert`,
Recharts components, `p1-chart-data`, `p1-dashboard`, `DashboardFilters` and design tokens.
There is no parallel fetch, no service-role read and no fetch-everything-then-filter-in-client path.

## Gates

| Gate | Result |
|---|---|
| `pnpm test:p3-w06c` (new) | 14 pass |
| Affected dashboard/reporting tests | 73 pass (dashboard-brand, dashboard-source-status-cleanup, dashboard/layout, p1-dashboard, p1-chart-data, resolve-nav-actor, pilot-removal) |
| react-server affected | 36 pass (w04a-panel-api, p3-w08a-session-revocation-cache, session-page-access) |
| `next typegen` / `pnpm typecheck` | pass / clean |
| `pnpm lint` | 0 errors (8 pre-existing warnings) |
| `pnpm build` | pass |
| `git diff --check` | clean |

## Acceptance evidence

- `all`: BoD layout renders only after the `audienceKind !== "all"` gate; team/own never reach it.
- `team`: team-scoped aggregate and filter options; distinct member-roster UX; no global source metadata.
- `own`: personal aggregate and options; no roster, no recruiter filter; no global source metadata.
- Fail closed: null/unknown audience resolves to `own`; a failed read renders a neutral error with no scope claim.
- Scoped views receive props only (no fetch/RPC/service-role read) and never render `drive_file_id`,
  `file_name`, latest sync status or source presence.

## Deferred / notes

- Route `loading.tsx` stays a neutral skeleton: the audience is only known after the scoped read,
  so it cannot be audience-specific without a client-side guess.
- The error shell is shared and scope-neutral; team/own empty copy is audience-specific.
- No Owner UI UAT, no Production access, no migration apply; Release A migration ordering stays T0's.
