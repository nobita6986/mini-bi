# PRE-W2-S0-R2 — Full-PII worker export & worker display-name correction (implementation-binding lock)

> **Status:** `PRE_W2_S0_R2_IMPLEMENTATION_BINDING_PASS_AWAITING_T0_REVIEW`
> **Revision:** R2 — final implementation-binding repair of R1 (`44f3bbb`); closes the
>   two repository-shape mismatches T0 flagged (export idempotency; audit schema
>   binding). Append-only on the same branch (no amend / no rebase / no force-push).
> **Base:** `origin/main@caab159eddb920fd60f75153bfa8828f35dfbb7e`.
> **Branch / worktree:** `audit/pre-w2-s0-pii-export-worker-name-survey` @
>   `C:\CodeApp\BI-pre-w2-s0-pii-export-worker-name-survey`.
> **Preflight (mandatory):** read `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`
>   (external operational memory; last section "2026-10-13 — Pre-W2 hotfix lock").
>   Repo source/contracts win where they disagree with that summary.
> **Document budget:** `DELTA_ONLY`. **Contract-lock only. No implementation.**

---

## 0. Owner decisions (locked)

- **A.** Pre-W2 is one hotfix release before Wave 2.
- **B.** Two separately reviewable lanes: (1) full-info XLSX export at
  "Người tôi tuyển / recruited" and "Dự án tôi quản lý / managed"; (2) allow
  proposing a worker display-name change at Direct Entry "Yêu cầu sửa/thay đổi"
  and Worker Directory "Đề xuất thay đổi".
- **C.** Export is removed from Wave 2.
- **D.** Owner activates `pii_export` for these use cases only. It may **not** export
  `all` scope, export workers outside recruited/managed authority, bypass
  `pii_view`/`payment_view`, or grant by email/role-name/client input.
- **E.** A name change must still go through a change request + reviewer; no direct
  update, no second name column, no parallel workflow.

---

## 1. Current-main facts

- **Delta from T0 baseline** `cb9b4d3` → current `caab159`: one commit
  `perf(ci): shard test suite across four runners (#5)` (CI-only).
- **Migration ledger:** **85** files; last =
  `20261011180000_p3_w05b_a_team_reporting.sql`. **#86 is next-available**
  (observation only; §4).
- **Primary checkout is NOT used** (on `codex/vps-deploy-hardening` with uncommitted
  VPS-lane changes).

---

## 2. SURVEY A — Full-information XLSX export

### 2.1 Exact call graph (current main)

