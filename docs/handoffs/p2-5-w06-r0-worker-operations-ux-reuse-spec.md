# P2.5-W06-R0 — Worker operations UX reuse spec

**Status:** `P2.5-W06-R0_UX_SPEC_COMPLETE_AWAITING_BACKEND_CONTRACT`

Base `origin/main@60075b17a2b470f0dae6b7ee188822bc72e9578b`. Read-only audit: no source, test,
migration, commit, push or Production change. No capability/DB-schema decision (T1B/T1C own those);
no W03/W06 PASS claim.
## 0. Authority rules (T0 clarification)
- `created_by` decides **historical/uploader listing only**; it conveys **no propose or edit authority**.
- Row actions come from **server-supplied `allowed_actions`**, never inferred on the client.
- `propose_change` is `true` **only when the actor is a current project manager** of that worker's project.
- A recruiter or creator who is **not** also current PM gets a **read-only view** (no propose CTA).
## 1. Surface / component reuse matrix

| Existing surface | File | Verdict | Delta |
| --- | --- | --- | --- |
| Submission list | `direct-entry-submission-list.tsx` | **Reuse presentation/history shell only; authorization and row-action semantics require rebaseline** | Keep list/detail shell for view 1; replace implicit creator-based actions with server `allowed_actions` |
| Persisted drawer | `direct-entry-live.tsx` (drawer) | **EXTEND** | Read-only mode for recruiter/creator; propose CTA only when `propose_change` |
| Spreadsheet grid | `direct-entry-spreadsheet-grid.tsx` | **REUSE AS-IS** | Read-only via empty `editableFields`; no new grid |
| CR proposer | `direct-entry-change-request-proposer.tsx` | **REUSE + RE-ENTRY POINT** | Keep builders; PM audience replaces creator/team predicate (W04) |
| CR reviewer | `direct-entry-change-request-reviewer.tsx` | **REUSE AS-IS** | Accounting/Admin approve-reject + reason already wired |
| CR list | `direct-entry-change-request-list.tsx` | **REUSE** | Add per-worker pending indicator |
| Payment editor | `direct-entry-payment-editor.tsx` | **REUSE** | PAYMENT target kind already exists |
| CCCD / documents | `-cccd-manager`, `-document-editor`, `-worker-documents`, `-submitted-document-manager` | **REUSE, NOT in PM view** | PM sees no file/CCCD action (A08/W07E) |
| Dashboard filters | `dashboard-filters.tsx` | **REUSE PATTERN** | Chip/select UX only; not the reporting option catalog |
| Mobile editor | `direct-entry-live.tsx` cards + quick drawer | **REUSE PATTERN** | Same components desktop/mobile (W06 gate) |
| Auth denied UX | `access-denied.tsx`, `temporary-unavailable.tsx` | **REUSE AS-IS** | Sanitized unmapped/disabled states |
| W05A/W06C dashboard | `dashboard-view.tsx` | **OUT OF SCOPE** | Aggregate reporting, **not** a worker directory |
## 2. Wireflow (text)
**View 1 — "Tôi đã nhập"** (uploader history): `/workers?view=entered` → existing
`GET /api/direct-entry/submissions` → rows with state/version/`submitted_at`/counts → detail.
`created_by` scopes the **listing only**; actions read `allowed_actions`, which today means
**read-only** (`propose_change: false` even if the actor is also the recruiter, unless current PM).

**View 2 — "Tôi tuyển"** (canonical `recruiter_id`): `/workers?view=recruited` →
`GET /api/direct-entry/workers?scope=recruited` (W03) → read-only rows → read-only drawer. Propose CTA
renders **only when the server returns `propose_change: true`**; otherwise absent, code
`PROPOSE_NOT_PROJECT_MANAGER`. Row shows pending badge + `last_decision`.

