# W2-S0-A — Wave 2 UI Reuse Survey

> **Status:** `W2_S0_A_UI_REUSE_SURVEY_PASS_AWAITING_T0_REVIEW`
> **Type:** docs-only survey. No implementation, no source change, no migration,
> no API/RPC/schema change, no mock API, no new dependency, no browser/UAT.
> **Deliverable:** this file only.

## 0. Preflight

- Remote `origin` fetched (`git fetch origin --prune`) before starting.
- **Current `origin/main`:** `7afc02632f83a4cddff7ddfe75f7eb5308f1a969`
  (`perf(ci): isolate PostgreSQL and balance PGlite shards (#7)`).
- **Worktree:** `C:\CodeApp\BI-w2-s0-a-ui-reuse-survey`
- **Branch:** `audit/w2-s0-a-ui-reuse-survey` (created from `origin/main`);
  upstream intentionally left unset.
- **Primary checkout:** not touched (it is on another branch with its own
  uncommitted work; this survey never wrote to it).
- **Migration slot:** none reserved; no migration file added or referenced.
- No `W2S*`/Wave-2 plan document exists in the repo (`docs/` has P0–P4 and
  `master-plan.md` only), so the W2S1–W2S5 scope is taken verbatim from the T0
  brief.
- No rebase is performed; T0's `30d9864`→`7afc026` advance is already the base.

---

## 1. Current UI truth (exact file/symbol references)

### A. W2S1 — Worker Portrait

**A1. New-entry Direct Entry screen**

| Path | Symbol(s) | Purpose |
|---|---|---|
| `src/components/direct-entry/direct-entry-live.tsx` | `DirectEntryLive()` (L304) | Live entry session: spreadsheet + side panels; owns the document-dialog trigger, payment editor and CCCD status plumbing. |
| `src/components/direct-entry/direct-entry-shell.tsx` | `DirectEntryShell({mode})` (L286) | Demo/live shell wrapper. |
| `src/components/direct-entry/direct-entry-spreadsheet-grid.tsx` | `DirectEntrySpreadsheetGrid` (L647); `SPREADSHEET_GRID_ARIA_LABEL` (L77); `DIRECT_ENTRY_GRID_ZOOM_LEVELS`/`DEFAULT_ZOOM`/`BASE_ROW_HEIGHT` (L84-92); `spreadsheetSelectOptions` (L183); `spreadsheetColumnIndex` (L209) | The 18-column grid, zoom levels, select columns. |
| `src/components/direct-entry/direct-entry-compact-panel.tsx` | `DirectEntryCompactPanel` (L20) | Compact (mobile) panel shell with count badges. |
| `src/lib/direct-entry/live-controller.ts` | `LiveDraftRow` | Draft-row model consumed by the documents dialog (`row.entryId/rowId/entryVersion/workerName/employeeCode`). |
| `src/lib/direct-entry/direct-entry-grid-columns.ts` | column registry | Grid column contract. |

**A2. Edit / change-request (propose + review) for a worker**

| Path | Symbol(s) | Purpose |
|---|---|---|
| `src/components/direct-entry/worker-operations.tsx` | `WorkerOperations` (L144); `WorkerScopeTab` (L95); `ProposeDrawer` (L856); `WorkerTable` (L706); `SubmissionTable` (L680); `LoadMore` (L666); `EntryBaseline` (L789) | The worker-relationship screen: tabs `recruited\|managed\|all`, worker table, submission table, change-request list, and the propose/correction drawer. |
| `src/components/direct-entry/direct-entry-change-request-proposer.tsx` | `DirectEntryChangeRequestProposer` (L141) | Propose changes; uses `RecruiterTypeahead` (L565). |
| `src/components/direct-entry/direct-entry-change-request-reviewer.tsx` | `DirectEntryChangeRequestReviewer` (L86) | Approve/reject with reason. |
| `src/components/direct-entry/direct-entry-change-request-list.tsx` | `DirectEntryChangeRequestList` (L186) | Queue list. |
| `src/lib/direct-entry/change-request-proposer.ts`, `change-request-reviewer.ts`, `change-request-proposal-builders.ts`, `change-request-read-projection.ts`, `change-request-read-contract.ts` | pure models/projections | Request building, strict read projections, `LEAVE_REASON_HIDDEN_MESSAGE`. |
| `src/lib/direct-entry/privileged-edit-*`, `src/app/api/direct-entry/entries/[entryId]/privileged-edit/route.ts` | privileged correction boundary | Admin-level correction path. |

**A3. Document uploader**

