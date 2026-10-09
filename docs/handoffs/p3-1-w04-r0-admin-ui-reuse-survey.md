# P3.1-W04-R0 — Admin UI reuse and interaction survey

> **Status:** `P3_1_W04_R0_UI_REUSE_SURVEY_COMPLETE_AWAITING_T0`
> **Base:** `origin/main@7a8aa40a7a2604c76ab4c522a9050bdedfa7b2e2`. Read-only survey: no source, migration,
> API, dependency, route or UI change; no browser/Playwright/CUA/screenshot; no Production DB or deploy.
> **Authority:** `docs/P3.1.md` (C01 locked), `docs/handoffs/p3-1-c01-catalog-policy-survey.md`,
> `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`. Where this survey and those documents differ, they win.

## 1. Evidence

| # | Evidence (file:symbol) | Fact that shapes W04 |
|---|---|---|
| E1 | `src/lib/auth/direct-entry-v2.ts:10` `CAPABILITIES` | Still **21 tokens**; `catalog_master_manage` and `team_manager_assign` do not exist yet. W01–W03 backends are **not** on main, so every screen below is a *contract request*, not a wiring task. |
| E2 | `src/lib/navigation/registry.ts:64` `NavEntry`, `:98` `NAV_ENTRIES`, `:155` `isDirectEntryRoute` | One entry = `{id,label,path,description,icon,status,capability,visibility}`; 4 entries today (dashboard, direct-entry, project-operations, worker-operations); Direct Entry paths sit behind `DIRECT_ENTRY_UI_ENABLED`. |
| E3 | `src/lib/navigation/registry-capability.ts:106` `NAV_CAPABILITY_PREDICATES`, `:119` `resolveNavCapabilityPredicate`, `:132` `decideNavEntryVisibility` | Pure capability→predicate map; an unknown key is **fail-closed** (`() => false`); `actor === null` shows only `any`. Adding a surface = add a predicate + a registry entry. |
| E4 | `src/app/dashboard/layout.tsx:27` | AppShell + `resolveNavActorForAppShell` live in a layout; the page decides access separately (`await connection()` first). Same shape is required for a new Admin area. |
| E5 | `src/lib/auth/direct-entry-page-access.ts:13` `DirectEntryPageDecision`, `:48`, `:70` | Existing page gate: `NOT_FOUND / REDIRECT_LOGIN / ACCOUNT_UNAVAILABLE / TEMPORARY_UNAVAILABLE / ACCESS_DENIED / ALLOW`, rendered by `src/components/auth/access-denied.tsx` and `temporary-unavailable.tsx`. Reuse verbatim; do not invent a second denial surface. |
| E6 | `src/components/direct-entry/project-operations.tsx:125` `ProjectOperations` + `src/lib/direct-entry/project-operations-model.ts` | Complete list/create/rename/set-active/assign/unassign surface with reason, OCC (`expected_version`, `expected_project_version`), `newIdempotencyKey()`, `classifyResponse` → `reload-required` on 409, conflict banner + authoritative reload, `splitAssignments` (current/future/history), `filterProjects`, `paginateProjects`, combobox candidate search, `candidateLabel` (no UUID). **The project surface for P3.1 already exists.** |
| E7 | `src/lib/direct-entry/worker-operations-model.ts:259-341` `TabPage`/`emptyTabPage`/`resetTabPage`/`beginLoad`/`applyPage`/`appendUnique`/`failLoad`, `:220` `WORKER_CONFLICT_MESSAGE`, `:399` `WORKER_LOAD_FAILED_MESSAGE`; `src/components/direct-entry/direct-entry-change-request-list.tsx:41` | A tested, entity-agnostic list state machine (cursor, `ready/empty/denied/unavailable/error`, retained rows on load-more failure, dedupe by stable id) plus the confirm-dialog pattern. Directly reusable for every admin list. |
| E8 | `package.json` deps; `import { Dialog } from "radix-ui"` usage; `src/components/ui/{card,alert}.tsx`; `src/components/reporting/{empty-state,error-state,status-badge,summary-card}.tsx` | `radix-ui@1.6.7` (Dialog/AlertDialog/DropdownMenu), `zod@4`, `nuqs`, `lucide-react`, `react-data-grid@7` (Direct Entry spreadsheet only), Tailwind 4, `exceljs`. **No form library exists** — the repo pattern is React 19 controlled state + pure `*-model.ts` validators. `Card`, `Alert` (info/warning/error tones), `EmptyState`, `ErrorState`, `SummaryCard` already exist. |
| E9 | `grep audit src/components` = **0 hits**; no `/api/**/audit` route; `audit_view` token exists unused | There is **no** audit UI or audit read endpoint today: the Audit group is net-new UI *and* a net-new projection (W03). |
| E10 | `labour-type touchpoints` (below §5) — `direct-entry-live.tsx:1196,1337,1450,2209,2407`, `direct-entry-spreadsheet-grid.tsx:38,176`, `direct-entry-change-request-proposer.tsx:125,579`, `direct-entry-change-request-reviewer.tsx:116`, `direct-entry-grid-columns.ts:99`, `excel-paste.ts:20`, `change-request-reviewer.ts:62`, `change-request-contract.ts:63`, `privileged-edit-api.ts:20`, `live-controller.ts:9`, `contracts/direct-entry-v1.ts:519` | Labor type is a hard-coded two-value closed set in 11+ places, including label↔key string comparisons (`=== "Chính thức"`) in `direct-entry-live.tsx`. W04 owns the consumer switch; this is the single most cross-cutting UI delta. |
| E11 | `src/app/api/direct-entry/**` route list | Reusable endpoints today (all currently `entry_admin + all`): `/projects`, `/projects/[projectId]`, `/projects/[projectId]/active`, `/projects/[projectId]/managers`, `/managers/[assignmentId]`, `/manager-candidates?search=`, `/catalog?effective_date=`. W02 must widen *authorization/projection*, not add parallel routes. |
| E12 | `node_modules/next/dist/docs/01-app/01-getting-started/{03-layouts-and-pages,05-server-and-client-components,10-error-handling}.md` | Route groups + nested layouts, explicit server/client boundary, and `notFound`/error boundaries are the documented mechanisms to use for the Admin area; no custom routing layer. |

