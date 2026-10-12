# P3-W06D-R2 — Shared team report for Team Leader and BoD

## Status

`P3_W06D_R2_SHARED_TEAM_REPORT_BOTH_BLOCKERS_HANDLED_LOCAL_PASS_AWAITING_T0_REVIEW`

Both functional blockers from the R1 revision are resolved: the Team Leader can
read the entry-level detail of a team inside its server-confirmed scope, and the
BoD team tab reads the SELECTED team's report (aggregate + member contribution +
detail) instead of the company-wide aggregate. One shared `TeamReportView`
serves both audiences.

## Base / branch / worktree

- Repo: `C:\CodeApp\BI`
- Worktree: `C:\CodeApp\BI-p3-w06d-r2-shared-team-report`
- Branch: `feature/p3-w06d-r2-shared-team-report`
- Base: `origin/main@2a235b038cbd3ae845de0a935c052f7956ae4aa0`
- Commits: `701cabd` (R1 component + HRP/Vendor removal + detail last),
  `8bd7679` (R1 handoff), `6b887e7` (R2 team-scoped server read), plus this
  handoff commit.
- **No migration**: the ledger stays at 85 (offline-validated). No RPC, schema,
  API-contract or dependency change — the change is additive server + UI code.
- Primary checkout (and its uncommitted metadata-title edits) untouched.

## 1. What was asked

- Team Leader must see the report of the teams in its server-confirmed scope,
  including the entry-level detail at the end.
- BoD selects a team and sees the SAME team report (same breakdowns + detail).
  The detail table stays on BoD (hiding still deferred).
- One shared `TeamReportView`; no BoD copy.
- Keep the two agreed edits: no "Theo HRP/Vendor của nhóm"; detail list last.
- With no team selected, BoD keeps its current bucket list / overview.
- All read authority and team scope resolved on the server; no client filter
  widening, no trusting a client-chosen team/bucket, no direct client RPC, no
  Admin Catalog, no cross-team leak; existing validation/masking/pagination/
  error handling preserved; the RPC authority gate is not bypassed.

## 2. The real Team Leader surface

`src/components/dashboard/team-dashboard-view.tsx` (DB audience `team`,
eyebrow `Trưởng nhóm · Báo cáo nhóm`) is the only report with the
"Theo HRP/Vendor của nhóm" card, so it is the donor report. The BoD team tab
(`src/components/dashboard/bod-dashboard-tabs.tsx`, `tab=team`) is the
recipient.

## 3. How the two blockers were resolved (no new migration)

The existing actor-scoped RPC already returns the DB-resolved audience and the
authorized facts (carrying `team_id`/`team_code`/`team_display_name`/
`team_active`). That is enough to serve a team-scoped report **server-side**, so
no migration is needed:

- **New** `src/lib/reporting/p3-w06d-team-report-core.ts` (pure):
  - `decodeBucket` (canonical `team.<base64url>` / `unknown`);
  - `selectBucketFacts` (bucket membership inside the authorized set);
  - `authorizeBucket(dbKind, decoded, hasBucketFacts)` — `own` denied;
    `unknown` allowed for `all` only; a team bucket allowed for `all` when it has
    facts, and for `team` only when the team is present in the authorized facts
    (i.e. inside the granted scope); otherwise denied;
  - `buildTeamDetail` (7-field sanitized rows, opaque cursor, limit 25/100, the
    `unknown` legacy split, and an empty page past the last cursor).
- **New** `src/lib/reporting/p3-w06d-team-report-server.ts` (`server-only`):
  `fetchCutoverTeamReport(params, actor)` parses with the existing thin
  `parseTeamDrillDownRequest` (reusing the allowlist/limit/cursor/canonical
  bucket rules), calls `direct_entry_reporting_scoped_facts`, keeps the audience
  from THAT payload (never the request), runs the core, and builds the aggregate
  with the shared `computeScopedReportingData`. Failures map to
  `400 INVALID_FILTER` / `403 REPORTING_QUERY_FAILED` / `503`.
- **New** `src/app/api/reporting/team-report/route.ts`: `GET`, `runtime=nodejs`,
  `dynamic=force-dynamic`, its own `await guardApiSession()`, no-store headers.
- **Modified** `src/lib/reporting/p2-w04a-reporting-server.ts`: extracted
  `computeScopedReportingData` so masking/reconciliation/compute are expressed
  once and reused by both reads. Behaviour is unchanged; the W05A-asserted
  `computeReporting(sources, combinedFacts, filters, sourcesWithFacts)` literal
  is preserved.