| Path | Symbol(s) | Purpose |
|---|---|---|
| `src/components/direct-entry/direct-entry-worker-documents.tsx` | `DirectEntryWorkerDocuments` (L40) | **One** Radix `Dialog` ("Hồ sơ NLĐ", `data-testid="worker-documents-dialog"`) containing CCCD + employment contract. Mounted per `entry_id`. |
| `src/components/direct-entry/direct-entry-cccd-manager.tsx` | `DirectEntryCccdManager` (L76) | Two-slot CCCD upload (FRONT/BACK): per-slot file picker, progress (`cccdProgressLabel`), status, retry-still-failed-slot, mandatory replacement reason when `requireReason`. |
| `src/components/direct-entry/direct-entry-document-editor.tsx` | `DirectEntryDocumentEditor` (L72); internal `statusLabel`, `friendlyError` | Generic single-`DocumentType` uploader: reserve → presigned `PUT` → finalize, idempotency key, 409 conflict, reason (`requireReason`), `<a download>` link. |
| `src/components/direct-entry/direct-entry-submitted-document-manager.tsx` | `DirectEntrySubmittedDocumentManager` (L43) | Post-submission document management. |
| `src/lib/direct-entry/document-detail-projection.ts` | `DETAIL_DOCUMENT_TYPES` (`CCCD_FRONT`/`CCCD_BACK`/`EMPLOYMENT_CONTRACT`), `DocumentDetailSummary`, `EntryDetailProjection`, `isDetailDocumentType`, `projectEntryDetail`, `fetchEntryDetail` | Strict allow-list entry-detail projection (one `GET` per open; fail-closed). |
| `src/lib/direct-entry/cccd-document-pair.ts` | `CCCD_DOCUMENT_TYPES`, `CCCD_SLOT_LABELS`, `CCCD_MAX_BYTES`, `CCCD_MIME_TYPES`, `CccdDocumentSummary`, `cccdSlotComplete`, `cccdProgressLabel`, `buildCccdUploadPlan`, `cccdIntentFingerprint` | Pure CCCD pair rules (MIME/10 MiB from the contract, not duplicated). |
| `src/lib/direct-entry/cccd-upload-runner.ts` / `cccd-transport.ts` | `runCccdUpload`, `sha256HexFromBytes`, `EMPTY_CCCD_KEY_STATE`, `createCccdTransport` | Upload runner (Web Crypto SHA-256 fingerprint, transport). |
| `src/lib/direct-entry/r2-document-storage.ts` | `R2Config`, `DocumentObjectStorage`, `SignedDocumentUrl`, `createR2DocumentStorage`, `loadR2Config`, `unavailableDocumentObjectStorage`, `DOCUMENT_BUCKETS` (per-env) | Private object storage + presigned PUT/GET (AWS SDK v3). |

**A4. Image preview — DOES NOT EXIST.** There is no `<img>`, `next/image`,
`object-contain`, lightbox, image zoom or full-screen viewer anywhere in `src/`
(only an unrelated test fixture string and a test asserting the dashboard must
**not** import `next/image`). The only "view" affordance is the
`<a download>` link in `DirectEntryDocumentEditor` targeting
`/api/direct-entry/entries/[entryId]/documents/[documentId]/download`
(`GET`, `runtime="nodejs"`, `dynamic="force-dynamic"`, `Cache-Control: private, no-store`).

**A5. Original vs current vs additional image for a pre-existing worker.** No
such concept exists. Images are modelled only as multiple `DocumentDetailSummary`
rows per `DocumentType`, distinguished by `version` + `upload_status` /
`validation_status` / `scan_status`; `document-editor.statusLabel` already maps a
`SUPERSEDED` state. There is **no** "original vs current portrait", no
"additional photo", no biometric/portrait field, and no per-worker image gallery.

**A6. Dialog/drawer primitives.** Radix UI (`radix-ui@1.6.7`):
`Dialog` in `direct-entry-worker-documents.tsx`, `worker-operations.tsx`
(`ProposeDrawer`), `project-operations.tsx`; `AlertDialog` in
`direct-entry-duplicate-cccd-dialog.tsx` and `direct-entry-submission-list.tsx`.
Styling via `src/components/direct-entry/direct-entry-shell.module.css`
(`drawerOverlay`, `documentsDialog`, `drawerFields`, `drawerActions`,
`confirmDialog`, `cccdSlot`, `filePickerControl`/`filePickerInput`/`filePickerButton`).
No shared `src/components/ui/*` dialog wrapper exists — `src/components/ui/` has
only `card.tsx` and `alert.tsx`.

**A7. Responsive/mobile + a11y (existing patterns to mirror).** `onCccdStatus`
feeds a mobile card summary; `aria-labelledby` per section; `role="status"`
(`aria-live="polite"`) for progress/messages and `role="alert"` for failures;
`aria-busy` on async buttons; `focus-visible:ring-2 ring-ring/40`; `sr-only`
captions on tables; `min-w-[560px]`/`min-w-[760px]` inner-scroll tables inside
`overflow-x-auto` wrappers.

### B. W2S2 — Accountant Assignment