```
WorkerOperations (src/components/direct-entry/worker-operations.tsx)
  → worker-operations-model.ts  workersQuery()/parseWorkerPageResponse()/proposeCta()
  → GET /api/direct-entry/workers        (route.ts; runtime="nodejs",
                                          dynamic="force-dynamic",
                                          DIRECT_ENTRY_API_ENABLED gate first)
  → worker-directory-api.ts listWorkers()
  → worker-directory-repository.ts → RPC direct_entry_list_workers(
        p_auth_subject,p_app_user_id,p_scope,p_project_id,p_recruiter_id,
        p_employment_status,p_cursor,p_page_size)
  → worker-directory-contract.ts projectWorkerDirectoryPage()/Row()
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
  `worker_details->>'display_name'`; national id / address / phone / DOB are
  **never** returned (migration `20261008120000` header 22–27, projection
  319–343).
- **Payment is masked** (`••••`+last 4) and present only with `payment_view`
  (`20261008120000` 332–343).
- **Filters/cursor** (`projectWorkerDirectoryQuery`): allowlist `scope | project_id
  | recruiter_id | employment_status | cursor | page_size`; unknown key →
  `WORKER_QUERY_INVALID`; `page_size` default 25 / max 100; cursor
  `^[0-9]{8}:<uuid>$`; keyset `first_work_date desc, entry_id desc`
  (`20261008120000` 306–314).
- **Scope is DB-side** (`direct_entry_worker_directory_audience`,
  `20261008120000` 45–190): `recruited` = one verified effective
  app-user↔recruiter link (ambiguous → `42501`); `managed` = effective
  project-manager assignment (out-of-scope `project_id` → `42501`); `all` = `all`
  scope **AND** (`entry_admin` OR `change_review`). `created_by_user_id` is never
  an audience.

### 2.3 Full-PII authority and why N+1 is forbidden

- The only canonical full-PII read today is **single-entry**:
  `direct_entry_read_projection(p_auth_subject, p_app_user_id, p_entry_id)`
  (`write-repository.ts:485`), reached by `GET /api/direct-entry/entries/[entryId]`;
  canonical `worker_details` only with `pii_view`, else a redacted
  presence/state-only shape (`write-api.ts:258–280`).
- **N+1 is explicitly forbidden**: `cccd-status.ts` header — the list projection
  must not call entry detail per row ("KHONG duoc goi entry detail cho tung dong
  (tranh N+1)").
- Therefore the export **cannot** reuse `direct_entry_list_workers` (no PII) and
  must **not** loop `direct_entry_read_projection` (N+1). It needs one
  authoritative, actor-scoped, full-information batch read.

### 2.4 Exact DB/server contract → one append-only migration + one batch RPC

- **One new append-only migration adds exactly one batch RPC**
  (`public.direct_entry_export_workers(...)`). **No schema/table/column change,
  and no global capability grant in the migration** (capabilities are provisioned
  by T0/Admin through the existing grant model — §2.6).
- **The RPC is a "business-read + audit-write" function, not a pure read-only RPC.**
  It reads the authorized business rows and, in the same transaction, writes one
  immutable `direct_entry_audit_events` access event (§2.10). **It has no
  idempotency guard** — every HTTP export attempt is an independent access (no
  dedupe key on this route).
- The RPC:
  1. calls `direct_entry_worker_directory_audience` for the recruited/managed scope
     guard and **rejects `p_scope = 'all'`** (and any scope other than
     `recruited`/`managed`) with a fail-closed database exception `42501` (§2.10);
  2. requires **all** of `pii_export` **AND** `pii_view` **AND** `payment_view`
     **AND** the recruited/managed row authority together; if **any** is missing it
     raises `42501` and **denies the whole export** — it never returns a
     partly-redacted file and never omits columns (§2.5 / §2.10);
  3. reads one row per eligible `SUBMITTED`, non-deleted entry in the authorized
     set, reusing the same eligibility + filter semantics as
     `direct_entry_list_workers` (project/recruiter/employment_status);
  4. selects **at most 10,001** candidate rows in a **single consistent
     PostgreSQL statement / transaction snapshot**; **no row lock is taken** (this
     is a read, not a locked mutation);
  5. on `≤ 10,000` rows returns the strict success envelope `{ status: "ok", rows:
     [...] }` and writes the `ALLOW` access event; on observing the **10,001st**
     candidate it writes a `REJECTED` access event with `denial_code =
     'EXPORT_ROW_LIMIT_EXCEEDED'` and returns the strict non-PII envelope
     `{ status: "too_many_rows", limit: 10000 }` — **it does not raise after the
     audit, and it returns no worker row** (§2.10);
  6. is `SECURITY DEFINER`, fixed `search_path = pg_catalog, public`,
     `service_role`-only, revoked from every other role.
- **Rejected alternatives:** client loop over `/api/direct-entry/entries/[id]`
  (N+1); widening `direct_entry_list_workers` to always return PII (leaks PII to
  every directory reader); a client-side join; a migration that grants any
  capability.

### 2.5 Exact actor matrix and authority conjunction

| Actor | recruited rows | managed rows | Export result |
|---|---|---|---|
| `pii_export` + `pii_view` + `payment_view` + effective recruiter link | ✅ | — | ✅ full file |
| `pii_export` + `pii_view` + `payment_view` + effective PM assignment | — | ✅ | ✅ full file |
| missing `pii_export` | ⛔ | ⛔ | ⛔ **deny whole export** |
| missing `pii_view` | ⛔ | ⛔ | ⛔ **deny whole export** (no PII redaction) |
| missing `payment_view` | ⛔ | ⛔ | ⛔ **deny whole export** (no payment-column omission) |
| `pii_export`+`pii_view`+`payment_view` but no row authority | ⛔ empty | ⛔ empty | ⛔ denied |
| `all` scope even with `pii_export`+`entry_admin` | — | — | ⛔ denied (hotfix) |
| authority revoked before the call | resolved inside the RPC → denied | | ⛔ denied |

**Conjunction (locked):** `pii_export` **AND** `pii_view` **AND** `payment_view`
**AND** (`recruited` link **OR** effective PM assignment). **Any missing term
denies the entire export** — no partial column set, no partial redaction. `all` is
denied in Pre-W2 regardless of other grants. The client never sends
`auth_subject`, `app_user_id`, scope grants or authority.

### 2.6 Exact request contract

- `POST /api/direct-entry/workers/export` (new Route Handler, `runtime="nodejs"`,
  `dynamic="force-dynamic"`, `DIRECT_ENTRY_API_ENABLED` gate first, own
  `guardApiSession()`); same-origin/CSRF check like other mutations
  (`checkSameOriginRequest`) — POST + the same-origin/CSRF guard are unchanged.
- **Body allowlist (exact keys):** `scope` (`recruited`|`managed` only),
  `project_id`, `recruiter_id`, `employment_status`, `reason` (required, trimmed,
  1..4000). Any other key, wrong value type, invalid enum or invalid filter →
  `400`. The export is a sensitive read; every HTTP attempt is an independent
  access (no dedupe key).
- **Validation scope (locked):** lock **unknown fields, value types, enum values
  and filter bounds** only. **Do NOT claim detection of duplicate JSON keys** —
  after `JSON.parse` an object cannot carry duplicate keys, so no duplicate-key
  guard is asserted.
- Response: `200` with
  `content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `content-disposition: attachment`, `cache-control: private, no-store`,
  `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. Errors are
  sanitized JSON (`{ ok:false, code }`) with **no** PII, internal id or raw DB text.

### 2.7 Server-generated XLSX (reuse ExcelJS)

- Reuse installed **`exceljs`** exactly as
  `src/lib/direct-entry/worker-profile-xlsx.ts` (`createWorkerProfileTemplate`,
  dynamic `import("exceljs")`). **No new dependency.**
- Headers follow the fixed 18-column schema (§2.8); labels reuse
  `WORKER_PROFILE_FIELDS` canonical headers where they exist.
- **Preserve leading zeros** for `employee_code`, `national_id`, `phone`,
  `account_number`: write those columns as **text** (`numFmt = "@"`, exactly as the
  template does for `STK`/`CMT/CCCD`, `worker-profile-xlsx.ts:184–192`); never as
  numbers.
- **Neutralize formula/hyperlink/error injection:** a cell beginning with `=`, `+`,
  `-`, `@` (or carrying tab/CR/LF) is written as a **literal string**, never as a
  formula; formula/hyperlink/error cell types are never produced (the import path
  already rejects them, `worker-profile-xlsx.ts:141–144`).
- **Server-only**, `private, no-store`; the browser receives only the finished
  `.xlsx` bytes. **No client-side join/scrape. No N+1 `direct_entry_read_projection`
  loop.**

### 2.8 Fixed 18-column schema (exact order)

| # | Header | Source |
|---|---|---|
| 1 | Mã NLĐ | `employee_code` (text) |
| 2 | Họ và tên | `display_name` |
| 3 | Ngày sinh | `date_of_birth` |
| 4 | CCCD | `national_id` (text, full) |
| 5 | Số điện thoại | `phone` (text) |
| 6 | Địa chỉ | `address` |
| 7 | Dự án | `project_display` |
| 8 | Ngày bắt đầu | `first_work_date` |
| 9 | Loại hình lao động | `labor_type_display` |
| 10 | Người tuyển | `recruiter_display` |
| 11 | Nhà cung cấp | `provider_type` (`HRP`/`Vendor`) |
| 12 | Trạng thái làm việc | `employment_status` |
| 13 | Ngày nghỉ | employment-episode leave date |
| 14 | Lý do nghỉ | employment-episode leave reason |
| 15 | Số tài khoản | `account_number` (text) |
| 16 | Ngân hàng | `bank_name` |
| 17 | Chủ tài khoản | `account_holder_name` |
| 18 | Ghi chú thanh toán | payment-group note (see note) |

- Columns 13/14 come from the authoritative employment-episode projection
  (status events); 15–17 from the payment projection (`bank_name` is the
  authoritative bank label; `direct_entry_payments` stores `bank_id`).
- **Column 18 note:** the current `direct_entry_payments` table has **no** note
  column (`20261002170000:233–239`). The header is kept for a stable 18-column
  shape; the value is bound to the authoritative payment note **only if one
  exists**, otherwise it is an **empty cell** — never fabricated. T1B confirms the
  exact source when implementing.

### 2.9 Explicitly excluded from the export

`general_note` (entry-level note); document status; signed document URLs;
document/binary content; internal authority/capability fields; internal
storage/path identifiers; UUIDs/versions; raw audit metadata; any
`auth_subject`/`app_user_id`; any internal token (e.g. `bucket_key`/`team_id`).

### 2.10 Audit contract (bound to `direct_entry_audit_events`) + hard cap

- **Table:** reuse `direct_entry_audit_events` **as-is** — no new audit table, no
  new column (`20261002170000:417–436`). Columns used: `auth_subject`,
  `app_user_id`, `action`, `capability`, `resource_ref`, `scope_kind`, `outcome`,
  `denial_code`, `reason_id`, `changed_fields`.
- **Success access event** (written when the PII rows have been read, ≤ 10,000):
  - `action = 'worker_export'` (≤ 96 chars);
  - `capability = 'pii_export'`;
  - `outcome = 'ALLOW'`;
  - `changed_fields = '{}'` (empty array);
  - `reason_id` = the mandatory reason via
    `direct_entry_reason(app_user_id, reason)` → `direct_entry_restricted_reasons`;
  - `scope_kind`: **the recruited scope maps to `'own'` and the managed scope maps
    to `'project'`** (both allowed by the current CHECK, widened to
    `('own','team','all','project')` in `20261009010000:201–204`). The raw scope
    token (`recruited`/`managed`) is **never** written as `scope_kind`.
  - `resource_ref = 'worker-export:' || <recruited|managed> || ':' || <row_count> ||
    ':' || <sha256 canonical filters>`, which satisfies the existing
    `resource_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'` bound (≤ 128 chars).