**View 3 — "Dự án tôi quản lý"** (effective assignment): `/workers?view=managed&project_id=…` →
`scope=managed` (W03) → rows + **"Lập phiếu"** → existing proposer, non-`*` fields + `WORK_STATUS` →
PENDING (canonical unchanged) → Accounting/Admin decision in the existing reviewer → on approve the
row reloads with a new version. Protected fields render read-only.
## 3. Exact UI gaps
- **No worker directory route/page exists** (W01-R1: "no worker directory; W05A is aggregate-only").
- No view switcher keeping the three relationships visually distinct.
- No read-only drawer mode (it currently spins up edit paths); no PM-scoped list.
- No `allowed_actions`-driven row-action model; the UI infers capability locally today.
- No per-row pending indicator, no `last_decision` on the row, no worker-level version-conflict UX.
- No copy distinguishing uploader ≠ recruiter ≠ project manager; filters have no status/audience facet.
- Project CRUD / multi-manager picker does not exist (W02 first).
## 4. Proposed route / component boundaries
- `src/app/workers/page.tsx` — flags + actor via existing `getDirectEntryActor`; reuses
  `decideSessionPageAccess`/`direct-entry-page-access` patterns; server-resolved, never client-claimed.
- `src/components/direct-entry/worker-operations/` — `worker-ops-tabs.tsx`, `-filters.tsx`,
  `-list.tsx`, `-row-actions.tsx`, `-empty.tsx`.
- Reuse, do not fork: grid (read-only), payment editor, proposer, reviewer, CR list, access-denied.
- No new grid/form framework, no second RBAC engine, no client-side authority check as gate.
## 5. API fields the UI needs (proposal to W03/W04 — not a schema decision)
Per row: `entry_id`, `entry_version`, `submission_state`, `employee_code`, `display_name`,
`project_id`, `project_display`, `first_work_date`, `labor_type`, `employment_status`,
`recruiter_id`, `recruiter_display`, capability-gated `payment` (masked), `pending_request`
`{ request_id, state, version }`, `last_decision` `{ state, decided_at }`, and
**`allowed_actions` (incl. `propose_change`)** as the single authority signal. Filters: `scope`,
`project_id`, `recruiter_id`, `employment_status`, `cursor`, `page_size`. Not needed: raw PII
beyond granted capability, storage keys, checksums, signed URLs, `created_by` beyond view 1.
## 6. Accessibility, keyboard, mobile acceptance
- Tabs: `role="tablist"/"tab"/"tabpanel"`, arrows + Home/End.
- Filters: labelled controls; `Escape` clears the focused select; chips are buttons with `aria-pressed`.
- Grid: existing keyboard contract holds read-only; read-only cells focusable, non-editable.
- Drawer: focus trap + return to the row action; `Escape` closes without mutation.
- Row actions: rendered from `allowed_actions`; every denial has a stable code + accessible reason.
- Mobile 390×844: same components, card list, no horizontal overflow, no hover-only action; A19 parity.
## 7. Crosswalk and do-not-rebuild list

| Item | P2 | P3 | P2.5 | Decision |
| --- | --- | --- | --- | --- |
| Reporting cutoff / scoped reporting | W04 | W05A | — | REUSE AS-IS (not a worker directory) |
| Capability 21-token registry | — | W03/C01 | W05 | EXTEND (Accounting bundle) |
| Single-manager project scope | — | W07B | W02 | REBASELINE (backend) |
| Change-request engine | — | W07E | W04 | REUSE; audience predicate changes only |
| Ops worker UI | — | — | **W06** | **NEW (this spec)** |

Do **not** rebuild: change-request engine, capability registry, revision/audit/idempotency tables,
Direct Entry grid, payment editor, document/CCCD flow, Excel import, submission lifecycle,
`WORKER_PROFILE_FIELDS`. A01–A20 (`docs/P2.5.md` §6) map onto these surfaces unchanged.
## 8. Handoff / next
Awaiting W02 (multi-manager) and W03 (worker directory projection) before any UI code. Row-action
semantics stay blocked until `allowed_actions` is server-supplied. W04/W05 refine audience and
approval copy. No implementation in this task.