| Path | Symbol(s) | Purpose |
|---|---|---|
| `src/components/direct-entry/project-operations.tsx` | `ProjectOperations` (L125); `Field` (L95); `ReasonField` (L927); `DialogActions` (L945); `SummaryMetric` (L961); `ProjectStatusBadge` (L981); `AssignmentGroup` (L994) | The existing PM-assignment admin screen: project list + search + status filter + pagination, project detail, and Radix dialogs for create/rename/active/**assign**/revoke. |
| `src/components/direct-entry/project-operations.tsx` (assign dialog, L792-920) | inline candidate combobox: `role="combobox"`, `role="listbox"` (`#manager-candidate-list`), `role="option"` + `aria-selected`, `activeCandidateIndex`, `type="date"` (`#manager-from`), reason field | **Effective-date + candidate + reason** flow. |
| `src/lib/direct-entry/project-operations-model.ts` | `REASON_MAX`, `ProjectView`, `AssignmentView`, `ProjectDetailView`, `parseProject/parseAssignment/parseListResponse/parseDetailResponse`, `validateReason`, `validateDate`, `validateVersion`, `validateUuid`, `newIdempotencyKey`, `buildCreateRequest/buildRenameRequest/buildSetActiveRequest/buildAssignRequest/buildUnassignRequest`, `classifyResponse`, `executeProjectRequest`, `splitAssignments` (current/future/history), `ManagerCandidate`, `candidateLabel`, `filterProjects`, `paginateProjects` | **The single closest analogue for W2S2** — OCC + reason + idempotency + outcome taxonomy + 3-way assignment split. |
| `src/lib/direct-entry/project-admin-contract.ts` | `AdminProject`, `AdminAssignment`, `AdminProjectList`, `AdminProjectAssignments`, `AdminProjectDetail`, `AdminProjectMutation`, `AdminAssignmentMutation`, `AdminManagerCandidate(s)`, `projectAdmin*` projections | Strict server projections (fail-closed exact-key). |
| `src/lib/direct-entry/project-admin-api.ts`, `project-admin-repository.ts` | API + RPC boundary | `RPC + route` layer for the above. |
| `src/components/direct-entry/typeahead-picker-smoke.tsx` | `RecruiterTypeahead` (L23), `PickerOption`, `TypeaheadPickerSmoke` | **Reusable account/recruiter combobox** (real, in production use — see below). |
| `src/lib/direct-entry/typeahead.ts` | `TypeaheadOption`, `matchTypeaheadIds` (NFC + `vi` locale), `typeaheadKeyAction` (IME-composition aware), `moveTypeaheadIndex`, `resolveTypeaheadSelection` | Pure typeahead logic. |
| `src/lib/admin/admin-navigation.ts` | `AdminSection`, `ADMIN_SECTIONS` (personnel/teams/vendors/labor-types/accounts), `isAdminSectionActive`, `visibleAdminSections` | Admin nav registry. |
| `src/lib/navigation/registry-capability.ts` | `adminAreaNavPredicate`, `adminSecurityNavPredicate`, `NavActorProjection`, `NavCapabilityPredicate` | Admin page/section predicates. |
| `src/app/admin/**` (`layout.tsx`, `catalog/*/page.tsx`, `access/accounts/page.tsx`) + `src/lib/auth/direct-entry-page-access.ts` | page gates | Server-side access decisions. |
| `src/components/admin/*-manager.tsx` | `PersonnelCatalogManager`, `TeamCatalogManager`, `TeamLeaderManager`, `PersonnelTeamMembershipManager`, `VendorCatalogManager`, `LaborTypeCatalogManager`, `AccountManager`, `AdminSubnav` | Admin manager UI patterns (list/table, dialog, badge, reason+OCC). |

**Reuse warning:** `src/components/direct-entry/project-operations.test.mjs:75`
asserts `project-operations.tsx` must **not** reference `RecruiterTypeahead`
(it has its own candidate picker). `RecruiterTypeahead` is nonetheless used by
`direct-entry-live.tsx` (L2634), `direct-entry-shell.tsx` (L33, L249) and
`direct-entry-change-request-proposer.tsx` (L565).

### C. W2S3 — Salary Request

| Path | Symbol(s) | Purpose |
|---|---|---|
| `src/components/direct-entry/direct-entry-payment-editor.tsx` | `DirectEntryPaymentEditor` (L117) | **Closest existing form**: payment-state select, conditional `provided` block (account number / bank / holder), masked-vs-plaintext by `canView`, mandatory reason, OCC (`expected_entry_version` + `expected_payment_version`), `Idempotency-Key`, 409 server-vs-local conflict resolution. |
| `src/lib/direct-entry/payment-contract.ts` | `PAYMENT_STATES` (`omitted\|unknown\|intentionally_blank\|provided`), `PaymentState`, `PaymentInput`, `PaymentProjection`, `projectPaymentInput(value, activeBankIds?)`, `projectPaymentProjection` (full vs masked), `projectPaymentUpdateResult` | Strict payment projections incl. **bank-id allowlist**. |
| `src/lib/direct-entry/payment-api.ts`, `payment-repository.ts`, `src/app/api/direct-entry/entries/[entryId]/payment/route.ts` | `PATCH` payment | Server boundary. |
| `src/components/direct-entry/worker-operations.tsx` | `WorkerTable` (L706), `WorkerScopeTab`, `EmployeeScope` tabs | Worker picker scoped to `recruited\|managed\|all` (PM-scoped via `worker-directory-api.ts`). |
| `src/lib/direct-entry/worker-directory-contract.ts` / `-api.ts` / `-repository.ts` | `WorkerDirectoryRow`, `WorkerDirectoryFilters` | Worker directory read model. |
| `src/components/direct-entry/direct-entry-submission-list.tsx` | `DirectEntrySubmissionList` (L62), `SubmissionTransitionRequest`, `TransitionOutcome` | Queue/list + `AlertDialog` confirm + acknowledgement payload. |
| `src/components/direct-entry/direct-entry-change-request-reviewer.tsx`, `src/lib/direct-entry/change-request-reviewer.ts` | reviewer + decision model | Approve/reject/reason. |
| `src/lib/ai-report/review-projection.ts` | `projectReviewRequest` (decision `approve\|reject`, `expected_revision_number`, reject reason 3..300) | The strictest existing decision+reason projection. |
| `src/components/reporting/status-badge.tsx` | `StatusBadge({status: RunStatus})` | Badges — **typed to `RunStatus` only**. |
| `src/components/reporting/duplicate-cccd-report-panel.tsx` | `DuplicateCccdReportPanel` (L97) + local `StatusBadge`/`GroupCard` | List/table/pagination + badge pattern. |