- **Filter hash:** the `<sha256 canonical filters>` is a canonical server-side hash
  (reuse `direct_entry_payload_hash(jsonb)` → 64-hex, `20261002170000:1183–1190`)
  over a **canonical, server-built** filter object. It never stores or embeds raw
  `project`/`recruiter`/`employment_status`, worker name, CCCD, phone or bank data.
- **Capability / row-authority denial:** the RPC keeps a **fail-closed database
  exception `42501`**; the Route maps it to a sanitized `403`. This memo does
  **not** claim that a DENY audit is persisted — a transaction that raises is rolled
  back, so no audit row survives. Only the ≤ 10,000 success and the 10,001 row-cap
  outcomes are persisted.
- **Hard cap = exactly 10,000 worker rows.** The RPC selects **at most 10,001**
  candidates. On the **10,001st** candidate it:
  1. writes an audit event with `outcome = 'REJECTED'`,
     `denial_code = 'EXPORT_ROW_LIMIT_EXCEEDED'`, `action = 'worker_export'`,
     `capability = 'pii_export'`, the same `scope_kind` mapping and `reason_id`;
  2. returns the **strict non-PII envelope** `{ status: "too_many_rows", limit:
     10000 }`;
  3. **does not `RAISE` after the audit** and **returns no worker row**. It never
     truncates silently and never produces a file with only the first 10,000 rows.