## 2. Existing reusable surface (map of item 1)

| Need | Reuse as-is | Add (do not duplicate) |
|---|---|---|
| Nav + visibility | `NAV_ENTRIES`, `NAV_CAPABILITY_PREDICATES`, `decideNavEntryVisibility` | 3 predicates + up to 7 registry entries |
| Page gate + denial UX | `decide*PageAccess` + `AccessDenied`/`TemporaryUnavailable`/`AccountUnavailable` | 2 decision functions |
| List + cursor pagination + states | `TabPage` helpers (E7), `LoadMore` button pattern (`worker-operations.tsx`), retained-rows + retry alert | entity-specific `keyOf` + model |
| Tables / responsive | Plain semantic `<table>` inside `overflow-x-auto` with `<caption class="sr-only">` (project list, `WorkerTable`, `SubmissionTable`) | nothing |
| Dialog + destructive confirm | `radix-ui` `Dialog`/`AlertDialog` (`project-operations.tsx`, `direct-entry-change-request-list.tsx:133`) with sticky header/footer, `max-h-[calc(100dvh-2rem)]`, `onCloseAutoFocus` focus return | shared `AdminDialog` wrapper only if a third copy appears |
| Form fields + labels | `Field`, `ReasonField` (`project-operations.tsx:95,920`), `DialogActions` | extract to a shared primitive module |
| Reason / validation | `validateReason`, `validateDisplayName`, `validateProjectId`, `validateDate`, `validateUuid`, `validateVersion` (`project-operations-model.ts`) | per-entity validators in new `*-model.ts` |
| OCC / conflict / idempotency | `classifyResponse`, `mutationProjectVersion`, `WORKER_CONFLICT_MESSAGE`, conflict banner + reload-before-write lock | nothing |
| Effective-dated history | `splitAssignments` 3-way current/future/history + `AssignmentGroup` rendering | membership/leader interval variant |
| Candidate picker | manager combobox (search + `role="listbox"` + Arrow/Enter/Escape + `aria-activedescendant`) and `candidateLabel` | team-scoped candidate source |
| Status/metric display | `SummaryMetric`, `SummaryCard`, `StatusBadge`, `Card`, `Alert`, `EmptyState`, `ErrorState` | active/inactive entity badge |
| Dates/time | `hcmTodayDate()`, `formatHcmDateTime()`, `DdmmDateInput`, `direct-entry-ddmm-date-input.tsx` | nothing |