**Absent:** any amount/currency input, any `payment_method` / `CASH` /
`BANK_TRANSFER` concept, any salary-request queue/status model. The 4-way
`PaymentState` is a *provision* state, not a *method*.

### D. W2S4 — Proof Review

| Path | Symbol(s) | Purpose |
|---|---|---|
| (see A3) `direct-entry-cccd-manager.tsx`, `direct-entry-document-editor.tsx`, `document-detail-projection.ts`, `r2-document-storage.ts`, `…/documents/route.ts`, `…/finalize/route.ts`, `…/download/route.ts` | private upload + presigned download | Reusable private-document pipeline. |
| `src/components/ui/alert.tsx` | `Alert({tone: info\|warning\|error, title, children, role})` | Callout primitive (info/warning/error). |
| `src/lib/ai-report/review-projection.ts` | `ReviewResult` (`approved\|rejected`), `JOB_STATUSES` (`requested…failed_*`), `projectHistoryResponse`, `projectReviewCapability` (`approve/reject/regenerate`), `REVIEW_RPC_READY/UNAVAILABLE` | Existing AI lifecycle/capability states. |
| `src/lib/ai-report/report-contract.ts`, `report-controller.ts`, `src/components/ai-report/ai-report-panel.tsx` (`AiReportPanel`), `report-view.ts` | AI report UI + strict contract. | |
| `src/components/direct-entry/direct-entry-duplicate-cccd-dialog.tsx` | `DirectEntryDuplicateCccdDialog` (L30), `DuplicateCccdDialogProps` | **Closest acknowledgment pattern**: Radix `AlertDialog` with Cancel = "Quay lại kiểm tra", Action = "Vẫn trình duyệt", `aria-busy`. |
| `src/lib/direct-entry/submission-duplicate-cccd-contract.ts` | `acknowledgement: {fingerprint, count}`, `duplicateCccdModal*` copy helpers | Server-fingerprint acknowledgement contract. |
| `src/lib/direct-entry/change-request-read-projection.ts` | before/after field diff rows (`before`/`after`, `HIDDEN`) | The only **side-by-side**-style comparison data (field-level). |
| `src/components/ui/card.tsx`, `src/components/dashboard/*` | `Card`, `CardHeader`, grid classes | Layout primitives for a comparison view. |

**Absent in W2S4:** image preview, zoom/full-screen, side-by-side **image**
comparison, cash-vs-bank evidence layout, and the AI risk states
`LOW_SYNTHETIC_RISK` / `REVIEW_REQUIRED` / `INCONCLUSIVE` / `UNAVAILABLE`
(grep confirms zero occurrences; the existing AI vocabulary is
`approved/rejected/draft` + job `failed_*` codes). No checkbox-style
"acknowledge" control exists — only `AlertDialog` confirmation.

### E. W2S5 — Summary