- **Route mapping:** `{ status: "too_many_rows", limit: 10000 }` → HTTP **422**
  `{ ok: false, code: "WORKER_EXPORT_ROW_LIMIT_EXCEEDED", limit: 10000 }`, guiding
  the user to narrow the scope/filter.
- **Success envelope:** the RPC returns `{ status: "ok", rows: [...] }`; the Route
  validates it with a **strict projection** (exact shape per §2.8) and only then
  generates the XLSX.
- **Access semantics:** the `ALLOW` audit is written when the PII rows have been
  read, even if XLSX generation or the download later fails — this is an **access
  audit, not a delivery receipt**.

### 2.11 Reuse matrix (Survey A)

| Concern | Reuse | Do NOT |
|---|---|---|
| Route/auth | `guardApiSession`, `DIRECT_ENTRY_API_ENABLED` gate, `getDirectEntryActor`, `createDirectEntryActorRepository` | new auth |
| Scope authority | `direct_entry_worker_directory_audience` (`20261008120000`) | re-implement scope in TS/client |
| Row read | new batch RPC modelled on `direct_entry_list_workers` eligibility/filters | loop `direct_entry_read_projection` (N+1) |
| Capabilities | `pii_export` + `pii_view` + `payment_view` (existing grants) | grant any capability in the migration |
| Payment label | `bank_name` (authoritative bank label) | expose `bank_id`/storage ids |
| XLSX | `exceljs`, `worker-profile-xlsx.ts` patterns (text numFmt, formula rejection) | new spreadsheet dependency |
| Audit | `direct_entry_audit_events` (as-is) + `direct_entry_reason` / `direct_entry_restricted_reasons`; `direct_entry_payload_hash` for the filter hash | a new audit table/column; raw PII in logs; raw scope tokens as `scope_kind` |
| Validation | server-side schema/filter validation (unknown fields/type/enum/filter bounds) | a duplicate-JSON-key claim |
| Tests | `node:test`, PGlite, worker-directory + `worker-profile-xlsx` suites | new framework |

