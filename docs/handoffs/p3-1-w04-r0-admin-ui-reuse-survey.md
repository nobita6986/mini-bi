# P3.1-W04-R0 — Admin UI reuse and interaction survey

> **Status:** `P3_1_W04_R0_R1_UI_REUSE_SURVEY_PASS_AWAITING_T0`
> **Survey base (traceability):** `origin/main@7a8aa40a7a2604c76ab4c522a9050bdedfa7b2e2` — the state the
> original survey was taken from. **Current main rebaseline:** `origin/main@6e8c5c61f4d62c5dacd5699a202dd09cb28b6aff`
> (§0). Read-only survey: no source, migration, API, dependency, route or UI change; no browser/Playwright/CUA/
> screenshot; no Production DB or deploy.
> **Authority:** `docs/P3.1.md` (C01 locked), `docs/handoffs/p3-1-c01-catalog-policy-survey.md`,
> `docs/handoffs/p3-1-j00-security-regression-baseline.md` (security matrix), `docs/handoffs/p3-1-w01a-capability-contract-foundation.md`,
> `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`. Where they and this survey differ, they win.

## 0. Current-main rebaseline (R1)

| Fact | State |
|---|---|
| W01A (capability contract foundation) | **On main** — commit `8240b2d`, migration **#67** `20261009030000_p3_1_w01a_capability_contract_foundation.sql`; documented in `docs/handoffs/p3-1-w01a-capability-contract-foundation.md`. |
| Capability registry | **23 tokens**, contract version `direct-entry-auth/1.3` (`CAPABILITIES` counted exactly 23). |
| `catalog_master_manage`, `team_manager_assign` | **Exist** in the TypeScript registry/`Capability` union **and** in the DB capability vocabulary (migration #67). |
| W01B / W01C / W02 backends | **Not on main.** No catalog guard, no team-scoped leader guard, no leader designate/revoke RPC, no team-scoped candidate/assignment projection, no Vendor lifecycle RPC, no labor-type catalog/projection (grep for those guard/RPC names on `origin/main` returns nothing). |
| Consequence for W04 | Unchanged: **W04 implementation still waits for the W01B/W01C/W02 backend contracts to stabilize.** Only the token vocabulary is unblocked. |

## 1. Evidence

| # | Evidence (file:symbol) | Fact that shapes W04 |
|---|---|---|
| E1 | `src/lib/auth/direct-entry-v2.ts:10` `CAPABILITIES` | **At the survey base `7a8aa40` only:** 21 tokens and neither new token existed. **Superseded by §0** — on current main the registry is 23 tokens and both tokens exist. Kept here solely to explain why the original draft called every screen a contract request. |
| E2 | `src/lib/navigation/registry.ts:64` `NavEntry`, `:98` `NAV_ENTRIES`, `:155` `isDirectEntryRoute` | One entry = `{id,label,path,description,icon,status,capability,visibility}`; 4 entries today (dashboard, direct-entry, project-operations, worker-operations); Direct Entry paths sit behind `DIRECT_ENTRY_UI_ENABLED`. |
| E3 | `src/lib/navigation/registry-capability.ts:106` `NAV_CAPABILITY_PREDICATES`, `:119` `resolveNavCapabilityPredicate`, `:132` `decideNavEntryVisibility` | Pure capability→predicate map; an unknown key is **fail-closed** (`() => false`); `actor === null` shows only `any`. Adding a surface = add a predicate + **one** registry entry. |
| E4 | `src/app/dashboard/layout.tsx:27` | AppShell + `resolveNavActorForAppShell` live in a layout; the page decides access separately. Same shape is required for the Admin area. |
| E5 | `src/lib/auth/direct-entry-page-access.ts:13` `DirectEntryPageDecision`, `:48`, `:70` | Existing page gate: `NOT_FOUND / REDIRECT_LOGIN / ACCOUNT_UNAVAILABLE / TEMPORARY_UNAVAILABLE / ACCESS_DENIED / ALLOW`, rendered by `src/components/auth/access-denied.tsx` and `temporary-unavailable.tsx`. Reuse verbatim; do not invent a second denial surface. |
| E6 | `src/components/direct-entry/project-operations.tsx:125` + `src/lib/direct-entry/project-operations-model.ts` | Complete list/create/rename/set-active/assign/unassign surface with reason, OCC (`expected_version`, `expected_project_version`), `newIdempotencyKey()`, `classifyResponse` → `reload-required` on 409, conflict banner + authoritative reload, `splitAssignments` (current/future/history), `filterProjects`, `paginateProjects`, combobox candidate search, `candidateLabel` (no UUID). **The project operations surface for P3.1 already exists.** |
| E7 | `src/lib/direct-entry/worker-operations-model.ts:259-341` `TabPage`/`emptyTabPage`/`resetTabPage`/`beginLoad`/`applyPage`/`appendUnique`/`failLoad`, `:220` `WORKER_CONFLICT_MESSAGE`, `:399` `WORKER_LOAD_FAILED_MESSAGE`; `src/components/direct-entry/direct-entry-change-request-list.tsx:41` | A tested, entity-agnostic list state machine (cursor, `ready/empty/denied/unavailable/error`, retained rows on load-more failure, dedupe by stable id) plus the confirm-dialog pattern. Directly reusable for every admin list. |
| E8 | `package.json` deps; `import { Dialog } from "radix-ui"` usage; `src/components/ui/{card,alert}.tsx`; `src/components/reporting/{empty-state,error-state,status-badge,summary-card}.tsx` | `radix-ui@1.6.7` (Dialog/AlertDialog/DropdownMenu), `zod@4`, `nuqs`, `lucide-react`, `react-data-grid@7` (Direct Entry spreadsheet only), Tailwind 4, `exceljs`. **No form library exists** — the repo pattern is React 19 controlled state + pure `*-model.ts` validators. `Card`, `Alert` (info/warning/error), `EmptyState`, `ErrorState`, `SummaryCard` already exist. |
| E9 | `grep audit src/components` = 0 hits; no audit read route; `audit_view` token exists with no consumer | There is **no** audit UI or audit read endpoint today: the Audit surface is net-new UI *and* a net-new mode-scoped projection (W03). |
| E10 | Labor-type touchpoints: `direct-entry-live.tsx:1196,1337,1450,2209,2407`, `direct-entry-spreadsheet-grid.tsx:38,176`, `direct-entry-change-request-proposer.tsx:125,579`, `direct-entry-change-request-reviewer.tsx:116`, `direct-entry-grid-columns.ts:99`, `excel-paste.ts:20`, `change-request-reviewer.ts:62`, `change-request-contract.ts:63`, `privileged-edit-api.ts:20`, `live-controller.ts:9`, `contracts/direct-entry-v1.ts:519` | Labor type is a hard-coded two-value closed set in 11+ places, including label↔key string comparisons in `direct-entry-live.tsx`. W04 owns the consumer switch; this is the most cross-cutting UI delta. |
| E11 | `src/app/api/direct-entry/**` route list | Reusable endpoints today (currently `entry_admin + all`): `/projects`, `/projects/[projectId]`, `/projects/[projectId]/active`, `/projects/[projectId]/managers`, `/managers/[assignmentId]`, `/manager-candidates?search=`, `/catalog?effective_date=`. W02 must widen *authorization/projection*, not add parallel routes. |
| E12 | `node_modules/next/dist/docs/01-app/01-getting-started/{03-layouts-and-pages,05-server-and-client-components,10-error-handling}.md` | Route groups + nested layouts, explicit server/client boundary, and `notFound`/error boundaries are the documented mechanisms for the Admin area; no custom routing layer. |

## 2. Existing reusable surface

| Need | Reuse as-is | Add (do not duplicate) |
|---|---|---|
| Nav + visibility | `NAV_ENTRIES`, `NAV_CAPABILITY_PREDICATES`, `decideNavEntryVisibility` | predicates + **one** top-level entry + an internal Admin sub-nav |
| Page gate + denial UX | `decide*PageAccess` + `AccessDenied`/`TemporaryUnavailable`/`AccountUnavailable` | 2–3 decision functions |
| List + cursor pagination + states | `TabPage` helpers (E7), `LoadMore`, retained-rows + retry alert | entity-specific `keyOf` + model |
| Tables / responsive | Semantic `<table>` inside `overflow-x-auto` with an `sr-only` caption | nothing |
| Dialog + destructive confirm | `radix-ui` `Dialog`/`AlertDialog` with sticky header/footer, `max-h-[calc(100dvh-2rem)]`, `onCloseAutoFocus` focus return | shared wrapper only if a third copy appears |
| Form fields + labels | `Field`, `ReasonField` (`project-operations.tsx:95,920`), `DialogActions` | extract to a shared primitive module |
| Reason / validation | `validateReason`, `validateDisplayName`, `validateProjectId`, `validateDate`, `validateUuid`, `validateVersion` | per-entity validators in new `*-model.ts` |
| OCC / conflict / idempotency | `classifyResponse`, `mutationProjectVersion`, `WORKER_CONFLICT_MESSAGE`, conflict banner + reload-before-write lock | nothing |
| Effective-dated history | `splitAssignments` 3-way + `AssignmentGroup` | membership/leader interval variant |
| Candidate picker | manager combobox (search, listbox roles, Arrow/Enter/Escape, `aria-activedescendant`) + `candidateLabel` | team-scoped candidate source |
| Status/metric display | `SummaryMetric`, `SummaryCard`, `StatusBadge`, `Card`, `Alert`, `EmptyState`, `ErrorState` | active/inactive entity badge |
| Dates/time | `hcmTodayDate()`, `formatHcmDateTime()`, `DdmmDateInput` | nothing |
| Audience-scoped payload rendering | `src/lib/reporting/p3-w05a-audience.ts`, `p3-w06c-audience-view.ts` and the dashboard audience views | reuse the *pattern* (server returns a mode/audience, the client renders it) for the audit mode |

## 3. Proposed information architecture (FIX 2 + FIX 3)

**Navigation (FIX 3): exactly ONE new top-level AppShell entry.**

| Level | Item | Predicate |
|---|---|---|
| Top-level nav | `admin` → `/admin` (**only one**) | `admin_area` = `catalog_operator` ∨ `admin_security` |
| Existing top-level | `direct-entry/projects` → `/direct-entry/projects` (**unchanged route, not moved into `/admin`**) | `project_operations` (see §3.1) |
| Internal Admin sub-nav (rendered by `src/app/admin/layout.tsx`, not by the AppShell) | `personnel`, `teams`, `vendors`, `labor-types` (group *Danh mục*) and `accounts`, `audit`, `restore` (group *Truy cập*) | per-section predicate, server-projected allowed list |

The sub-nav lists **only** the sections the server projection allows for the actor; no 6–7 extra top-level items, no per-section AppShell entries, and no duplicate of the project operations menu.

| Route (internal) | Screen (item 2 group) | Section predicate |
|---|---|---|
| `/admin` | landing: links to the allowed sections | `admin_area` |
| `/admin/catalog/personnel` | **Nhân sự và team** — list, create/edit, provider membership, team interval (join/move/unassign), unassigned filter | `catalog_operator` |
| `/admin/catalog/teams` | **Team và Trưởng nhóm** — team list/detail, roster, designate/revoke leader (one active leader), leader intervals | `catalog_operator` |
| `/admin/catalog/vendors` | **Vendor** — list, create (`vendor_id` immutable), rename, activate/deactivate | `catalog_operator` |
| `/admin/catalog/labor-types` | **Loại hình lao động** — immutable key + editable label/order/active | `catalog_operator` |
| `/direct-entry/projects` | **Dự án** (existing `ProjectOperations`) **plus leader manager-assignment mode** | `project_operations` |
| `/admin/access/accounts` | **Account và phân quyền** — enable/disable, grant/scope intervals, verified recruiter links | `admin_security` |
| `/admin/access/audit` | **Audit explorer — mode-aware** (below) | `admin_security` ∨ `catalog_operator` |
| `/admin/access/restore` | **`entry_restore`** | `admin_security` |

### 3.1 Audit explorer is mode-scoped, not admin-only (FIX 2)

The audit route is **not** locked to `admin_security`. Access is `admin_security ∨ catalog_operator`, and the **server returns the mode**; the client renders the payload it receives and never infers a role or capability:

| Actor | Audit mode returned by the server | Surface |
|---|---|---|
| Full Admin | `full` — bounded full audit explorer with entity/actor/time filters | `/admin/access/audit` |
| Accounting / catalog operator | `catalog` — catalog and worker events allowed by policy; **security-admin events never returned** | same route, narrower payload and hidden filters |
| Team leader | `none` — **no global audit explorer**; only own manager-assignment events, surfaced **inside the existing project operations** assignment history/detail (server-projected) | `/direct-entry/projects` |
| Project manager / ordinary staff | `none` — no audit explorer in P3.1 | — |

Implementation shape: the page decision resolves the mode server-side; the payload carries `mode` (+ its bounded rows); `src/lib/admin/audit-model.ts` validates the payload per mode and rejects anything wider (fail-closed). This mirrors the existing audience-scoped reporting pattern (`p3-w05a`/`p3-w06c`) rather than inventing a client-side role check. A single generic "admin audit" page that returns everything and hides rows in the browser is explicitly rejected.

### 3.2 Leader manager-assignment placement (item 3, FIX 1)

- **Decision: extend `src/components/direct-entry/project-operations.tsx` on its existing route.** No parallel project-admin UI, no second assignment RPC chain, no copy of the list/detail dialogs. The P2.5 surface already owns project master + effective-dated multi-manager history (E6), and C01 keeps those RPCs canonical — only the guard changes.
- `project_operations` (route entry, page decision and nav predicate) = **legacy project admin** (`entry_admin` + effective `all`) **OR catalog operator** (`catalog_master_manage` + effective `all`) **OR team leader** (`team_manager_assign` + effective `team` scope).
- **Team leader in this route:** only the manager **assign/unassign path for their own effective team** — candidates come from the team-scoped projection, the target manager must be an effective member of that same team, assign requires an active project, and unassign stays available for an open assignment even when the project is inactive.
- **Team leader cannot** create, rename, activate or deactivate a project, or edit project metadata: those controls render only when the server projection returns `can_manage_project_master`, and the project-master RPCs additionally **deny** the leader server-side.
- **Accounting / catalog operator keeps** project master create/update/set-active and all-project manager-assignment authority (C01 §2.2, J00 matrix). The leader predicate must never widen into that path.
- **Menu visibility does not replace the RPC guard.** Every project-master and assignment mutation keeps its own server authorization; a forged direct URL or RPC call for another team, for project master, or for security administration fails server-side.

## 4. Backend dependencies (contract requests for W01B/W01C/W02/W03)

| Screen | Required projection / mutation (bounded; reason + OCC + idempotency + audit) | Wave |
|---|---|---|
| Personnel list/detail | personnel list/get incl. personnel_code, position, active, provider membership, team membership intervals, verified-link presence; create/update/set-active; membership assign/move/unassign (half-open) | W01B |
| Team list/detail | team list/get incl. roster + current/historical leader interval; team create/update/set-active | W01B |
| Leader designate/revoke | one atomic designate/revoke that closes the outgoing leader interval before opening the incoming one, and writes the `team` scope grant + `team_manager_assign` interval together with one reason and one audit event; separate explicitly-invoked revoke | W01C |
| Project master | existing P2.5 `list/get/create/update/_set_project_active` — guard split only | W02 |
| Leader assignment | assignment list/get and candidate list **scoped to the leader's effective team**, assign/unassign (assign requires active project; unassign allowed on inactive; already-closed replays as no-op) | W02 |
| Vendor | vendor list/get/create/update/set-active; `vendor_id` immutable, `display_name`/`active` mutable; atomic canonical recruiter/provider representation; never a team membership | W02 |
| Labor type | labor-type list/create/update/set-active (immutable key, editable label/order/active) + **one active-value projection** consumed by Direct Entry, change requests, Excel/CSV import+template, filters and reporting | W02 |
| Accounts / grants / links | Admin-only app-user list/get, enable/disable, capability+scope interval grant/revoke, verified recruiter-link mutations; revocation-safe reads | W03 |
| Audit | mode-scoped bounded audit projection (§3.1): Admin `full`, catalog operator `catalog`, leader own assignment events, others none | W03 |
| Restore | `entry_restore` server path + restoreable-item projection (Admin only) | W03 |

Capability/nav predicate contract (item 5): `catalog_operator` = `catalog_master_manage` + effective `all` (Admin **and** Accounting); `admin_security` = existing `adminAuthorityNavPredicate` (AND of `entry_admin`, `recruiter_master_manage`, `team_master_manage` at `all`); `admin_area` = `catalog_operator` ∨ `admin_security`; `project_operations` = project admin ∨ catalog operator ∨ team leader (§3.2). Accounting must not inherit `admin_security`; a leader must not inherit `catalog_operator` or the project-admin path. Each route keeps its own server page decision and each RPC keeps its own guard.

## 5. Interaction states

- **Reason**: every mutation form requires a non-empty reason and shows it in the dialog, not as a toast.
- **OCC**: every request carries the entity's `expected_version` and, for assignments, `expected_project_version`; a version conflict raises the conflict banner, **locks writes on that surface** until an authoritative reload succeeds, then unlocks with the freshly loaded version.
- **Idempotency**: one client-generated key per user intent; a retry reuses the same key, a new intent generates a new one.
- **No hard delete**: activate/deactivate only. Deactivation removes the row from new-entry choices; history stays readable and referenced rows can never be deleted.
- **Effective dates**: membership and leader intervals are half-open; the UI shows current / scheduled / history separately (reuse the `splitAssignments` 3-way pattern) and never rewrites past intervals.
- **States per list**: `loading` (info), `empty` (info, distinct from success), `denied` (AccessDenied page or section-local denial), `unavailable`/`error` (red + retry), `stale/conflict` (amber banner + reload). A failed load-more keeps the loaded rows and shows a red alert with retry.
- **Denied vs empty**: a capability denial is never rendered as `0 rows`.

## 6. File/symbol map

**W04 — catalog administration UI**

| Action | File | Symbol |
|---|---|---|
| edit | `src/lib/navigation/registry.ts` | `NAV_ENTRIES` + **exactly one** `admin` entry (`capability: "admin_area"`); no per-section entries |
| edit | `src/lib/navigation/registry-capability.ts` | add `catalogOperatorNavPredicate`, `adminSecurityNavPredicate` (existing admin triple), `adminAreaNavPredicate`, `projectOperationsNavPredicate` (3-way, §3.2); register the keys in `NAV_CAPABILITY_PREDICATES` |
| edit | `src/lib/auth/direct-entry-page-access.ts` | add `decideAdminAreaAccess`, `decideAdminSectionAccess(section)`, `decideAdminAuditAccess` (mode-aware §3.1); extend `decideProjectOperationsPageAccess` to the 3-way predicate |
| add | `src/app/admin/layout.tsx`, `src/app/admin/page.tsx` | Admin shell (AppShell + internal sub-nav) and landing |
| add | `src/components/admin/admin-subnav.tsx` + `src/lib/admin/admin-section-model.ts` | internal Admin navigation; pure allowed-section list from the server projection |
| add | `src/app/admin/catalog/{personnel,teams,vendors,labor-types}/page.tsx` | server pages: gate → fetch → client view |
| add | `src/components/admin/catalog/{personnel-list,personnel-detail,team-list,team-detail,leader-panel,vendor-list,labor-type-list}.tsx` | client views |
| add | `src/components/admin/shared/{admin-table,admin-toolbar,row-actions,reason-dialog,deactivate-dialog,interval-history,entity-state-badge}.tsx` | primitives **extracted** from `project-operations.tsx`, not copied |
| edit | `src/components/direct-entry/project-operations.tsx` | consume `can_manage_project_master` / `can_assign_managers`; leader mode (team-scoped candidates, unassign on inactive project, assignment audit detail per §3.1); keep all OCC/idempotency code |
| add | `src/lib/admin/{personnel,team,vendor,labor-type}-model.ts` | pure validators/builders/parsers + `node:test` units (mirror `project-operations-model.ts`) |
| add | `src/app/api/admin/catalog/{personnel,teams,leaders,vendors,labor-types}/**/route.ts` | thin handlers: session → repository → projector |
| edit | `src/lib/direct-entry/direct-entry-grid-columns.ts` | `DIRECT_ENTRY_LABOR_TYPE_OPTIONS` from the active-value projection |
| edit | `src/components/direct-entry/direct-entry-live.tsx`, `direct-entry-spreadsheet-grid.tsx` | label↔key resolution from the projection; remove hard-coded label branching |
| edit | `src/components/direct-entry/direct-entry-change-request-proposer.tsx`, `direct-entry-change-request-reviewer.tsx`, `src/lib/direct-entry/change-request-reviewer.ts` | consume the projection instead of `LABOR_TYPE_LABELS` |
| edit | `src/lib/direct-entry/{excel-paste,excel-paste-import,live-controller,change-request-contract,privileged-edit-api}.ts`, `src/lib/contracts/direct-entry-v1.ts` | widen `LaborType` + validators + import aliases to the catalog; unknown/inactive fail closed on write |

**W05 — access, audit and restore UI**

| Action | File | Symbol |
|---|---|---|
| add | `src/app/admin/access/{accounts,audit,restore}/page.tsx` | server pages with `admin_security` (audit additionally `catalog_operator`) |
| add | `src/components/admin/access/{account-list,account-detail,grant-intervals,recruiter-link-editor,audit-explorer,audit-row-detail,restore-dialog}.tsx` | client views; `audit-explorer` takes the server `mode` and never derives it |
| add | `src/lib/admin/{account-access-model,audit-model,restore-model}.ts` | pure projection/parse/validate units, mode-scoped for audit |
| add | `src/app/api/admin/access/{accounts,grants,links,audit,restore}/**/route.ts` | Admin-only handlers; audit route returns the mode-scoped payload |

## 7. Not to be reused, and why (unchanged)

| Rejected | Reason |
|---|---|
| `direct-entry-grid*` / `react-data-grid` (`direct-entry-spreadsheet-grid.tsx`, `grid-smoke.tsx`) | A keyboard-driven editable batch-entry spreadsheet with local draft state and paste semantics. Catalog administration is row-level CRUD with OCC/conflict dialogs; reusing the grid imports the wrong interaction model and a second validation path. |
| `direct-entry-live.tsx` | Bulk staged entry workflow; no per-row OCC/audit story, and it is a *consumer* of the labor-type catalog, not a base for admin screens. |
| `direct-entry-change-request-{list,reviewer,proposer}.tsx` as an audit/diff viewer | It is a decision workflow over proposals (approve/reject/withdraw). Audit needs an immutable, mode-scoped event projection; reusing these components would misrepresent audit as a pending approval. |
| `dashboard/*` chart/panel components | Reporting visualisation, not entity administration; only the shared primitives are reused. |
| `DemoDirectEntryShell`, `/pipeline-check` remnants, AI settings panels | Demo/retired/deferred surfaces; AI stays off per the P3.1 scope warning. |
| `UserSessionControl` as an account-management surface | Session identity only, owned by the session lane; account administration belongs to `/admin/access/accounts`. |
| Any new form/state/grid/table/design-system package | The existing primitives cover every screen above (E8). **No new dependency** is proposed. |

## 8. Risks and deferred items

- **Backend still gating W04.** The token vocabulary is on main (§0), but the catalog/leader/project guards and the RPCs of W01B/W01C/W02 do not exist; W04 cannot wire screens against contracts that are not there.
- **Labor-type consumer switch is cross-cutting (E10, 11+ files)** and includes string comparisons on display labels; it must ship as one reviewed package with regression tests or Direct Entry and reporting will disagree.
- **`project-operations.tsx` is already ~1000 lines.** Leader mode plus an admin area will duplicate dialog/table code unless the `admin/shared/*` extraction happens first.
- **Leader UX must be server-projected.** `can_manage_project_master`/`can_assign_managers` and the audit `mode` come from the server; a client-side capability or role check would violate C01 and the P3.1 gate.
- **Audit scope is a security boundary, not a filter.** If the audit endpoint ever returns security-admin events to a catalog operator and the UI hides them, that is a leak. The mode must be enforced server-side (§3.1).
- **Navigation fan-out.** The Admin area must stay one top-level entry with internal sub-navigation; per-section AppShell entries would crowd the shell and invite per-screen predicates that drift from the server decision.
- **Open item for T0:** whether `/admin` needs its own feature flag (mirroring `DIRECT_ENTRY_UI_ENABLED`) or is gated purely by capability predicates with `notFound` when disabled.
- **Deferred:** account invitation/creation and forced reset (P3.2), co-leaders / simultaneous leaders per team (locked out in P3.1), project metadata beyond contracted fields, Team Dashboard changes, `pii_export`, and all browser/mobile UAT (Owner only).
- **Responsive/a11y (no browser run):** reuse the mobile-safe dialog sizing, sticky header/footer, focus return, tablist keyboard pattern, labelled controls, `role="alert"` for errors and `role="status"` for info, `sr-only` table captions, and the no-horizontal-overflow table wrapper. Acceptance is by source/unit tests plus Owner UAT.

## 9. Boundary

No source, migration, API, dependency, navigation or UI implementation was changed in this task; the only artifact is this survey. `docs/P3.1.md`, `package.json` and every source file are untouched. No browser, CUA or screenshot was used; no Production DB, migration apply or deploy was performed. W04A is **not** started.