| Path | Symbol(s) | Purpose |
|---|---|---|
| `src/components/dashboard/kpi-card.tsx` | `KpiCard({label,value,hint,accent,variant:"default"\|"compact"})` | KPI card. |
| `src/components/reporting/summary-card.tsx` | `SummaryCard({label,value,hint})` | Small summary card. |
| `src/components/ui/card.tsx` | `Card`, `CardHeader({title,description})` | Card primitive. |
| `src/components/dashboard/dashboard-filters.tsx` | `DashboardFilters({options, showRecruiter})` | nuqs filter bar: quick presets, "Tất cả thời gian", advanced panel, active-criteria count. |
| `src/lib/reporting/p1-date-presets.ts` | `ALL_TIME_KEY`, `DatePreset`, `computeDatePresets`, `matchDatePreset`, `isAllTimeActive`, `countActiveFilterCriteria`, `todayInHoChiMinh` | 7 presets (7d/this-week/last-week/this-month/last-month/this-quarter/last-quarter), Asia/Ho_Chi_Minh. |
| `src/components/reporting/status-badge.tsx`, `source-status-table.tsx`, `empty-state.tsx`, `error-state.tsx` | `StatusBadge`, `SourceStatusTable`, `EmptyState`, `ErrorState` | Status/table/state primitives. |
| `src/components/dashboard/*` | `DashboardView`, `BodDashboardTabs`, `TeamReportView`, `TeamDashboardView`, `OwnDashboardView`, `TrendChart`, `ProjectDonut`, `ProviderDonut`, `RecruiterBarChart`, `EmploymentComposition`, `TeamBucketChart`, `ProjectProviderMixCard`, `ChartTooltip`, `SourceStatusBar/Table`, `dashboard-shared` (`FiltersOrError`, `NoMatchesBlock`, `ScopeNote`, `BucketList`) | The whole existing reporting UI. |
| `src/lib/reporting/p1-chart-data.ts`, `p1-dashboard.ts` | `stableColorForKey`, `buildCategorySegments`, `buildBarData`, `buildProjectDonutData`, `buildProjectProviderMix`, `buildDailyTrend`, `sortBuckets` | Chart view-models (recharts `^3.10.1`). |
| `src/lib/theme/theme-registry.ts` | color slots (`chart-1..8`, semantic) | Theme tokens. |
| `src/app/dashboard/page.tsx` → `src/lib/reporting/p2-w04a-reporting-server.ts` → `src/lib/reporting/p1-reporting.ts` | `ReportingData` | Data flow for any summary screen. |

**Absent:** no weekly/monthly bucketing helper (only `buildDailyTrend`); presets
give week/month *ranges*, not period buckets. No new chart system is needed —
recharts + the existing wrappers suffice.

---

## 2. Call / component graph

```
/direct-entry (page)                      /dashboard (page)
  DirectEntryShell(mode)                    DashboardView (server audience dispatch)
    DirectEntryLive (grid + panels)           ├─ BodDashboardTabs ── TeamReportView … (W06D)
      ├─ DirectEntrySpreadsheetGrid           ├─ TeamDashboardView ─ TeamReportView
      ├─ RecruiterTypeahead (typeahead.ts)    └─ OwnDashboardView
      ├─ DirectEntryWorkerDocuments (Dialog)        └─ Card/KpiCard/Charts/StatusBadge
      │    ├─ DirectEntryCccdManager  ── cccd-document-pair + cccd-upload-runner + cccd-transport
      │    └─ DirectEntryDocumentEditor ─ document-detail-projection
      ├─ DirectEntryPaymentEditor ─ payment-contract
      └─ DirectEntrySubmissionList
           ├─ AlertDialog (transition confirm)
           └─ DirectEntryDuplicateCccdDialog (AlertDialog + acknowledgement)

/direct-entry/workers (page)              /direct-entry/projects (page)
  WorkerOperations (tabs)                   ProjectOperations
    ├─ WorkerTable / SubmissionTable          ├─ (inline candidate combobox)
    ├─ DirectEntryChangeRequestList           ├─ Field / ReasonField / DialogActions
    ├─ ProposeDrawer (Dialog)                 ├─ ProjectStatusBadge / AssignmentGroup
    └─ DirectEntryChangeRequestReviewer       └─ project-operations-model
         └─ change-request-* models

/admin/* (layout gate) → AdminSubnav / admin-navigation + registry-capability
  ├─ PersonnelCatalogManager / TeamCatalogManager / TeamLeaderManager
  ├─ PersonnelTeamMembershipManager / VendorCatalogManager / LaborTypeCatalogManager
  └─ AccountManager
```

---

## 3. Reuse matrix