## 3. Proposed information architecture (item 2)

One capability-filtered Admin area; Direct Entry keeps its operational namespace:

| Route | Screen (item 2 group) | Nav predicate | Page decision |
|---|---|---|---|
| `/admin` | Admin landing (links to the groups the actor may use) | `catalog_operator` ∨ `admin_security` | `decideAdminLandingAccess` |
| `/admin/catalog/personnel` | **Nhân sự và team** — personnel list, create/edit, provider membership, team interval (join/move/unassign), unassigned-filter | `catalog_operator` | `decideAdminCatalogAccess` |
| `/admin/catalog/teams` | **Team và Trưởng nhóm** — team list/detail, member roster, designate/revoke leader (one active leader), historical leader intervals | `catalog_operator` | `decideAdminCatalogAccess` |
| `/admin/catalog/vendors` | **Vendor** — list, create (`vendor_id` immutable), rename, activate/deactivate | `catalog_operator` | `decideAdminCatalogAccess` |
| `/admin/catalog/labor-types` | **Loại hình lao động** — key (immutable) + label + sort order + active | `catalog_operator` | `decideAdminCatalogAccess` |
| `/direct-entry/projects` | **Dự án** (existing `ProjectOperations`) **plus leader manager-assignment mode** | `project_operations` = project-admin ∨ leader | `decideProjectOperationsPageAccess` (extended) |
| `/admin/access/accounts` | **Account và phân quyền** — existing users: enable/disable, grant/scope intervals, verified recruiter links | `admin_security` (= `adminAuthorityNavPredicate`) | `decideAdminSecurityAccess` |
| `/admin/access/audit` | **Audit explorer** — bounded audit projection, entity/actor/date filters, before/after | `admin_security` (Accounting gets catalog/worker events only) | `decideAdminSecurityAccess` |
| `/admin/access/restore` | **`entry_restore`** — Admin-only | `admin_security` | `decideAdminSecurityAccess` |

### 3.1 Leader manager-assignment placement (item 3)

- **Decision: extend `src/components/direct-entry/project-operations.tsx` (route `/direct-entry/projects`).** No parallel project-admin UI, no second assignment RPC chain, no copy of the list/detail dialog. The P2.5 surface already owns project master + effective-dated multi-manager history (E6) and C01 §2.2 keeps those RPCs canonical (E4 there: only the guard changes).
- The leader reaches the same route with a **reduced, server-projected capability set**: `can_view_project_master`, `can_manage_project_master`, `can_assign_managers` come from the server projection, never from a client capability check.
- Project-master controls (`Tạo dự án`, `Đổi tên`, `Ngừng/Kích hoạt`) render **only** when `can_manage_project_master` and are **additionally server-denied** (C01 §2.2: a leader must not pass the project-master guard). Hiding is presentation, not security.
- `Gán quản lý` / `Thu hồi phân công` are the only mutations offered to a leader; the candidate list must be the team-scoped projection (own effective team only), and unassign must remain available for an open assignment even when the project is inactive.
- Leaders never see grant, membership or project-metadata controls on this route.

