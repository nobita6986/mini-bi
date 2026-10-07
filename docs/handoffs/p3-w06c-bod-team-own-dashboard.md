# P3-W06C — BoD / Team / Own dashboard UX (Handoff)

**Status:** `P3-W06C_BOD_TEAM_OWN_DASHBOARD_UX_LOCAL_PASS_AWAITING_T0_REVIEW`
**Base:** `origin/feature/p3-w05a-actor-scoped-reporting-team-scope@869397a788564fdcae95a8df9a5e968d4cb4c729`
**Branch:** `feature/p3-w06c-bod-team-own-dashboard` (commits on top of W05A; no amend/rebase)

## What changed

Audience-aware dashboard UX over the W05A DB-authoritative scoped payload, plus the two
T0-review corrections. No migration, auth, grant, schema or Production change; no new dependency.

| Area | Change |
|---|---|
| `src/lib/reporting/p3-w06c-audience-view.ts` (new) | Pure audience→view contract: `resolveDashboardAudienceKind` (null when unresolved), `resolveDashboardMode` (`error`\|`all`\|`team`\|`own`), `resolveScopedDashboardView`, `buildMemberContributions`. |
| `src/lib/reporting/p2-w04a-reporting-server.ts` | **Review fix 1**: a successful RPC payload without a usable audience now returns the sanitized `REPORTING_QUERY_FAILED` error instead of `ok: true` + facts; the success type carries a non-null `ReportingAudience`. **Review fix 2**: the team label is made inclusive from the DB-reported team count before it reaches the UI. |
| `src/lib/reporting/p3-w05a-audience.ts` | Adds `audienceTeamScopeCount` (count only, no team UUID leaves the module) and `resolveAudienceScopeLabel` (`"<first> và N nhóm khác"` when several teams are in scope). |
| `src/components/dashboard/dashboard-view.tsx` | Dispatches on `resolveDashboardMode`. BoD renders only for a DB-confirmed `all`; `team`/`own` render their own views; the `error` mode renders a neutral scope-free error and returns before any fact section. |
| `src/components/dashboard/team-dashboard-view.tsx` (new) | Team UX: scope banner, team KPIs (total / members / average), member contribution roster with share bars, team trend, team project/provider/employment. |
| `src/components/dashboard/own-dashboard-view.tsx` (new) | Personal UX: personal summary, trend, own project breakdown, employment. No roster, no recruiter filter. |
| `src/components/dashboard/dashboard-shared.tsx` (new) | Shared `FiltersOrError`, `NoMatchesBlock`, `ScopeNote`, `BucketList`; no audience decision. |
| `src/components/dashboard/dashboard-filters.tsx` | Optional `showRecruiter` so `own` hides the single-person filter. |
| `src/app/dashboard/page.tsx` | Passes `audience={report.ok ? report.audience : null}` from the scoped payload. |

Reused: existing scoped reporting closures, `Card`/`KpiCard`/`EmptyState`/`ErrorState`/`Alert`,
Recharts components, `p1-chart-data`, `p1-dashboard`, `DashboardFilters` and design tokens.
No parallel fetch, no service-role read, no fetch-everything-then-filter-in-client path.

## Gates

| Gate | Result |
|---|---|
| `pnpm test:p3-w06c` (new) | 22 pass |
| `pnpm test:p3-w05a` (touched audience/read-path files) | 43 pass |
| Affected dashboard/reporting tests | 66 pass (dashboard-brand, dashboard-source-status-cleanup, dashboard/layout, p1-dashboard, p1-chart-data, resolve-nav-actor) |
| react-server affected | 36 pass (w04a-panel-api, p3-w08a-session-revocation-cache, session-page-access) |
| `next typegen` / `pnpm typecheck` | pass / clean |
| `pnpm lint` | 0 errors (8 pre-existing warnings) |
| `pnpm build` | pass |
| `git diff --check` | clean |

## Acceptance evidence

- `all`: BoD layout only for a DB-confirmed `all`; team/own never reach it.
- `team`: team-scoped aggregate and options, distinct member-roster UX, no global source metadata.
- `own`: personal aggregate and options; no roster, no recruiter filter, no global source metadata.
- Fail closed: a failed read **or** a successful read without a usable audience renders a neutral error
  and never renders facts under a guessed scope label.
- Multi-team: the scope label stays inclusive (`<first> và N nhóm khác`) and the title/scope note never
  claim the whole scope is one named team.
- Scoped views receive props only and never render `drive_file_id`, `file_name`, sync status or presence.

## Deferred / notes

- The schema still allows several effective team scope grants per person; W06C only keeps the label
  inclusive. Locking the "one team scope per person" invariant needs a DB change, which stays T0's call.
- Route `loading.tsx` stays a neutral skeleton: the audience is only known after the scoped read.
- No Owner UI UAT, no Production access, no migration apply; Release A migration ordering stays T0's.