| Capability | Reuse unchanged | Extend | New sibling | Do NOT reuse |
|---|---|---|---|---|
| W2S1 entry grid & shell | `DirectEntrySpreadsheetGrid`, `DirectEntryShell`, `DirectEntryCompactPanel`, `live-controller` | — | — | — |
| W2S1 worker edit/propose | `change-request-*` models/projections; `ProposeDrawer` structure | `WorkerOperations` drawer to surface a portrait target | portrait-specific field group | — |
| W2S1 document upload | `DirectEntryDocumentEditor` (generic single-type), `DirectEntryCccdManager`, `document-detail-projection`, `cccd-*`, `r2-document-storage` | add a portrait `DocumentType` to `DETAIL_DOCUMENT_TYPES` + `DOCUMENT_TYPES` | — | copying the uploader |
| W2S1 dialogs/drawers | Radix `Dialog` + `direct-entry-shell.module.css` classes | — | a shared `ui/dialog` wrapper only if T0 wants one (not required) | manual focus traps |
| **W2S1/A4 image preview** | — | — | **new** portrait preview/thumbnail sibling (nothing exists) | — |
| W2S1 original/current/additional | `version` + `upload_status` + `SUPERSEDED` label | add explicit "original/current/additional" grouping over the version list | small grouping helper | inventing biometric concepts |
| W2S2 assignment flow | `project-operations-model` (request builders, OCC, reason, `classifyResponse`, `splitAssignments`, `paginateProjects`) | repoint `manager_recruiter_id` → accountant subject; adjust labels | accountant candidate picker**sibling** | `project-operations.tsx` verbatim (its candidate picker is inline, and its test forbids `RecruiterTypeahead`) |
| W2S2 picker | `typeahead.ts` (pure) | `RecruiterTypeahead` → generalise to an `EntityTypeahead` sibling (label/providers) | `AccountantTypeahead` sibling | importing `RecruiterTypeahead` into `project-operations.tsx` |
| W2S2 effective-date editor | `type="date"` + `validateDate` | extract a small `EffectiveDateField` | — | a date library |
| W2S2 OCC/conflict/reason | `classifyResponse` (`reload-required`), `validateReason`, `ReasonField`, `DialogActions`, `newIdempotencyKey` | reuse as-is | — | bespoke conflict handling |
| W2S2 nav/access | `admin-navigation`, `registry-capability` predicates, `src/app/admin/**` | add one `ADMIN_SECTIONS` entry + predicate | — | client-side authority |
| W2S3 worker picker | `worker-directory-*` + `WorkerOperations` tab/table | scope selector reuse | — | new directory read |
| W2S3 amount/method form | `DirectEntryPaymentEditor` **as the structural template** | add amount + method fields | `SalaryMethodFields` sibling (CASH/BANK_TRANSFER conditional) | assuming an amount input exists |
| W2S3 bank selector + holder | `payment-contract` (`projectPaymentInput(activeBankIds)`, masked projection), bank `<select>`, `DraftCatalog["banks"]` | reuse `PaymentInput` shape | — | duplicating the bank allowlist |
| W2S3 queue/list/status | `duplicate-cccd-report-panel` (list+pagination), `DirectEntrySubmissionList`, `EmptyState`/`ErrorState` | make `StatusBadge` generic (see risks) | `RequestStatusBadge` sibling | `StatusBadge` for non-`RunStatus` values |
| W2S3 approve/reject/reason | `projectReviewRequest` (decision+expected_version+reason), `change-request-reviewer`, `AlertDialog` | — | — | custom decision protocol |
| W2S4 private upload/preview | `document-*`, `cccd-*`, `r2-document-storage`, `…/download/route.ts` | add a same-origin **preview** route/`<img>` sibling | `ProofImagePreview` sibling | embedding signed URLs / storage keys in the DOM |
| W2S4 side-by-side / zoom / fullscreen | — | — | **new** comparison + zoom siblings | — |
| W2S4 cash vs bank evidence layout | `Card`/grid classes; `change-request-read-projection` diff pattern as inspiration | — | evidence-layout sibling | putting the bill next to the face on mobile |
| W2S4 AI badges/callouts | `Alert` (info/warning/error) | add a risk-state → tone/label map | `AiRiskBadge` sibling | reusing `StatusBadge` (`RunStatus`) for risk states |
| W2S4 acknowledgment/override reason | `DirectEntryDuplicateCccdDialog` (AlertDialog), reason fields, `acknowledgement {fingerprint,count}` | reuse pattern; add an explicit override-reason field | — | submit-without-acknowledgement |
| W2S5 summary | `KpiCard`, `SummaryCard`, `Card`, `DashboardFilters`, `computeDatePresets`, `SourceStatusTable`, `Empty/ErrorState`, charts, `p1-chart-data`, theme slots | add daily/weekly/monthly bucketing helper | `PeriodSummary` view sibling | any new chart library |

---

## 4. Exact smallest future T1A file touch set per W2S

*(Survey only — no files are touched now. This is the anticipated minimal set.)*

**W2S1 — Worker Portrait**
- `src/lib/contracts/direct-entry-v1.ts` — extend `DocumentType` with a portrait type (contract, T1B-owned if server-side).
- `src/lib/direct-entry/document-detail-projection.ts` — add the portrait type to `DETAIL_DOCUMENT_TYPES`.
- `src/components/direct-entry/direct-entry-document-editor.tsx` — allow the portrait `DocumentType` list.
- `src/components/direct-entry/direct-entry-worker-documents.tsx` — add the portrait section inside the existing dialog.
- **new** `src/components/direct-entry/portrait-preview.tsx` (or `…/worker-portrait-panel.tsx`) — preview + original/current/additional grouping (**no image preview exists today**).
- **new** `src/lib/direct-entry/worker-portrait.ts` — pure grouping/masking rules.
- **new/extended** focused test file(s) `src/components/direct-entry/*portrait*.test.mjs`.

**W2S2 — Accountant Assignment**
- `src/lib/admin/admin-navigation.ts` — add the sections entry.
- `src/lib/navigation/registry-capability.ts` — add the predicate (or reuse `adminAreaNavPredicate`).
- **new** `src/lib/direct-entry/accountant-assignment-model.ts` (or reuse `project-operations-model.ts` by parameterising) — request builders/validate/outcome.
- **new** `src/components/direct-entry/accountant-assignment.tsx` — screen reusing `Field`/`ReasonField`/`DialogActions` structure.
- **new** `src/components/direct-entry/accountant-typeahead.tsx` — sibling of `RecruiterTypeahead` (do not import it into `project-operations.tsx`).
- `src/app/admin/**` — one page + its API route(s) (T1B-backed).
- Focused tests `src/lib/direct-entry/accountant-assignment-model.test.mjs`, `src/components/direct-entry/accountant-*.test.mjs`.

