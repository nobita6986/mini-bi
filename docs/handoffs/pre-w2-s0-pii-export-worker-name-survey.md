# PRE-W2-S0 — Full-PII worker export & worker display-name correction (reuse/authority survey)

> **Status:** `PRE_W2_S0_PII_EXPORT_NAME_CHANGE_SURVEY_PASS_AWAITING_T0_REVIEW`
> **Current main (base):** `origin/main@caab159eddb920fd60f75153bfa8828f35dfbb7e`
> **Branch / worktree:** `audit/pre-w2-s0-pii-export-worker-name-survey` @
>   `C:\CodeApp\BI-pre-w2-s0-pii-export-worker-name-survey`
> **Preflight (mandatory):** read `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`
>   (external operational memory; last section "2026-10-13 — Pre-W2 hotfix lock").
>   Repo source/contracts win where they disagree with that summary.
> **Document budget:** `DELTA_ONLY`.
> **Survey-only. No implementation, no source/SQL/UI/package change, no migration
>   reserved.** See §7.

---

## 0. Owner decisions (locked)

- **A.** Pre-W2 is one hotfix release before Wave 2.
- **B.** Pre-W2 has two separately reviewable lanes: (1) full-PII XLSX export at
  "Người tôi tuyển / recruited" and "Dự án tôi quản lý / managed"; (2) allow
  proposing a worker display-name change and submit-for-approval at Direct Entry
  "Yêu cầu thay đổi của đợt nhập liệu" and Worker Directory "Đề xuất thay đổi".
- **C.** Export is removed from Wave 2.
- **D.** Owner activates `pii_export` for these use cases only. It may **not** export
  `all` scope, export workers outside recruited/managed authority, bypass
  `pii_view`/`payment_view`, or grant by email/role-name/client input.
- **E.** A name change must still go through a change request + reviewer; no direct
  update, no second name column, no parallel workflow.

---

## 1. Current-main facts

- **Delta from T0 baseline** `cb9b4d3` → current `caab159`: exactly one commit
  `perf(ci): shard test suite across four runners (#5)` (CI-only; no migration,
  source contract or runtime change).
- **Migration ledger:** **85** files; last =
  `20261011180000_p3_w05b_a_team_reporting.sql`. So **#86 is next-available**
  (observation only; §4).
