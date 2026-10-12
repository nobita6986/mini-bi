# P3.1-HF-R3-R1 (T1A) — Duplicate CCCD report as a Dashboard tab

- **Status:** `P3_1_HF_R3_R1_DUPLICATE_CCCD_REPORT_DASHBOARD_TAB_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Branch / worktree:** `feature/p3-1-hf-r3-duplicate-cccd-report-ui` on the existing isolated worktree (`node_modules` is a junction to the primary checkout).
- **Base (preflight of P3.1-HF-R3):** `origin/main@48bb83b2572ff241a9acecd2db54e53a5d245a55`; the branch tip before this task was `4411374` (the P3.1-HF-R3 API/UI deliverable).
- **Reconciliation (R1):** at the start of this task `origin/main` had advanced to `2a235b0` (W06D dashboard tabs: `e7f54b4` + `2a235b0`), so the branch had **diverged** and a fast-forward update was impossible. Per T0's decision I merged `origin/main` into the branch — **additive, no rebase/amend/force-push, no new branch** — resolving the single `package.json` `test` chain conflict by keeping **both** lanes exactly once. Merge commit `3f91004`.
- **Final SHA / parity:** recorded in the completion summary; `origin/feature/p3-1-hf-r3-duplicate-cccd-report-ui` = local HEAD (fast-forward push).

## What changed (UI)

- **Top-level nav removed.** The `duplicate-cccd-report` registry entry, the `duplicate_cccd_report` `NavCapability` token, its `NAV_CAPABILITY_PREDICATES` mapping, and the `ShieldAlert` icons in `desktop-nav.tsx` / `mobile-nav.tsx` are gone. The two nav lanes are back to **5** current entries.
- **Dashboard tab added.** "Báo cáo CCCD trùng" is now the third sibling tab in `BodDashboardTabs`, placed **right after** "Báo cáo theo nhóm" (`general` → `team` → `duplicate-cccd`). It renders the existing `DuplicateCccdReportPanel`.
- **Reuse, not a second UI.** The existing API, contract and panel are reused; the panel was adapted to the Dashboard shell — page-level `<h1>`/container removed, `Card`/`space-y-4`/typography/colors and the tab shell's `max-w-6xl` container/responsive pattern inherited. The standalone `/reports/duplicate-cccd` route + layout were **deleted** (no off-standard second surface).
- **URL/tab contract.** `tab` ∈ `general | team | duplicate-cccd` (default `general`), history/filter semantics unchanged. The CCCD panel reads only `page`/`page_size` and never consumes dashboard filters; `source` (a general-only filter) is normalized away for the `team` and `duplicate-cccd` tabs before render.
- **Content/logic preserved.** Masked CCCD (last 4 + length), pagination, loading/empty/denied/unavailable/error + retry, and server-side access control are unchanged.

## Pagination must-fix (page-1000)

`nextDuplicateCccdReportPage(page, hasMore)` returns `null` once `page >= 1000`, so at page 1000 the "Trang sau" control is **never** able to request page 1001 even when the RPC returns `has_more: true`. Focused regression test added.

## Authority and access (no backend change)

- The tab is **server-derived** (`canViewDuplicateCccdReport(actor)`, computed in the Dashboard page). The Dashboard page also redirects an unauthorized `?tab=duplicate-cccd` deep link back to `general`.
- The predicate mirrors `direct_entry_assert_duplicate_cccd_reader` (#74) exactly: legacy Full Admin triple **OR** `catalog_master_manage` **OR** `entry_privileged_edit`, **and** an effective `all` scope. Nothing is widened, and the API/RPC still enforces independently.
- **BoD / Kế toán confirmation — no blocker.** The Dashboard audience comes from the W05A scoped RPC, which resolves `audience='all'` from an effective `all` scope alone (no capability required), and the BOd tab shell renders for `all`. So:
  - BoD (`entry_privileged_edit` + `all`): page gate `ALLOW` → audience `all` → predicate true → RPC `direct_entry_duplicate_cccd_report` allows `entry_privileged_edit` + `all`.
  - Kế toán (`catalog_master_manage` + `all`): page gate `ALLOW` → audience `all` → predicate true → RPC allows `catalog_master_manage` + `all`.
  Both pass on existing server-side page/API gates; **no contract/backend change is required**.
- Admin/W06C/W06D dashboard lanes were rebaselined only where the tab set legitimately changed (W06D two-tab → three-tab assertions, two-tab `DashboardTab` union).

## Files

- **Modified:** `src/app/dashboard/page.tsx`, `src/components/dashboard/bod-dashboard-tabs.tsx`, `src/components/dashboard/dashboard-view.tsx`, `src/components/dashboard/team-reporting-ui.test.mjs` (rebaseline), `src/components/reporting/duplicate-cccd-report-panel.tsx`, `src/lib/auth/direct-entry-page-access.ts`, `src/lib/direct-entry/duplicate-cccd-report-contract.ts`, `src/lib/navigation/registry.ts`, `src/lib/navigation/registry-capability.ts`, `src/lib/navigation/registry.test.mjs`, `src/lib/navigation/registry-capability.test.mjs`, `src/components/app-shell/{desktop-nav,mobile-nav}.tsx`, `package.json` (merge), `scripts/p3-1-hf-r3-duplicate-cccd-report-ui-mutation.mjs`.
- **Deleted:** `src/app/reports/layout.tsx`, `src/app/reports/duplicate-cccd/page.tsx`.
- **Tests updated:** `src/lib/direct-entry/duplicate-cccd-report-contract.test.mjs` (page-1000), `src/lib/auth/duplicate-cccd-report-access.test.mjs` (tab placement, nav removal, gate, panel states, filter isolation).
- **Not touched:** migration/RPC/schema, the submit-time CCCD warning (P3.1-HF-R1), writer paths, `src/lib/reporting/*`.

## Tests

- Focused lane `test:p3-1-hf-r3-duplicate-cccd-report-ui` (25 tests: contract + page-1000, repository, api, access/tab) — registered once in the canonical chain.
- New coverage: tab position (after `team`) + label, top-level nav removal + no standalone page, server-derived gate (`canViewDuplicateCccdReport`), panel states (loading/denied/unavailable/error/retry/empty) and no dashboard-filter consumption, page-1000 boundary.
- **Mutation evidence** (`scripts/p3-1-hf-r3-duplicate-cccd-report-ui-mutation.mjs`): 5/5 RED, sources restored byte-for-byte:
  1. remove the all-scope gate on the report predicate;
  2. return `authority`/`project_id` to the client;
  3. exceed the RPC paging bound (drop the `page_size` ceiling);
  4. drop the page-1000 ceiling (allow page 1001 despite `has_more`);
  5. drop the Dashboard CCCD tab gate (always show the tab).

## Gates

- `next typegen` + `pnpm typecheck` (exit 0), `pnpm lint` (0 errors; pre-existing warnings only), `next build --webpack` (exit 0 — `/api/direct-entry/duplicate-cccd-report` present, no `/reports` route, `BUILD_ID` written), `pnpm docs:check` (6/6), `pnpm secrets:check` (clean), `pnpm db:migrate -- --offline` (85 migrations valid, #74 present), `git diff --check` (exit 0).
- Related lanes green: `test:p3-w06d`, `test:p3-w06c`, `test:p3-1-hf-admin-direct-catalog-navigation`, `test:app-nav-02a`, `test:p3-1-w04-a1-a2`, `test:p3-1-hf-mobile-theme-menu`, `test:p3-1-w04-c/d/a4` and `test:p3-1-w05-a` admin-UI lanes.
- `test:main`: 447 tests, 446 pass, **1 fail** — the same **pre-existing G4-I** (`w04-g4-acceptance.test.mjs`), untouched by this work.

## Limitations

- `pnpm build` (Turbopack) cannot run in this worktree (`node_modules` junction points out of the filesystem root); the documented Webpack opt-out was used.
- No Production query/apply, deploy, browser/UAT or merge to main. The primary checkout was not modified (a concurrent W06D session owns its working-tree changes).