**W2S3 — Salary Request**
- **new** `src/lib/direct-entry/salary-request-contract.ts` — amount/method projection (mirror `payment-contract.ts`).
- **new** `src/components/direct-entry/salary-method-fields.tsx` — CASH/BANK_TRANSFER conditional sibling.
- **new** `src/components/direct-entry/salary-request-form.tsx` — reuses `DirectEntryPaymentEditor` structure + `ReasonField`.
- **new** `src/components/direct-entry/salary-request-queue.tsx` — reuses the `duplicate-cccd-report-panel` list/pagination pattern.
- **new** `src/components/reporting/request-status-badge.tsx` — sibling (or generalise `StatusBadge`).
- `src/app/api/direct-entry/**` routes (T1B-backed) + focused tests.

**W2S4 — Proof Review**
- **new** `src/components/direct-entry/proof-image-preview.tsx` — `<img>` + zoom/full-screen.
- **new** `src/components/direct-entry/proof-evidence-layout.tsx` — cash vs bank layouts (mobile: never face-next-to-bill).
- **new** `src/components/direct-entry/proof-comparison.tsx` — side-by-side.
- **new** `src/components/reporting/ai-risk-badge.tsx` — `PENDING|LOW_SYNTHETIC_RISK|REVIEW_REQUIRED|INCONCLUSIVE|UNAVAILABLE` → `Alert` tones/labels.
- **new** `src/lib/direct-entry/proof-review-contract.ts` — risk-state projection (fail-closed).
- reuse `DirectEntryDuplicateCccdDialog` pattern for acknowledgment + override reason.
- **new** preview route sibling under `src/app/api/direct-entry/…` if a same-origin byte stream is required (T1B decision).

**W2S5 — Summary**
- **new** `src/lib/reporting/p2-w2s5-period.ts` — daily/weekly/monthly bucketing (pure, Asia/Ho_Chi_Minh, reusing `p1-date-presets` helpers).
- **new** `src/components/dashboard/period-summary.tsx` — reuses `KpiCard`, `TrendChart`, `SourceStatusTable`, `Card`.
- reuse `DashboardFilters` + `computeDatePresets` unchanged.
- focused test `src/lib/reporting/p2-w2s5-period.test.mjs`.

---

## 5. Accessibility contract (existing conventions to preserve)

- **Dialogs/drawers:** Radix `Dialog`/`AlertDialog` only — no hand-rolled focus
  traps. Title + Description are always provided; `Dialog.Close`/`AlertDialog.Cancel`
  are real buttons; Escape/overlay close is Radix-owned. `aria-busy` on the
  in-flight action; the primary action is disabled while busy.
- **Async status:** `role="status"` + `aria-live="polite"` for loading/success
  progress; `role="alert"` for failures and blocked states.
- **Tabs:** `role="tablist"/"tab"/"tabpanel"` + `aria-selected` +
  `aria-controls`/`aria-labelledby` + roving `tabIndex` (see
  `worker-operations.tsx`, `bod-dashboard-tabs.tsx`), Arrow/Home/End keys.
- **Combobox:** `role="combobox"` + `aria-autocomplete` + `aria-expanded` +
  `aria-controls` + `aria-activedescendant`; options `role="option"` +
  `aria-selected`; IME composition handled (`typeaheadKeyAction`).
- **Tables:** `<caption class="sr-only">` + `<th scope="col">`; inner
  `overflow-x-auto` + deliberate `min-w-[…]` (never body-level overflow).
- **Focus:** `focus-visible:ring-2 ring-ring/40`; do not bypass with
  `outline-none` alone.
- **No internal identifiers on the surface:** no `bucket_key`, UUID, storage
  key, signed URL, file name, or raw code in labels/titles/ARIA.
- **Images (new, W2S4):** `<img alt>` must not imply a bill verifies a person's
  face; zoom/full-screen must be keyboard reachable and Escape-closable; the
  mobile layout must not place the face next to the bill as a verification cue.

---

## 6. Loading / error / empty / conflict / retry states

| Concern | Existing pattern to mirror |
|---|---|
| Loading | `role="status"` text (`"Đang tải…"`), `aria-busy` + disabled action, `<progress aria-label>` for uploads; per-tab `state: "loading"` unions. |
| Error | `role="alert"` block or `ErrorState({title, detail})`; **sanitized** messages only, never raw DB/provider codes. |
| Empty | `EmptyState({title, description})`; `NoMatchesBlock` for filtered-empty. |
| Denied/unavailable | Distinct states (`denied` / `unavailable` / `error`) in `DuplicateCccdReportPanel`; `AccessDenied`/`AccountUnavailable`/`TemporaryUnavailable` for page level. |
| Conflict (OCC) | `classifyResponse` → `reload-required`; `DocumentEditor` 409 → `DOCUMENT_VERSION_CONFLICT` + "Tải trạng thái mới"; `PaymentEditor` 409 keeps local draft and offers "Tải bản server"/"Giữ bản local". |
| Retry | Idempotency key held across retries (`Idempotency-Key`, `pendingKey`/`pendingWrite` refs); visible "Thử tải lại" buttons; retry never fabricates data. |
| Reset on scope change | W06D-R3 established the "key the subtree on the filter+selection signature" rule — reuse it for W2S screens so stale data is unmounted, not hidden. |