- **Modified** `src/lib/reporting/p2-w05b-team-drill-down-parser.ts`: exported
  `decodeTeamBucketKey`; tightened `TeamDrillDownFilters.filters` to
  `ReportingFilters`.
- **UI**: `team-report-view.tsx` renders a bucket picker from
  `sortBuckets(data.byTeam)`, a keyed `TeamReportSelection` that fetches the
  selected team from the new endpoint, `TeamReportBody` for the scope/selected
  data, and the shared `TeamEntryDetail` LAST. `team-entry-detail.tsx` is now the
  detail-only tail (pages further via the same endpoint). `team-report-request.ts`
  builds the request from the DB-applied `data.applied` filters (never `source`).

## 4. Shared report contract

- Both audiences render `TeamReportView`. Section order:
  header → scope note → filters → **team picker** → **member contribution** →
  trend → project → employment → [project/provider mix] → **entry-level detail
  (LAST)**.
- Removed: the "Theo HRP/Vendor của nhóm" card.
- No selection ⇒ the audience-scoped report (`data`) is shown and the bucket
  list stays (BoD overview). A selection is only valid while the DB-applied
  filter signature is unchanged; any filter change resets it.
- The `unknown` bucket is selectable only for the `all` audience.

## 5. Authority and safety

- Audience kind + authorized facts come from the DB RPC; the requested
  `bucket_key` is verified against them (`authorizeBucket`). A client-supplied
  audience/bucket is never trusted (there is no `params.audience`/`kind` input).
- `own` and out-of-scope `team` requests are refused (403) before any fact is
  projected; no cross-team data can leave.
- No Admin Catalog, no client-side team/membership join, no figure derivation
  from the paginated list, no direct client RPC (the browser calls a guarded
  route).
- Existing validation (thin parser + `parseReportingFilters`), masking
  (`maskDirectEntryFacts`/`maskLegacyFacts`), cutover reconciliation and the
  sanitized error taxonomy are reused.

## 6. Deferred / unchanged

- **Deferred (per review):** hiding / not-loading the BoD detail table. Both
  sides still render the shared detail section.
- `GET /api/reporting/team-drill-down` and its RPC are left byte-identical; the
  R2 UI reads the selected team through the new scoped endpoint (which enforces
  the audience server-side), so the all-only drill-down is no longer on the UI
  path but remains available and green.

## 7. Verification

- Focused W06D lane `pnpm test:p3-w06d` — **23/23 PASS**, including the new pure
  core regressions: BoD team A reads team A only (not company-wide or team B);
  scope denials for `own`/out-of-scope/`unknown`; detail paging + the `unknown`
  legacy split.
- W06C — 22/22; W05B-A — 13/13; W05A — 46/46; admin direct-catalog — 98/98;
  W05-A existing-account — 29/29.
- `next typegen` PASS; `pnpm typecheck` PASS.
- `pnpm lint` — 0 errors, 13 pre-existing warnings.
- `pnpm build` PASS (`/dashboard`, `/api/reporting/team-report`,
  `/api/reporting/team-drill-down` generated).
- `pnpm docs:check` 6/6; `pnpm secrets:check` 0 secrets; offline migration
  validation 85 migrations VALID (no DB access); `git diff --check` PASS.
- Canonical `pnpm test` was NOT run (task scope: focused + related lanes). The
  known pre-existing canonical blocker recorded by the W06D-R1 handoff is a
  `G4-I` failure in `test:main` present on the base and unrelated to this change.
- Not run (task boundary): DB apply/query, deploy, browser/UAT, merge to main.

## 8. Mutation probes

Each mutation made the focused lane RED; each file was restored byte-identically
(hash match) and the lane returned GREEN 23/23.

1. `authorizeBucket`: `own`/null no longer denied → RED.
2. `authorizeBucket`: missing bucket facts no longer denied for `team` → RED.
3. `team-report-request.ts` endpoint → `/api/reporting/team-drill-down` → RED.
4. server: add `params.kind` (trust a client audience) → RED.
5. `team-report-view.tsx`: fetch no longer keyed to the selected bucket → RED.

## 9. Review target

T0 should confirm: the BoD team tab now reads the selected team (aggregate +
member contribution + detail) through the server-authorized endpoint; the Team
Leader reads its in-scope team detail and is refused outside scope; both sides
use the one `TeamReportView`; the two agreed edits hold; no migration/RPC change
was made; and the BoD detail hide remains deferred.