## 4. Backend dependencies (item 4 — contract requests for W01–W03)

| Screen | Required projection / mutation (bounded, reason+OCC+idempotency+audit) | Wave |
|---|---|---|
| Personnel list/detail | `list/get personnel` incl. personnel_code, position, active, provider membership, team membership intervals, verified-link presence; create/update/set-active; membership assign/move/unassign (half-open) | W01 |
| Team list/detail | `list/get teams` incl. member roster + current/historical leader interval; team create/update/set-active | W01 |
| Leader designate/revoke | one atomic designate/revoke (app user + link + membership validation, `team` scope grant + `team_manager_assign` interval, audit records the *real* capability/scope); leader-state read | W01 |
| Project master | existing P2.5 `list/get/create/update/_set_project_active` (guard split only) | W02 |
| Leader assignment | `list/get project-manager assignments` **scoped to the leader's team**, `list manager candidates` **scoped to the leader's team**, assign/unassign (assign requires active project; unassign allowed on inactive; already-closed replays no-op) | W02 |
| Vendor | `list/get/create/update/set-active vendor`; `vendor_id` immutable, `display_name`/`active` mutable; atomic canonical recruiter/provider representation; never a team membership | W02 |
| Labor type | `list/create/update/set-active labor type` (immutable key, editable label/order/active) + **one active-value projection** consumed by Direct Entry, change requests, Excel/CSV import+template, filters and reporting | W02 |
| Accounts / grants / links | Admin-only `list/get app users`, enable/disable, capability+scope interval grant/revoke, verified recruiter-link mutations; revocation-safe reads | W03 |
| Audit explorer | bounded `list audit events` (entity, actor, time range, before/after, capability+scope recorded truthfully), no unrestricted PII | W03 |
| Restore | `entry_restore` server path + restoreable-item projection | W03 |

Capability/nav predicate contract (item 5): `catalog_operator` = `catalog_master_manage` + effective `all` (Admin **and** Accounting); `admin_security` = existing `adminAuthorityNavPredicate` (AND of `entry_admin`, `recruiter_master_manage`, `team_master_manage` at `all`); `project_operations` = `projectAdminNavPredicate` **or** (`team_manager_assign` + effective `team` scope + verified link + effective membership in that team). Accounting must not inherit `admin_security`; a leader must not inherit `catalog_operator` or `projectAdminNavPredicate`. **Menu hiding is not security**: every route keeps its server page decision and every RPC keeps its own guard, so a direct URL/API call for another team or for security administration fails server-side.

## 5. Interaction states (item 6)

- **Reason**: every mutation form requires a non-empty reason (`validateReason`, max 4000; privileged-edit 1000) and shows it in the dialog, not as a toast.
- **OCC**: every request carries `expected_version` (entity) and, for assignments, `expected_project_version`; a 409 raises the conflict banner, **locks all writes on that surface** until an authoritative reload succeeds, then unlocks with the freshly loaded version (`classifyResponse` → `reload-required`, verified by the R4/R5A browser regressions).
- **Idempotency**: one client-generated key per user intent; a retry reuses the same key, a new intent generates a new one (`newIdempotencyKey()` / `crypto.randomUUID()`).
- **No hard delete**: activate/deactivate only. Deactivation removes the row from new-entry choices; history stays readable and referenced rows can never be deleted.
- **Effective dates**: membership and leader intervals are half-open `[valid_from, valid_to)`; the UI shows current / scheduled / history separately (reuse the `splitAssignments` 3-way pattern) and never rewrites past intervals.
- **States per list**: `loading` (info), `empty` (info, distinct from success), `denied` (AccessDenied page or tab-local denial), `unavailable`/`error` (red + retry), `stale/conflict` (amber banner + reload). Load-more failure keeps loaded rows and shows a red alert with retry (`failLoad` + `WORKER_LOAD_FAILED_MESSAGE`).
- **Denied vs empty**: a capability denial is never rendered as `0 rows`.