- **W05B-A landed** (#85): the team reporting contract from the R9 rebaseline is
  now implemented on `main`.
- **Primary checkout is NOT used**: it is on `codex/vps-deploy-hardening` with
  uncommitted `deploy/vps/**`, `.github/workflows/**` and `change-password-core.ts`
  changes — untouched by this lane.

---

## 2. SURVEY A — Full-PII XLSX export

### 2.1 Exact call graph (current main)

```
WorkerOperations (src/components/direct-entry/worker-operations.tsx)
  → worker-operations-model.ts  workersQuery()/parseWorkerPageResponse()/proposeCta()
  → GET /api/direct-entry/workers        (src/app/api/direct-entry/workers/route.ts,
                                          runtime="nodejs", dynamic="force-dynamic",
                                          DIRECT_ENTRY_API_ENABLED gate first)
  → worker-directory-api.ts listWorkers()
  → worker-directory-repository.ts createWorkerDirectoryRepository().listWorkers()
        → RPC direct_entry_list_workers(p_auth_subject,p_app_user_id,p_scope,
              p_project_id,p_recruiter_id,p_employment_status,p_cursor,p_page_size)
  → worker-directory-contract.ts projectWorkerDirectoryPage()/projectWorkerDirectoryRow()
  → UI table (worker-operations.tsx: rows + ProposeDrawer)
```

### 2.2 Current directory fields, filters, cursor, scope enforcement

- **Row keys (exactly 18)** — `worker-directory-contract.ts`
  `WORKER_DIRECTORY_ROW_KEYS`: `entry_id, entry_version, submission_state,
  employee_code, display_name, project_id, project_display, first_work_date,
  labor_type, labor_type_display, employment_status, recruiter_id,
  recruiter_display, payment, pending_request, last_decision, is_project_manager,
  allowed_actions`. Payment sub-keys: `state, account_number, bank_id,
  account_holder_name, version`. `allowed_actions`: `view, view_pii, view_payment,
  propose_change, propose_change_code`.
- **No raw PII in the directory.** The RPC only projects `display_name` from
  `worker_details->>'display_name'`; national id / address / phone / DOB / issue
  date / issue place are **never** returned (migration `20261008120000` header
  lines 22–27, and the projection at lines 319–343).
- **Payment is masked** (`••••` + last 4) and only present with `payment_view`
  (`20261008120000` lines 332–343).
- **Filters/cursor** (`worker-directory-contract.ts` `projectWorkerDirectoryQuery`):
  allowlist `scope | project_id | recruiter_id | employment_status | cursor |
  page_size`; duplicate/unknown key → `WORKER_QUERY_INVALID`; `page_size` default
  25, max 100; cursor regex `^[0-9]{8}:<uuid>$`; keyset order
  `first_work_date desc, entry_id desc` (`20261008120000` lines 306–314).
- **Scope enforcement is entirely DB-side**
  (`direct_entry_worker_directory_audience`, `20261008120000` lines 45–190):
  - `recruited` = a single verified, effective app-user↔recruiter link (ambiguous
    → `42501`);
  - `managed` = the effective project-manager assignment predicate
    (`direct_entry_actor_has_project_assignment` + assignment intervals), a
    requested out-of-scope `project_id` → `42501`;
  - `all` = effective `all` scope grant **AND** (`entry_admin` OR `change_review`).
  - `created_by_user_id` is never an audience.

### 2.3 Full-PII authority and why N+1 is forbidden

- **The only canonical full-PII read is single-entry:** RPC
  `direct_entry_read_projection(p_auth_subject, p_app_user_id, p_entry_id)`
  (`src/lib/direct-entry/write-repository.ts:485`), reached by
  `GET /api/direct-entry/entries/[entryId]`. It returns canonical `worker_details`
  **only with `pii_view`**; without it the server returns a redacted
  presence/state-only shape (`write-api.ts:258–280`).
- **N+1 is explicitly forbidden by an existing anti-pattern rule**:
  `cccd-status.ts` header — the list projection must not call entry detail per row
  ("KHONG duoc goi entry detail cho tung dong (tranh N+1)"). An export built by
  looping `direct_entry_read_projection` per exported row would be N+1 RPCs, leak
  per-row authority mistakes, and cannot be audited as one atomic read.
- **Therefore the export cannot reuse `direct_entry_list_workers` (no PII) nor
  loop `direct_entry_read_projection` (N+1).** It needs one authoritative,
  actor-scoped, full-PII read that returns all export rows in a single call.

### 2.4 Smallest DB/server contract → **one new read-only RPC; migration IS required**

- **Conclusion: the Pre-W2 export requires exactly one new append-only migration
  adding one `SECURITY DEFINER` read-only RPC** (e.g.
  `public.direct_entry_export_workers(...)`), because no existing function returns
  full-PII rows in a bounded batch under the recruited/managed audience.
- **No schema/table/column change.** The RPC:
  1. calls the existing `direct_entry_worker_directory_audience` for the scope
     guard, and additionally **rejects `p_scope = 'all'`** (Owner §D) with `42501`;
  2. reuses `pii_view` to include canonical `worker_details` and `payment_view` to
     include payment fields; without them those fields are omitted (never
     fabricated);
  3. returns one row per eligible `SUBMITTED`, non-deleted entry in the
     recruited/managed set, reusing the same eligibility + filter semantics as
     `direct_entry_list_workers` (project/recruiter/employment_status);
  4. applies a hard **row cap** and fails closed (never a silently-truncated file);
  5. is `service_role`-only, revoked from every other role, `SECURITY DEFINER`,
     fixed `search_path = pg_catalog, public`.
- The `subject` gate is a **capability** read (`pii_export`) plus the existing
  `pii_view`/`payment_view`/row-authority intersection (§2.5). No client input is
  ever authority.
- **Rejected alternatives:** a client loop over `/api/direct-entry/entries/[id]`
  (N+1, forbidden); widening `direct_entry_list_workers` to always return PII
  (leaks PII to every directory reader and breaks the "raw PII not returned"
  invariant); a client-side join (forbidden).

### 2.5 Exact actor matrix and authority intersection

| Actor | recruited (rows) | managed (rows) | all (export) | PII columns | Payment columns |
|---|---|---|---|---|---|
| `pii_export` + `pii_view` + effective recruiter link | ✅ own recruiter rows | — | ⛔ denied | ✅ | only if `payment_view` |
| `pii_export` + `pii_view` + effective PM assignment | — | ✅ own project rows | ⛔ denied | ✅ | only if `payment_view` |
| `pii_export` but **no** `pii_view` | ⛔ no PII (fail) | ⛔ no PII (fail) | ⛔ denied | ⛔ | ⛔ |
| `pii_export` + `pii_view` but **no row authority** | ⛔ empty/denied | ⛔ empty/denied | ⛔ denied | n/a | n/a |
| no `pii_export` | ⛔ denied | ⛔ denied | ⛔ denied | ⛔ | ⛔ |
| `all` scope even with `pii_export`+`entry_admin` | — | — | ⛔ denied (hotfix) | — | — |
| authority revoked mid-request | the audience is resolved **inside** the same RPC call; a revocation before the call → denied; the row lock/snapshot makes the read atomic (no partial-authority file). |

**Intersection rule (locked for the lane):**
`pii_export` **AND** (`recruited` link **OR** effective PM assignment)
**AND** `pii_view` (for PII columns) **AND** `payment_view` (for payment columns).
`all` is denied in Pre-W2 regardless of other grants. The client never sends
`auth_subject`, `app_user_id`, scope grants or authority.

### 2.6 Proposed route / request contract

- `POST /api/direct-entry/workers/export` (new Route Handler,
  `runtime="nodejs"`, `dynamic="force-dynamic"`, `DIRECT_ENTRY_API_ENABLED` gate
  first, own `guardApiSession()` — same posture as `GET /api/direct-entry/workers`).
  POST (not GET) because it carries a mandatory `reason` + audit; same-origin/CSRF
  check like other mutations (`checkSameOriginRequest`).
- Body allowlist (exact keys; unknown/duplicate → `400`):
  `scope` (`recruited`|`managed` only), `project_id`, `recruiter_id`,
  `employment_status`, `reason` (required, 1..4000, trimmed), `idempotency_key`
  (optional for dedupe of retries). `source`/`limit`/`offset`/`order` rejected.
- Response: `200` with
  `content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `content-disposition: attachment`, `cache-control: private, no-store`,
  `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. Errors are
  sanitized JSON (`{ ok:false, code }`) with **no** PII, internal id or raw DB text.
- Filter/row limits: reuse the directory filter validation; add a hard export row
  cap (§2.10).

### 2.7 Server-generated XLSX (reuse ExcelJS)

- Reuse the installed **`exceljs`** exactly as
  `src/lib/direct-entry/worker-profile-xlsx.ts` does (`createWorkerProfileTemplate`,
  dynamic `import("exceljs")`, `Workbook`/`addWorksheet`/`xlsx.writeBuffer`).
  **No new dependency.**
- **Canonical labels/validators:** take column headers from
  `WORKER_PROFILE_FIELDS` (`worker-profile-import-contract.ts`) so the export
  matches the contract vocabulary.
- **Preserve leading zeros** for `national_id`, `phone`, `account_number`,
  `employee_code`: write those columns with `numFmt = "@"` (text) exactly as the
  template does for `STK`/`CMT/CCCD` (`worker-profile-xlsx.ts:184–192`); never
  write them as numbers (`TEXT_IDENTIFIER_KEYS`).
- **Neutralize Excel formula injection:** a cell value beginning with `=`, `+`,
  `-`, `@` (or tab/CR/LF) must be written as literal **text** (leading `'`-free,
  forced string type), never as a formula. The import side already rejects
  `excel.ValueType.Formula/Hyperlink/Error` (`worker-profile-xlsx.ts:141–144`);
  the export must apply the symmetric guard.
- **Server-only:** no client-side join/scrape; the browser receives only the
  finished `.xlsx` bytes.

### 2.8 Exact business column list

| # | Header (canonical) | Source key | Notes |
|---|---|---|---|
| 1 | Mã NLĐ | `employee_code` | text (leading zeros) |
| 2 | Họ và tên | `display_name` | |
| 3 | Giới tính | `gender` | |
| 4 | DOB | `date_of_birth` | |
| 5 | CMT/CCCD | `national_id` | **full**, text (leading zeros) |
| 6 | Ngày cấp | `national_id_issued_at` | |
| 7 | Nơi cấp | `national_id_issued_place` | |
| 8 | Địa chỉ hiện tại | `address` | |
| 9 | Số điện thoại | `phone` | text (leading zeros) |
| 10 | Dự án | `project_display` | |
| 11 | Ngày bắt đầu làm việc | `first_work_date` | |
| 12 | Người tuyển | `recruiter_display` | |
| 13 | HRP/Vendor | `provider_type` | `HRP`/`Vendor` |
| 14 | Loại hình lao động | `labor_type_display` | |
| 15 | Trạng thái làm việc | `employment_status` | `ON`/`OFF`/`UNCONFIRMED` |
| 16 | STK | `account_number` | text; only with `payment_view` |
| 17 | Tên ngân hàng | `bank_name` | only with `payment_view` |
| 18 | Tên chủ tài khoản | `account_holder_name` | only with `payment_view` |
| (opt) | Ghi chú | `general_note` | `sensitive_free_text`; include only if Owner wants it |

**Document status:** the directory/list path has **no** authoritative document
status (`cccd-status.ts` proves the list projection deliberately omits it to avoid
N+1). It is therefore **omitted** from this hotfix export unless the new RPC is
explicitly extended to compute a bounded per-entry CCCD/document progress. Record
as an explicit excluded/deferred item, not silently fabricated.

### 2.9 Explicitly excluded from the export

Internal UUIDs/versions; storage keys / object keys; raw audit metadata
(actor UUID, revision id); signed/expiring document URLs; binary document/image
content; capability/scope internals; any `auth_subject`/`app_user_id`; any
`team_id`/`bucket_key`-style internal token.

### 2.10 Audit contract + row cap / fail-closed

- **Audit (reuse existing tables):** one `direct_entry_audit_events` row (and,
  where a reason is required, `direct_entry_restricted_reasons` /
  `direct_entry_reason(app_user_id, reason)`) recording: actor
  (`auth_subject`/`app_user_id`), `scope` = `recruited`/`managed`, the applied
  filter (project/recruiter/status), the **reason**, the **row count**, the
  **outcome** and the **timestamp**. **No raw PII** may be written to audit,
  logs or the response-body JSON.
- **Row cap:** a fixed maximum (constant in the contract). Over the cap → the
  request **fails closed** (`400`/`413` sanitized error). Never return a truncated
  file; never partial success; retry with the same `idempotency_key` must not
  duplicate an audit/export record.

### 2.11 Reuse matrix (Survey A)

| Concern | Reuse | Do NOT |
|---|---|---|
| Route/auth | `guardApiSession`, `DIRECT_ENTRY_API_ENABLED` gate, `getDirectEntryActor`, `createDirectEntryActorRepository` | new auth |
| Scope authority | `direct_entry_worker_directory_audience` (`20261008120000`) | re-implement scope in TS/client |
| Row read | new RPC modelled on `direct_entry_list_workers` eligibility/filters | loop `direct_entry_read_projection` (N+1) |
| PII capability | `pii_view` gate (as `direct_entry_read_projection` does) | return PII without `pii_view` |
| Payment capability | `payment_view`; `bank_name` metadata shape (`write-repository.ts` payment projection) | unmasked payment without `payment_view` |
| XLSX | `exceljs`, patterns from `worker-profile-xlsx.ts` (text numFmt, formula rejection) | new spreadsheet dependency |
| Labels | `WORKER_PROFILE_FIELDS` canonical headers | a second label map |
| Audit | `direct_entry_audit_events`, `direct_entry_restricted_reasons`, `direct_entry_reason` | new audit store; raw PII in logs |
| Validation | server-side filter/schema validation | client-trusted scope/filters |
| Tests | `node:test`, PGlite, existing worker-directory tests, `worker-profile-xlsx` tests | new framework |

### 2.12 Smallest implementation touch set

- **T1B (backend/SQL):** one append-only migration → `direct_entry_export_workers`
  RPC (+ self-check: scope-all deny, ACL, PII/payment gating); a
  `worker-export` contract/repository/api module mirroring `worker-directory-*`;
  the `POST /api/direct-entry/workers/export` route; server XLSX builder reusing
  `exceljs`.
- **T1A (UI):** an "Xuất Excel" action on the recruited/managed tabs
  (visible only when the server grants export), reusing existing button/Card
  primitives; download handling only (no client join).

### 2.13 Acceptance + mutation (Survey A)

Acceptance: exported file = exactly the authorized recruited/managed rows; PII
columns present only with `pii_view`; payment only with `payment_view`; `all`
denied; leading zeros preserved; `=/+/-/@` cells rendered as literal text; over-cap
fails closed with no partial file; audit row records actor/scope/filter/reason/
count/outcome with no PII; retry is idempotent.

Mutation probes: (M-A1) add `all` to the export scope → must fail; (M-A2) drop the
`pii_view` gate → PII leak test red; (M-A3) drop the `payment_view` gate → payment
leak test red; (M-A4) replace the batch read with a per-row `read_projection` loop
→ N+1 regression red; (M-A5) write `national_id` as a number → leading-zero test
red; (M-A6) write a `=`-prefixed value as a formula → formula-injection test red;
(M-A7) return a truncated file above the cap instead of failing → partial-export
test red; (M-A8) put raw PII in an error/log → log-scan test red.

---

## 3. SURVEY B — Worker display-name change

### 3.1 Exact call graphs (current main)

**Direct Entry "Yêu cầu thay đổi":**
```
DirectEntryChangeRequestProposer (direct-entry-change-request-proposer.tsx)
  → kind selector "WORKER" = "Thông tin cá nhân người lao động" (line 85)
  → select exactly ONE entry (selectSingleEntry)
  → load: GET /api/direct-entry/submissions/{id} then GET /api/direct-entry/entries/{entryId}
      → write-repository.readEntry → RPC direct_entry_read_projection
      → projectEntrySensitiveContext(slice.entry)   (change-request-read-projection.ts:403)
  → edit display_name  (input #worker-display-name, lines 635–639)
  → buildWorkerDetailsProposal(baseline, form)      (change-request-proposal-builders.ts:189)
  → buildChangeRequestItem(targetKind "ENTRY_FIELD") (contract)
  → POST /api/direct-entry/change-requests          (change-request-api.ts)
  → RPC direct_entry_create_change_request(…)  → PENDING
  → reviewer: DirectEntryChangeRequestReviewer / RPC direct_entry_decide_change_request
  → approve → direct_entry_apply_change_item → direct_entries.worker_details updated
              + direct_entry_revisions + direct_entry_audit_events
```

**Worker Directory "Đề xuất thay đổi":**
```
WorkerOperations rows → allowed_actions (RPC direct_entry_list_workers)
  → CTA renders only when allowed_actions.propose_change === true (worker-operations-model.ts proposeCta)
  → ProposeDrawer (worker-operations.tsx:856)
  → fetchBaseline(entryId) → GET /api/direct-entry/entries/{entryId} → read_projection
  → target selector default "WORKER" (line 876); name input #worker-display-name (lines 1155–1159)
  → buildEntryFieldProposal(...) → buildChangeRequestItem
  → POST change request → reviewer → apply (same engine)
```

### 3.2 Answers

1. **Does the field actually work on current main?** **Yes at the DB**, and the
   editable inputs exist in both UIs. HF-R3 (#61,
   `20261008210000_p2_5_hf_r3_worker_full_correction.sql`) **removed the
   display_name protection**: its self-check asserts the create/apply bodies no
   longer contain `direct_entry_w04_assert_display_name_unchanged`, and its DB test
   asserts "the name is no longer protected"
   (`scripts/p2-5-hf-r3-worker-full-correction-db.test.mjs:402`). So a project
   manager may propose `display_name` through reason + OCC + idempotency +
   approval.
2. **Hidden behind which UX choice?** The target-kind selector: the name input
   renders **only** when the target is `WORKER` ("Thông tin cá nhân người lao
   động") in Direct Entry (TSX line 626) and `target === "WORKER"` in the
   ProposeDrawer. The directory CTA itself is hidden until
   `allowed_actions.propose_change === true`.
3. **Which actor does NOT get the `worker_details` baseline?** An actor **without
   `pii_view`**. The read projection returns canonical `worker_details` only with
   `pii_view`; otherwise a redacted presence/state-only shape
   (`write-api.ts:258–280`), which `projectWorkerDetailsForProposal`
   (`change-request-proposal-builders.ts`) rejects → `workerForm === null`
   (Direct Entry shows `proposer-worker-unavailable`, TSX lines 626–631).
4. **Which capability/scope controls the sensitive context and the proposal?**
   Sensitive context = `pii_view`. Proposal = an effective project-manager
   assignment (`managed`) for `allowed_actions.propose_change`
   (`20261008150000` §5) plus `change_request_create` for the create RPC;
   `change_review` + `all` scope for the reviewer. All resolved server-side.
5. **Is there a proposer-allowed-but-cannot-read-baseline state?** **Yes.**
   `propose_change` (PM assignment) and `pii_view` are **independent** grants, so a
   PM without `pii_view` sees the propose CTA but cannot populate the name; the
   drawer reports "Chưa đọc được thông tin người lao động." (worker-operations.tsx
   line 940) and the name field is unusable. This is the most likely user-visible
   fracture.
6. **Does the current DB validator/apply accept a name change?** It accepts a
   **full canonical `worker_details`** that changes `display_name` (R3). It does
   **not** accept a literal "name-only" object: the canonical validator
   `direct_entry_valid_worker_details` requires `display_name, date_of_birth,
   national_id, address, phone` to be present
   (`20261002170000` lines 137–143), and `direct_entry_w04_worker_details_allowed`
   (W05-R1, `20261008160000` lines 82–96) applies that validator — so a partial
   `{display_name}` proposal is rejected `22023`.
7. **What does the proposal send — only `display_name`, or the whole
   `worker_details`?** The **whole canonical `worker_details` object**
   (`buildWorkerDetailsProposal` returns `{ worker_details: candidate }` with all
   profile keys; `change-request-proposal-builders.ts:189–203`).
8. **Risk of sending unchanged PII just to change the name?** **Yes** — every name
   change transmits the entire profile (national id, address, phone, DOB, issue
   date/place), and requires `pii_view` to read that baseline. Given #6, sending
   only the name is **not** accepted by the current validator.
9. **Smallest safe repair.** The DB already accepts name changes, so this is **not**
   a missing-field problem. It is an **authority/affordance** fracture, so the
   smallest safe repair is a **UI-affordance + authority repair**, not a schema or
   backend-contract change:
   - make the name edit reachable for an authorized proposer either by
     (a) pairing the propose authority with `pii_view` provisioning for the
     intended proposers, **or** (b) surfacing a name-first affordance that does not
     depend on the full sensitive baseline — while keeping the existing
     change-request + reviewer + apply. Both keep §E (no direct update, no second
     column, no parallel workflow).
   - Making a true "name-only wire payload" would require relaxing the canonical
     `worker_details` validator — a **backend contract patch**, larger and riskier;
     **not** recommended for the hotfix.
   - **Policy decision for T0:** whether `display_name` (classified `direct_pii`)
     may be proposed without `pii_view`, or whether the repair is authority
     provisioning. The survey does not decide this; §D forbids bypassing `pii_view`.
10. **No second name column / direct mutation / parallel workflow.** Preserve.
11. **Validation:** trim; non-empty; max 256 (`direct_entry_valid_worker_details`
    line 141); Unicode (NFC handled by the existing validators); OCC via
    `expected_version`; mandatory reason; `idempotency_key`.
12. **Acceptance:** a name-change request at both entry points; reviewer sees
    old→new; approve updates `worker_details.display_name`; reject leaves it;
    stale `expected_version` → conflict; out-of-scope actor → deny; list/report
    reads show the new name after approval.
13. **Mutation probes:** bypass approval (direct `apply`) → red; unauthorized
    baseline read (drop `pii_view` gate) → red; direct update (skip change request)
    → red.

---

## 4. Migration observation (no reservation)

- Current ledger **85**; **next-available = #86**. This is an **observation**, not a
  reservation. T0 allocates the Pre-W2 export slot at implementation time.
- Survey A needs **one** new append-only migration (the export RPC). Survey B needs
  **no** migration. **W03B is parked outside `main`; no slot is reserved for it.**

---

## 5. Implementation order

1. T0 review of this survey (lock: export RPC/columns/actor matrix; name-repair
   policy decision in §3.9).
2. T1B: export migration + RPC + server module + route + XLSX builder; focused
   tests + mutation probes.
3. T1A: export UI action (recruited/managed only).
4. Name-change repair (T1A/T1B per the §3.9 decision), then independent
   verification; then T0 integration/UAT/deploy.

---

## 6. Blockers and risks

- **Policy:** §3.9 — does a display-name proposal require `pii_view`? Owner/T0
  must decide; §D forbids bypassing `pii_view`.
- **Privacy:** the current contract requires the full `worker_details` on a name
  change (validator §3.6); a true minimal payload is a larger contract change.
- **Export volume:** needs a hard row cap + fail-closed (no silent truncation).
- **Document status** is not authoritative on the list/export path today
  (out of scope unless the new RPC computes it).
- **Migration slot** is observed only; do not reserve.

---

## 7. Explicit no-implementation statement

This lane is **survey-only**. It changes **one** file
(`docs/handoffs/pre-w2-s0-pii-export-worker-name-survey.md`). No source, UI, API,
SQL, migration, package, dependency or lockfile change; no Production query/apply;
no deploy; no browser/UAT; no external-memory edit; no primary-checkout change; no
T1B/T1A implementation started; **no migration reserved**.