### 2.12 Smallest implementation touch set

- **T1B (backend/SQL):** one append-only migration → `direct_entry_export_workers`
  (+ self-check: `all` deny, capability conjunction deny, ACL, 10k cap envelope,
  audit mapping `own`/`project`, `ALLOW`/`REJECTED`); a `worker-export`
  contract/repository/api module mirroring `worker-directory-*`; the
  `POST /api/direct-entry/workers/export` route; server XLSX builder reusing
  `exceljs`.
- **T1A (UI):** an "Xuất Excel" action on the recruited/managed tabs (visible only
  when the server grants export), reusing existing primitives; download only.

### 2.13 Acceptance + mutation (Survey A)

Acceptance: exactly the authorized recruited/managed rows; **whole-file** success
only when `pii_export` + `pii_view` + `payment_view` + row authority all hold —
otherwise a whole-export denial (never a redacted/partial file); `all` denied; all
18 columns present in the fixed order; leading zeros preserved; `=/+/-/@` values
rendered as literal text; ≤ 10,000 rows returns `{ status: "ok", rows }`; the
10,001st row writes a `REJECTED` `EXPORT_ROW_LIMIT_EXCEEDED` audit and returns the
`too_many_rows` envelope → HTTP 422 `WORKER_EXPORT_ROW_LIMIT_EXCEEDED` with no
worker rows and no truncation; the `ALLOW` audit binds `action=worker_export`,
`capability=pii_export`, `scope_kind` `own`/`project`, `outcome=ALLOW`,
`changed_fields={}`, `reason_id`, and a non-PII `resource_ref`; no request or body
carries a dedupe key.