## 6. File/symbol map (item 8)

**W04 — catalog administration UI**

| Action | File | Symbol |
|---|---|---|
| edit | `src/lib/navigation/registry.ts` | `NAV_ENTRIES` (+ `admin`, `admin-catalog-*`, `admin-access-*` entries; `isDirectEntryRoute` → generalise to a route-prefix gate) |
| edit | `src/lib/navigation/registry-capability.ts` | add `catalogOperatorNavPredicate`, `adminSecurityNavPredicate`, `projectOperationsNavPredicate`; register in `NAV_CAPABILITY_PREDICATES` |
| edit | `src/lib/auth/direct-entry-page-access.ts` | add `decideAdminLandingAccess`, `decideAdminCatalogAccess`, `decideAdminSecurityAccess`; extend `decideProjectOperationsPageAccess` for leaders |
| add | `src/app/admin/layout.tsx`, `src/app/admin/page.tsx` | Admin shell + landing |
| add | `src/app/admin/catalog/{personnel,teams,vendors,labor-types}/page.tsx` | server pages: gate → fetch → client view |
| add | `src/components/admin/catalog/{personnel-list,personnel-detail,team-list,team-detail,leader-panel,vendor-list,labor-type-list}.tsx` | client views |
| add | `src/components/admin/shared/{admin-table,admin-toolbar,row-actions,reason-dialog,deactivate-dialog,interval-history,entity-state-badge}.tsx` | primitives **extracted** from `project-operations.tsx`, not copied |
| edit | `src/components/direct-entry/project-operations.tsx` | consume `can_manage_project_master` / `can_assign_managers`; leader mode (candidate list + unassign on inactive project); keep all OCC/idempotency code |
| add | `src/lib/admin/{personnel,team,vendor,labor-type}-model.ts` | pure validators/builders/parsers + `node:test` units (mirror `project-operations-model.ts`) |
| add | `src/app/api/admin/catalog/{personnel,teams,leaders,vendors,labor-types}/**/route.ts` | thin handlers: session → repository → projector (mirror `src/app/api/direct-entry/projects/route.ts`) |
| edit | `src/lib/direct-entry/direct-entry-grid-columns.ts` | `DIRECT_ENTRY_LABOR_TYPE_OPTIONS` from the active-value projection |
| edit | `src/components/direct-entry/direct-entry-live.tsx` (+ `:1196,1337,1450,2209,2407`), `direct-entry-spreadsheet-grid.tsx:38,176` | label↔key resolution from the projection; remove hard-coded `"Chính thức"/"Thời vụ"` branching |
| edit | `src/components/direct-entry/direct-entry-change-request-proposer.tsx:125,579`, `direct-entry-change-request-reviewer.tsx:116`, `src/lib/direct-entry/change-request-reviewer.ts:62` | consume the projection instead of `LABOR_TYPE_LABELS` |
| edit | `src/lib/direct-entry/excel-paste.ts:20`, `excel-paste-import.ts`, `live-controller.ts:9,101`, `change-request-contract.ts:63`, `privileged-edit-api.ts:20`, `src/lib/contracts/direct-entry-v1.ts:519` | widen `LaborType` + validators + import aliases to the catalog; unknown/inactive fail closed on write |

**W05 — access, audit and restore UI**

| Action | File | Symbol |
|---|---|---|
| add | `src/app/admin/access/{accounts,audit,restore}/page.tsx` | server pages with `admin_security` gate |
| add | `src/components/admin/access/{account-list,account-detail,grant-intervals,recruiter-link-editor,audit-explorer,audit-row-detail,restore-dialog}.tsx` | client views |
| add | `src/lib/admin/{account-access-model,audit-model,restore-model}.ts` | pure projection/parse/validate units |
| add | `src/app/api/admin/access/{accounts,grants,links,audit,restore}/**/route.ts` | Admin-only handlers; Accounting denied |