---

## 7. Acceptance tests & mutation probes (to be written by the future T1A)

Repo convention: **source-contract `.test.mjs`** files (read component/model
source and assert exact fragments) plus pure-logic unit tests, wired into a
focused `test:p3-…` lane and once into the canonical `test` chain.

Suggested per W2S:
- **W2S1:** portrait type present in the allow-lists; preview renders an
  `<img>` with a non-identifying `alt`; original/current/additional grouping
  ordering; no `bucket_key`/storage key/signed URL in the DOM.
- **W2S2:** ledger-guard updates for a new migration (none here) are **not**
  needed; assignment request body carries `expected_project_version` +
  `idempotency_key` + reason; `classifyResponse` maps 409 → `reload-required`;
  accountant picker is a sibling (assert `project-operations.tsx` still has no
  `RecruiterTypeahead`); nav predicate gating.
- **W2S3:** CASH/BANK_TRANSFER conditional field visibility; bank `select`
  options come from the server catalog allowlist; amount validation; masked
  projection when `canView` is false; decision needs `expected_revision_number`.
- **W2S4:** the five risk states map to distinct labels/tones and fail closed on
  unknown values; acknowledgment is required before submit; override reason
  required when overriding; mobile layout assertion (face and bill are not
  siblings); no signed URL/key in props.
- **W2S5:** bucket counts sum to the daily total; week starts Monday;
  month/quarter boundaries in Asia/Ho_Chi_Minh; no new chart import.

**Mutation probes** (make the lane RED, then restore byte-identically and confirm
GREEN): (1) drop the CASH/BANK_TRANSFER conditional; (2) remove the acknowledgment
requirement; (3) collapse two risk states to one label; (4) let `project-operations`
import `RecruiterTypeahead`; (5) revert a week to start on Sunday; (6) render a
storage key/`bucket_key` into a title or `alt`.

---

## 8. Risks / blockers needing a backend contract

1. **W2S1 portrait images** — needs (a) a portrait `DocumentType` (or a new
   image kind) accepted by the DB/storage boundary and the strict projection,
   and (b) a server concept of "original / current / additional" for a
   pre-existing worker. Today only `version` + statuses exist. **Blocked on
   backend contract**; the UI must not invent grouping or call R2 directly.
2. **W2S1 image preview bytes** — the only current access is the authenticated
   `download` route returning a signed URL. A same-origin preview stream (or an
   approved short-lived signed URL passed as a prop) is a **server decision**;
   the client must never receive a bucket name/storage key.
3. **W2S2 accountant identity** — PM assignment keys on
   `manager_recruiter_id`; an accountant may be keyed by app-user/account rather
   than recruiter. The candidate read model and the exact wire keys are
   **T1B-owned**; do not reuse `manager_recruiter_id` blindly.
4. **W2S3 money/method** — there is **no** amount, currency, or
   `CASH/BANK_TRANSFER` contract anywhere. `PaymentInput` is a bank-provision
   shape. Amount/currency precision, method enum, and the salary-request
   lifecycle/statuses are **new backend contracts**.
5. **W2S4 AI risk states** — `PENDING/LOW_SYNTHETIC_RISK/REVIEW_REQUIRED/
   INCONCLUSIVE/UNAVAILABLE` do not exist (existing vocabulary is
   `approved/rejected/draft` + job `failed_*`). Their projection, fail-closed
   behaviour and any override audit field are **backend-owned**.
6. **W2S4 face/bill constraint** — "a bill must not imply it verifies a face" is
   a product/UI rule that also constrains what the backend may return (e.g. no
   pre-combined verification image). Confirm before building the layout.
7. **W2S3/W2S4 status badges** — `StatusBadge` is typed to `RunStatus`
   (`succeeded/partial/failed/running`) and is used by source-status UI.
   Reusing it for salary/risk states would widen a locked type; prefer a sibling.
8. **W2S2 navigation/authority** — adding an admin section touches
   `admin-navigation.ts` + a page-access predicate; the repo pins these in
   several regression lanes (98/98 admin-nav tests today). Any new section must
   keep those green and derive authority server-side only.
9. **No migration slot reserved.** If T1B needs DDL, T0 must allocate the next
   slot from the then-current ledger; W2-S0-A reserves nothing.

---

## 9. Explicit confirmation

- No implementation performed. No `src/**` file, test, `package.json`, API
  route, RPC, schema or migration was created, edited or deleted.
- No mock API, no stub, no placeholder, no dependency added.
- No Production query/apply, no deploy, no browser/UAT, no merge to `main`.
- The only change in this branch is this memo
  (`docs/handoffs/w2-s0-a-ui-reuse-survey.md`).