Mutation probes: (M-A1) add `all` to the export scope → deny; (M-A2) drop the
`pii_export` gate → deny test red; (M-A3) drop the `pii_view` gate → PII-leak test
red; (M-A4) drop the `payment_view` gate → payment-leak test red; (M-A5) return a
partly-redacted file when a capability is missing → whole-file test red;
(M-A6) replace the batch read with a per-row `read_projection` loop → N+1 red;
(M-A7) write `national_id` as a number → leading-zero red; (M-A8) write a
`=`-prefixed value as a formula → injection red; (M-A9) truncate above the cap
instead of returning the `too_many_rows` envelope → cap red; (M-A10) write the raw
scope token (`recruited`/`managed`) as `scope_kind` instead of `own`/`project` →
audit-mapping red; (M-A11) `RAISE` after the row-cap audit → audit-survival red;
(M-A12) embed raw filter/CCCD/bank/name in `resource_ref` or logs → PII red.

---

## 3. SURVEY B — Worker display-name correction

### 3.1 Exact call graphs (current main)

**Direct Entry "Yêu cầu sửa/thay đổi":**
```
DirectEntryChangeRequestProposer (direct-entry-change-request-proposer.tsx)
  → target "WORKER" = "Thông tin cá nhân người lao động" (line 85)
  → select exactly ONE entry → load GET /api/direct-entry/entries/{entryId}
      → write-repository.readEntry → RPC direct_entry_read_projection (pii_view)
      → projectEntrySensitiveContext(slice.entry)
  → edit display_name (#worker-display-name, 635–639)
  → buildWorkerDetailsProposal(baseline, form) → buildChangeRequestItem("ENTRY_FIELD")
  → POST /api/direct-entry/change-requests → RPC direct_entry_create_change_request → PENDING
  → reviewer (DirectEntryChangeRequestReviewer / direct_entry_decide_change_request)
  → approve → direct_entry_apply_change_item → direct_entries.worker_details
              + direct_entry_revisions + direct_entry_audit_events
```

**Worker Directory "Đề xuất thay đổi":**
```
WorkerOperations rows → allowed_actions (RPC direct_entry_list_workers)
  → CTA only when allowed_actions.propose_change === true (proposeCta)
  → ProposeDrawer → fetchBaseline → GET /api/direct-entry/entries/{entryId} (read_projection)
  → target default "WORKER" (line 876); name input #worker-display-name (1155–1159)
  → buildEntryFieldProposal(...) → buildChangeRequestItem
  → POST change request → reviewer → apply (same engine)
```

### 3.2 Answers