## 7. Not to be reused, and why (item 9)

| Rejected | Reason |
|---|---|
| `direct-entry-grid*` / `react-data-grid` (`direct-entry-spreadsheet-grid.tsx`, `grid-smoke.tsx`) | It is a keyboard-driven editable batch-entry spreadsheet with local draft state and paste semantics. Catalog administration is row-level CRUD with OCC/conflict dialogs; reusing the grid would import the wrong interaction model, remount/editor complexity and a second validation path. |
| `direct-entry-live.tsx` | Bulk staged entry workflow (draft rows, catalog-per-date, paste) — no per-row OCC/audit story, and it is a consumer of the labor-type catalog, not a base for admin screens. |
| `direct-entry-change-request-{list,reviewer,proposer}.tsx` as an audit/diff viewer | It is a *decision workflow* over proposals (approve/reject/withdraw). The audit explorer needs an immutable event projection (actor/capability/scope/time/before/after) with filters; reusing the change-request components would misrepresent audit as a pending approval. |
| `dashboard/*` chart/panel components | Reporting visualisation, not entity administration; `StatusBadge`/`SummaryCard` are reused instead (only the primitives). |
| `DemoDirectEntryShell`, `/pipeline-check` remnants, AI settings panels | Demo/retired/deferred surfaces; AI stays off (§P3.1 scope warning). |
| `UserSessionControl` as an account-management surface | It is session identity only and is owned by the session lane; account administration belongs to `/admin/access/accounts`. Do not add grant/role UI there. |
| Any new form/state/grid/table/design-system package | The existing primitives cover every screen above (E8). No new dependency, form framework, grid library or design system is proposed. |

## 8. Risks and deferred items (item 10)

- **Blocked until W01–W03 land (E1).** W04 cannot start wiring: the capability tokens do not exist and no catalog/leader/vendor/labor-type/account/audit projection exists. The `Capability` union must be bumped to 23 tokens by W01 before any predicate in §4 compiles.
- **Labor-type consumer switch is cross-cutting (E10, 11+ files)** and includes string comparisons on display labels; it must be done as one reviewed package with regression tests, or Direct Entry and reporting will disagree.
- **`project-operations.tsx` is already ~1000 lines.** Extending it for leader mode plus a second admin area will duplicate dialog/table code unless §6's `admin/shared/*` extraction happens first.
- **Leader UX must be server-projected.** `can_manage_project_master`/`can_assign_managers` come from the server; a client-side capability or role check would violate C01 and the P3.1 gate.
- **Audit PII boundary.** The explorer must not expose unrestricted PII; `pii_export` stays hidden until the Owner explicitly activates it.
- **Accounting isolation.** Sharing `/admin` between Admin and Accounting is a UI convenience only; the `admin_security` group must render `AccessDenied` for Accounting and its APIs must deny server-side.
- **Deferred:** account invitation/creation and forced reset (P3.2), co-leaders / multiple simultaneous leaders per team (locked out in P3.1), project metadata beyond contracted fields, Team Dashboard changes, `pii_export`, and all browser/mobile UAT (Owner only).
- **Responsive/a11y requirement (item 7, no browser run):** reuse the existing mobile-safe dialog sizing (`max-h-[calc(100dvh-2rem)]`, `w-[calc(100vw-2rem)]`, sticky header/footer, `onCloseAutoFocus` focus return), the tablist keyboard pattern, labelled form controls, `role="alert"` for errors and `role="status"` for info, `sr-only` table captions, and the no-horizontal-overflow table wrapper. Acceptance is by source/unit tests plus Owner UAT.

## 9. Boundary

No source, migration, API, dependency, navigation or UI implementation was changed in this task; the only artifact is this survey. `docs/P3.1.md` was not modified. No browser, CUA or screenshot was used; no Production DB, migration apply or deploy was performed. W04A is **not** started.