1. **Works on current main?** **Yes at the DB**, and the editable inputs exist in
   both UIs. HF-R3 (#61, `20261008210000`) **removed the display_name protection**
   (its self-check drops `direct_entry_w04_assert_display_name_unchanged`; its DB
   test asserts "the name is no longer protected",
   `scripts/p2-5-hf-r3-worker-full-correction-db.test.mjs:402`).
2. **Hidden behind which UX choice?** The target-kind selector — the name input
   renders only for the `WORKER` target (Direct Entry TSX line 626; ProposeDrawer
   `target === "WORKER"`). The directory CTA is hidden until
   `allowed_actions.propose_change === true`.
3. **Who does NOT get the `worker_details` baseline?** An actor **without
   `pii_view`**: the read projection returns only a redacted presence/state shape
   (`write-api.ts:258–280`), so `projectWorkerDetailsForProposal` returns null and
   `workerForm === null` (Direct Entry shows `proposer-worker-unavailable`).
4. **Which capability/scope controls context and proposal?** Context = `pii_view`.
   Proposal = effective project-manager assignment (`managed`) for
   `allowed_actions.propose_change` (`20261008150000` §5) + `change_request_create`
   for the create RPC; `change_review` + `all` for the reviewer. All server-side.
5. **Proposer-allowed-but-cannot-read-baseline?** **Yes.** `propose_change` (PM
   assignment) and `pii_view` are independent, so a PM without `pii_view` sees the
   CTA but cannot populate the name (drawer: "Chưa đọc được thông tin người lao
   động.", worker-operations.tsx:940).
6. **Does the DB accept a name change?** It accepts a **full canonical
   `worker_details`** whose `display_name` changed (R3). A literal "name-only"
   object is **not** accepted: `direct_entry_valid_worker_details` requires
   `display_name, date_of_birth, national_id, address, phone` present
   (`20261002170000:137–143`), and `direct_entry_w04_worker_details_allowed`
   (W05-R1, `20261008160000:82–96`) applies it → partial `{display_name}` →
   `22023`.
7. **What does the proposal send?** The **whole canonical `worker_details`**
   (`buildWorkerDetailsProposal` → `{ worker_details: candidate }`).
8. **Unchanged-PII-on-name-change risk?** Yes — a name change transmits the full
   profile and needs `pii_view` to read the baseline (given #6).
9. **Smallest safe repair (locked):**
   - **Keep `pii_view` strictly.** `display_name` stays inside
     `worker_details`/`direct_pii`; an actor without `pii_view` may **not** read the
     baseline and may **not** submit a name correction.
   - **Do not relax the validator to a "name-only" payload.**
   - **No client bypass/redact-then-reassemble**: the client never reassembles
     `worker_details` from a redacted shape.
   - **Repair = make the existing `WORKER` target/edit path discoverable and
     usable**, and **prove the "Họ và tên" field appears and is editable at both
     entry points** (a. Direct Entry "Yêu cầu sửa/thay đổi"; b. Người lao động
     "Đề xuất thay đổi"). Both must reuse the **same** proposal builder, validator
     and create/decide/apply RPC; the reviewer still sees before/after
     `display_name` and decides under the existing OCC/audit.
   - **Missing `propose_change` OR missing `pii_view` must show a correct
     denial/explanation** (the CTA must not open a broken form). This is a UI
     affordance + authority-alignment repair, **not** a schema/backend-contract
     change — no second name column, no direct update, no parallel workflow.
10. **Validation:** trim; non-empty; max 256
    (`direct_entry_valid_worker_details` line 141); Unicode (existing validators);
    OCC via `expected_version`; mandatory reason; `idempotency_key`.
11. **Acceptance:** a name-change request at both entry points; reviewer sees
    old→new; approve updates `worker_details.display_name`; reject leaves it; stale
    `expected_version` → conflict; out-of-scope actor → deny; missing
    `pii_view`/`propose_change` → denial shown, no broken form; list/report reads
    show the new name after approval.
12. **Mutation probes:** bypass approval (direct `apply`) → red; unauthorized
    baseline read (drop the `pii_view` gate) → red; direct update (skip the change
    request) → red; client reassembles `worker_details` from a redacted shape →
    red.

---

## 4. Migration observation (no reservation)

- Current ledger **85**; **next-available = #86** (observation, not a reservation).
  T0 allocates the Pre-W2 export slot at implementation time.
- The export needs **one** new append-only migration (the batch RPC). The name
  correction needs **no** migration. **T0/Admin provision the existing
  `pii_export`/`pii_view`/`payment_view` grants before UAT; the migration grants no
  capability.** **W03B is parked outside `main`; no slot is reserved.**

---

## 5. Implementation order (after T0 accepts R2)

1. **T1B** — backend/RPC/API/export core (migration + `direct_entry_export_workers`
   + repository/api + route + server XLSX builder) with focused tests + mutation
   probes.
2. **T0** — review/apply the migration.
3. **T1A** — UI for export (recruited/managed) + the name-change affordance at both
   entry points.
4. **Regression / UAT / deploy** last.

---

## 6. Blockers and risks

- **Authority provisioning (not code):** the export actor needs `pii_export`,
  `pii_view` and `payment_view` granted by T0/Admin before UAT; row authority still
  bounds the rows. No capability is granted by the migration.
- **Export volume:** hard 10,000 cap with fail-closed + narrowing guidance; never a
  truncated file.
- **Privacy:** a name change still carries the full canonical `worker_details`
  (validator §3.6) — this is the existing contract, kept as-is.
- **Column 18 source:** `direct_entry_payments` has no note column today; col 18 is
  a fixed header bound to the authoritative payment note if one exists, else empty
  (never fabricated).
- **Migration slot:** observed only; do not reserve.

---

## 7. Explicit no-implementation statement

This lane is **docs-only contract repair**. It changes **one** file
(`docs/handoffs/pre-w2-s0-pii-export-worker-name-survey.md`). No source, UI, API,
SQL, migration, package, dependency or lockfile change; no Production
query/apply; no deploy; no browser/UAT; no external-memory edit; no primary-checkout
change; no T1B/T1A implementation started; **no migration reserved**.

---

## 8. Revision log

**R1 (`44f3bbb`)** locked the S0 survey into a contract T0 could open:

- §2.4/2.5 — export requires the full conjunction `pii_export` + `pii_view` +
  `payment_view` + row authority; any missing term denies the whole export, and
  payment columns are never dropped and no partly-redacted file is produced; the RPC
  is a business-read + audit-write function over one consistent snapshot (no lock).
- §2.6 — the export validation locks unknown fields, value type, enum and bounds
  only, and asserts no automatic detection of repeated JSON keys.
- §2.8/2.9 — the fixed 18-column schema (exact order); the entry-level note and any
  document-status column are excluded.
- §2.10 — hard cap exactly 10,000 rows; the audit event carries no raw CCCD/bank/PII.
- §3.2.9 — `pii_view` kept strictly; no name-only payload; no validator relaxation;
  the repair is the existing `WORKER` affordance made usable at both entry points.
- §4/§5 — one batch-RPC migration (observation-only slot); sequencing.

**R2 (this commit)** closes the two repository-shape mismatches T0 flagged:

- **Export idempotency removed entirely.** The export is a sensitive read; each HTTP
  attempt is an independent access. The request contract no longer carries a header
  key, a body key, a mismatch code, the idempotency-table helper or the
  begin/finish helpers, and no "same key → one record" claim remains. The body
  allowlist is exactly `scope`, `project_id`, `recruiter_id`, `employment_status`,
  `reason`; `reason` stays required/trimmed/1..4000; unknown field, wrong type,
  invalid enum or invalid filter → `400`; POST + the same-origin/CSRF guard are
  unchanged; the idempotency of existing mutations is untouched.
- **Audit bound to the real schema (§2.10).** Reuse `direct_entry_audit_events`
  as-is. Success: `action='worker_export'`, `capability='pii_export'`,
  `outcome='ALLOW'`, `changed_fields='{}'`, `reason_id` from the mandatory reason,
  `scope_kind` `'own'` for the recruited scope and `'project'` for the managed scope
  (never the raw scope token), and a bounded non-PII `resource_ref`
  `worker-export:<scope>:<row_count>:<sha256 canonical filters>` (≤ 128 chars, valid
  regex). Capability/row-authority denial stays a fail-closed `42501` (Route → 403)
  and does **not** claim a persisted DENY audit. Row-cap: select ≤ 10,001; the
  10,001st writes `outcome='REJECTED'` +
  `denial_code='EXPORT_ROW_LIMIT_EXCEEDED'` and returns
  `{ status:"too_many_rows", limit:10000 }` **without `RAISE`** (Route → HTTP 422
  `WORKER_EXPORT_ROW_LIMIT_EXCEEDED`); the success envelope is
  `{ status:"ok", rows:[...] }`; the `ALLOW` audit is written once PII is read, even
  if XLSX build/download later fails (access audit, not delivery receipt).
