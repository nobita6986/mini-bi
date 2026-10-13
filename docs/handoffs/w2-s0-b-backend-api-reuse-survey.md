# W2-S0-B — Wave 2 backend/API reuse survey

> **Status:** `W2_S0_B_BACKEND_API_REUSE_SURVEY_PASS_AWAITING_T0_REVIEW`
> **Type:** docs-only survey. No implementation, no source/schema/API/UI/test
>   change, no migration, no browser/UAT.
> **Base SHA:** `origin/main@afd13420365bff2801f5a6731649e1c278ffb894`.
> **Branch / worktree:** `audit/w2-s0-b-backend-api-reuse-survey` @
>   `C:\CodeApp\BI-w2-s0-b-backend-api-reuse-survey`.
> **Delta from** `afd1342`**: empty** (afd1342 **is** current `origin/main`).
> **Migration ledger:** **86**; last =
>   `20261013120000_pre_w2_p1_worker_export.sql` (#86). **Next-available = #87**
>   (observation only; **no slot reserved**).
> **Authority (order):** the Wave 2 master plan
>   `C:\CodeApp\BI-wave-2-master-plan-2026-10-13.md` → accepted `main` contracts →
>   the accepted W2-S0-C-R2 security survey → this memo.
> **Preflight read:** master plan; W2-S0-C-R2
>   (`e8e2164fa1a67c0f225b808500fb99b70567802b`); W2-S0-A-R1
>   (`0ccd806fd241e0e1999f27dd544f33cf7df63612`); `AGENTS.md`; the external
>   `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`.
> **Note:** `.codegraph/` exists in the primary checkout but **no CodeGraph tool
>   is exposed in this session**, so this survey used targeted grep/read (the
>   documented fallback).

---

## A. Current backend truth (call chain, authority, primitives)

### Call chain

```
Route Handler (src/app/api/direct-entry/**/route.ts; runtime="nodejs",
  dynamic="force-dynamic"; DIRECT_ENTRY_API_ENABLED gate first)
  → API projection (src/lib/direct-entry/<x>-api.ts; strict fail-closed projection)
  → repository (src/lib/direct-entry/<x>-repository.ts; service-role RPC only)
  → RPC / view / table (SECURITY DEFINER, fixed search_path, service_role-only)
  → audit / revision / idempotency / storage (direct_entry_audit_events,
    direct_entry_revisions, direct_entry_rpc_idempotency, R2 object storage)
```

**Authority/capability/scope:** server/DB only. `getDirectEntryActor` +
`createDirectEntryActorRepository` → RPC `direct_entry_resolve_actor_context`
(`actor-context-repository.ts:18`); the actor carries `capabilities` + effective
`scopes` (`own|team|all`). Gates: `guardApiSession` (API),
`decideSessionPageAccess` (pages), `direct_entry_has_capability`,
`direct_entry_has_scope`, `direct_entry_assert_*`. Client never supplies authority.

**Existing primitives:**
- **OCC:** `expected_version` per aggregate; SQLSTATE `40001` on stale.
- **Idempotency:** table `direct_entry_rpc_idempotency` + helpers
  `direct_entry_idempotency_begin/finish`; `direct_entry_payload_hash(jsonb)` →
  64-hex.
- **Reason/audit:** `direct_entry_restricted_reasons`, `direct_entry_reason(app_user_id,
  reason)`; `direct_entry_audit_events` (`action`, `capability`, `resource_ref`
  ≤128 + regex, `scope_kind ∈ {own,team,all,project}`, `outcome ∈
  {ALLOW,DENY,APPLIED,REJECTED}`, `denial_code`, `reason_id`, `changed_fields`).
- **Revisions:** `direct_entry_revisions`/`_submission_revisions`/`_change_request_revisions`
  (+ team/labor-type/personnel/vendor revision families), immutable triggers.
- **Error taxonomy (TS):** `classifySubmissionTransitionError` /
  `classifyWorkerDirectoryError` map SQLSTATE → `denied|not-found|invalid|conflict|
  unavailable`; route codes `SUBMISSION_*`, `WORKER_*`, `INVALID_FILTER`,
  `REPORTING_QUERY_FAILED`, `IDEMPOTENCY_KEY_MISMATCH`.

### Route surface (29 handlers) + key RPCs

- **Worker directory:** `GET /api/direct-entry/workers` → `direct_entry_list_workers`;
  episodes: `.../workers/episodes`; **export (Pre-W2 #86):**
  `POST /api/direct-entry/workers/export` →
  `direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)`.
- **Entry read/write:** `GET/PATCH /api/direct-entry/entries/[entryId]` →
  `direct_entry_read_projection`, draft patch; `.../privileged-edit` →
  `direct_entry_privileged_edit`.
- **Documents:** `POST .../documents` → `direct_entry_reserve_document_direct_upload`;
  `.../documents/[documentId]/finalize` → `direct_entry_finalize_document_direct_upload`;
  `.../documents/[documentId]/download` (authenticated stream); helper
  `direct_entry_document_direct_context`.
- **Payment:** `PATCH .../payment` → `direct_entry_update_payment`.
- **Change requests:** `.../change-requests` (+`[requestId]`, `/decision`,
  `/withdraw`) → `direct_entry_create_change_request`,
  `direct_entry_read_change_request`, `direct_entry_list_change_requests`,
  `direct_entry_approve_change_request`, `direct_entry_reject_change_request`,
  `direct_entry_withdraw_change_request`.
- **Projects/managers (admin):** `.../projects`, `.../projects/[projectId]`,
  `.../projects/[projectId]/managers`, `.../managers/[assignmentId]`,
  `.../manager-candidates` → `direct_entry_get_project_admin`,
  `direct_entry_create_project`, `direct_entry_rename_project`,
  `direct_entry_set_project_active`, `direct_entry_list_project_manager_assignments`,
  `direct_entry_list_project_manager_candidates`,
  `direct_entry_assign_project_manager`, `direct_entry_unassign_project_manager`.
- **Catalog/drafts/session/reports:** `.../catalog` → `direct_entry_input_catalog`;
  `.../drafts` → `direct_entry_list_own_drafts`; `.../batches` (+`/full-profile`);
  `.../duplicate-cccd-report`; `.../session`.

### Document upload/finalize/download flow

`DirectEntryDocumentEditor` (reserve → **presigned PUT** → finalize, idempotency,
409 conflict, mandatory replacement reason) + `DirectEntryCccdManager` (FRONT/
BACK pair) over `r2-document-storage.ts` (`@aws-sdk/s3-request-presigner`;
staging PUT bound to key/content-type/length, ≤5 min; GET attachment-only,
generic filename, ≤2 min). Strict projection `document-detail-projection.ts`
(`DETAIL_DOCUMENT_TYPES = CCCD_FRONT|CCCD_BACK|EMPLOYMENT_CONTRACT`,
`projectEntryDetail`/`fetchEntryDetail`). MIME/size from `cccd-document-pair.ts`
(`CCCD_MIME_TYPES`, `CCCD_MAX_BYTES`).

### Worker directory/detail, payment, project assignment, change-request

- Worker directory: `worker-directory-{contract,api,repository}.ts` →
  `direct_entry_list_workers`; 18-key row, no raw PII; `allowed_actions`.
- Entry detail: `document-detail-projection.ts` + `write-repository.readEntry`
  (`direct_entry_read_projection`); canonical `worker_details` only with `pii_view`.
- Payment: `payment-contract.ts` (`PAYMENT_STATES`, `projectPaymentInput(activeBankIds)`,
  masked projection), `payment-{api,repository}.ts`, route above.
- Project assignment: `project-admin-{contract,api,repository}.ts` +
  `project-operations-model.ts` (OCC + reason + idempotency + `classifyResponse` +
  `splitAssignments`), keyed by `manager_recruiter_id`.
- Change request: `change-request-{contract,proposer,reviewer,proposal-builders,
  read-projection,read-contract,api,repository,read-*}.ts`, no-self-review, OCC,
  idempotency, reason, immutable audit.

---

## B. W2S1 — Worker portrait + full worker detail

**Pre-existing:** `document-detail-projection.ts` returns
`CCCD_FRONT|CCCD_BACK|EMPLOYMENT_CONTRACT`; there is **no portrait concept, no
`original/current/legacy_added` kind, and no reusable image preview** (W2-S0-A).

**Smallest proposal (all T0-accept):**
1. **Portrait storage — EXTEND the existing document pipeline, do not add a new
   abstraction.** Add a `WORKER_PORTRAIT` `DocumentType` to the existing
   document tables/upload/finalize/download flow (reuse reserve→PUT→finalize,
   MIME/magic-bytes/checksum/size, EXIF stripping, private bucket, short-lived
   access).
2. **Portrait kind — server-resolved, never client-inferred.** The server MUST
   project a validated `kind ∈ {original|enrollment, current, legacy_added}` plus
   the `legacy_added` **added date**. Recommend deriving `kind` **server-side** from
   the portrait rows' history (first accepted = original/enrollment; latest
   approved = current; first portrait added to a pre-existing worker = legacy_added).
   **If** that derivation cannot be made deterministic, add **one** minimal sibling
   marker (e.g. a `portrait_kind` column on the portrait document row or a tiny
   `direct_entry_worker_portraits` table) — **a T0 architecture decision**, not a
   default new abstraction.
3. **Snapshot immutability:** when a CASH request is created, snapshot the portrait
   **document id + version + checksum** on the request; later portrait changes do not
   touch the snapshot or force re-review.
4. **Full worker detail — EXTEND the existing entry-detail read** (add the portrait
   group, per-document completeness, pending change request + last decision) with
   **independent** PII/payment/document redaction; no raw storage key, internal actor
   id or long-lived URL in any projection.
5. **Preview delivery — two accepted options (T0 picks the smallest):**
   (1) **same-origin authenticated byte stream** (extend the existing `download`
   route style; nothing URL-like in the payload); (2) **short-lived signed URL**
   under the R2 posture (≤2 min, attachment-only, generic filename, never logged/
   persisted/in a label or ARIA). Recommendation: option (1) — it removes the URL
   leak surface.

**Reuse:** `document-*`, `cccd-*`, `r2-document-storage`, `document-detail-projection`,
`direct_entry_read_projection`, capability redaction. **Extend vs new table:** the
existing document tables can carry the asset; only the semantic `kind` may need one
minimal marker (above).

---

## C. W2S2 — Accountant assignment

**Identity (survey both, recommend):**
- **app_user/account:** the finance workflow is account-driven and the master plan
  says "chỉ account đang hoạt động mới được phân công" → **recommend keying the
  accountant by `app_user_id`** (account), not `manager_recruiter_id`.
- recruiter/personnel: PM assignment keys on `manager_recruiter_id` (recruiter);
  reusing that would conflate a personnel record with a login-backed finance actor.

**Data model (smallest):** a **NEW sibling** `direct_entry_project_accountants`
(`project_id`, `accountant_app_user_id`, `valid_from`, `valid_to`, `version`,
audit/reason) with **at most one effective assignment per project** (partial unique
index on `(project_id)` where `valid_to IS NULL`), effective-dated, versioned,
audited, history never overwritten. **A request snapshots the accountant +
assignment id at submit**; the RPC must **not** re-resolve the current assignment to
replace an open case's snapshot accountant. Explicit/bulk transfer = **deferred**.

**Candidate/list/detail/mutation RPCs (NEW siblings, mirroring project-admin):**
`direct_entry_get_project_accountant`, `direct_entry_list_project_accountant_assignments`,
`direct_entry_list_accountant_candidates`, `direct_entry_assign_project_accountant`,
`direct_entry_unassign_project_accountant`; Admin API siblings of the existing
`.../projects/[projectId]/managers` routes.

**Capability bundle (smallest; exact tokens = T0):** reuse existing tokens —
`change_review` (decide), `payment_view`(+`payment_edit` if correction is allowed),
`pii_view` (worker identity/CCCD, needed to review), `document_view` (proof). **Not**
`entry_admin`, `change_request_create`, `recruiter_master_manage`,
`team_master_manage`, `pii_export`, `entry_restore`. Accountant must **not** see the
recruitment Dashboard, Nhập liệu, all-workers, or Admin Catalog because of finance
authority.

**Reuse boundary:** reuse only the project-admin **validators/outcome/OCC/reason/
idempotency/effective-date/UI pattern**. **Do NOT** parameterize/repoint
`project-operations-model` or `manager_recruiter_id`.

---

## D. W2S3 — Salary-advance request

**Data model:** **NEW sibling** salary tables (per W2-S0-C: reuse change-request
**primitives/patterns**, not the business tables) — e.g.
`direct_entry_salary_advance_requests` (+ `_items`/`_events`/`_revisions`) with
amount/method/portrait+bank snapshots the change-request ENTRY_FIELD proposal shape
does not model. **A W2-S0-B decision, not a default reuse of
`direct_entry_change_requests`.**

**Contract:**
- Manager selects a worker **within a project they currently manage** (reuse the
  `managed` audience predicate); the request binds to the **employment entry +
  project**.
- **Amount:** integer VND, `> 0`; **hard ceiling = open decision (T0)** — the survey
  does not pick a number.
- **Method:** `CASH | BANK_TRANSFER`.
- **At most one open request per employment entry** (partial unique index).
- **Snapshot the accountant assignment at submit**; **no-self-review**; OCC +
  idempotency + reason + immutable audit.
- **State:** `REQUESTED → REJECTED | APPROVED`.
- **CASH:** require `portrait READY` **checked at submit**; snapshot portrait
  document/version/checksum.
- **BANK_TRANSFER:** no portrait; snapshot `bank` (active catalog) +
  `account_number` (text, leading zeros) + `account_holder_name`; **manual ownership
  review, never auto-concluded**; masking in lists; **no raw bank data in URL/log/
  error/audit** (store a canonical hash).
- **Strict salary-specific projection/API/RPC. Do NOT import AI-report
  `projectReviewRequest`.**

**RPCs (NEW siblings):** `direct_entry_create_salary_advance_request`,
`direct_entry_read_salary_advance_request`,
`direct_entry_list_salary_advance_requests`, `direct_entry_decide_salary_advance_request`.

## E. W2S4 — Disbursement, proof, AI signal

- `APPROVED → DISBURSED_WAITING_PROOF`: **snapshot accountant** marks disbursed
  (actor/time/amount/method); **no partial disbursement**.
- **Accountant document = optional supporting evidence only** — it does not replace
  the Manager proof and does not advance the state.
- **Manager submits/resubmits the mandatory proof** (new proof version + new AI
  check; never overwrite history).
- Proof is bound to **request version + disbursement event + amount + method + proof
  version**; a stale/wrong-case proof is rejected.
- CASH: **human** compares the snapshot portrait with the cash-envelope proof.
  BANK_TRANSFER: **financial** comparison (bank/STK/holder/amount/time). **No claim
  that a bill verifies a face; no face recognition.**
- **AI (advisory only):** states `PENDING|LOW_SYNTHETIC_RISK|REVIEW_REQUIRED|
  INCONCLUSIVE|UNAVAILABLE`; never auto approve/reject; `REVIEW_REQUIRED` override
  and `UNAVAILABLE` continuation require a reason; idempotency by **proof checksum**;
  store provider/model/version/`checked_at`; send only the **metadata-stripped proof
  image** (never portrait/CCCD/name/STK/project if the provider only needs bytes);
  **server-only secret**; webhook signature/replay **only if** the provider truly
  needs a webhook. Provider/retention/training/cost/SLA = **open decision**.
- **RPCs (NEW siblings):** `direct_entry_mark_salary_advance_disbursed`,
  `direct_entry_submit_salary_advance_proof`, `direct_entry_decide_salary_advance_proof`,
  `direct_entry_attach_salary_advance_supporting_document` (optional evidence).
  AI check is a server-only adapter call (metadata-stripped proof), reusing the AI
  gateway's provider-adapter/`generateStructured` shape — **not** the AI report flow.

## F. W2S5 — Refund + basic summary

**Exact transition (locked):**
```
PROOF_SUBMITTED
├── COMPLETED
└── PROOF_REJECTED
     ├── PROOF_SUBMITTED     (Manager resubmits)
     └── REFUND_REQUIRED
          └── REFUNDED
```
- **No `PROOF_SUBMITTED → REFUND_REQUIRED` directly.** **Refund locked authority =
  snapshot accountant only**; Full Admin refund break-glass = **open decision**
  (not granted). **No refund from `COMPLETED`.** Refund is **append-only, no
  partial.**
- **RPCs (NEW siblings):** `direct_entry_open_salary_advance_refund`,
  `direct_entry_confirm_salary_advance_refund`.

**Basic summary (MVP):** presets **Hôm nay / Tuần này / Tháng này**; server-derived
KPI (total requests, disbursed total, completed, waiting-proof, proof-rejected,
refund-required, refunded) + per-project and per-method tables. Timestamps:
cashflow `disbursed_at`, reconciliation `completed_at`, refund `refunded_at`;
timezone **Asia/Bangkok**. **No trend chart, export, period comparison or
forecast.** Reuse `p1-date-presets` for the ranges; **no client aggregation**
(server-derived projection, like `p1-reporting`/`computeReporting`).

---

## G. Reuse decision matrix

| Concern | Decision | Rationale |
|---|---|---|
| actor/session/capability/scope | **REUSE_UNCHANGED** | `getDirectEntryActor`, `direct_entry_resolve_actor_context`, `guardApiSession`, `decideSessionPageAccess`, `direct_entry_has_capability/scope`. |
| project authority | **REUSE_UNCHANGED** | `direct_entry_actor_can_access_project` + current PM assignment predicate. |
| change-request primitives | **DO_NOT_REUSE (table) / REUSE pattern** | reuse no-self-review, OCC, idempotency, reason, immutable audit, propose/decide/withdraw **patterns**; do **not** insert salary rows into `direct_entry_change_requests`. |
| project assignment primitives | **NEW_SIBLING** | an accountant sibling keyed by `app_user_id`; do not repoint `manager_recruiter_id`. |
| payment/bank catalog | **EXTEND_EXISTING** | reuse `direct_entry_banks`, `payment-contract` masked projection + allowlist; add salary snapshot fields. |
| worker directory/detail | **EXTEND_EXISTING** | add portrait/completeness/pending-request groups to the entry-detail read; keep capability redaction. |
| document storage | **EXTEND_EXISTING** | reuse `r2-document-storage` + document tables/RPC; add `WORKER_PORTRAIT` (+ optional minimal kind marker). |
| audit/revision/idempotency | **REUSE_UNCHANGED** | `direct_entry_audit_events`, `direct_entry_revisions`, `direct_entry_rpc_idempotency`, `direct_entry_payload_hash`. |
| reporting aggregation | **REUSE pattern / NEW_SIBLING projection** | reuse the server-derived read-model pattern (`computeReporting`, `p1-date-presets`); the salary summary is its own projection. |
| AI gateway/provider adapter | **REUSE pattern / NEW adapter call** | reuse the gateway's provider-adapter/`generateStructured` shape server-only; **do not** reuse the AI-report `projectReviewRequest` flow. |

---

## H. Smallest backend touch set (survey only — no files created)

| W2S | Extend existing | New (required) | Do NOT touch | Migration boundary |
|---|---|---|---|---|
| W2S1 | document tables/RPC (+`WORKER_PORTRAIT`), entry-detail read, worker-detail projection | portrait kind projection (+optional minimal marker); a same-origin preview stream route **or** a signed-URL path | `direct_entry_change_requests` business rows; existing CCCD/contract types | one append-only migration for the portrait type/marker + projection |
| W2S2 | project-admin validators/outcome/OCC/reason/idempotency patterns | `direct_entry_project_accountants` + 5 sibling RPCs + Admin API/route | `project-operations-model`, `manager_recruiter_id`, `direct_entry_project_manager_assignments` | one append-only migration |
| W2S3 | `direct_entry_banks`, `payment-contract` masked projection, worker `managed` audience | salary request tables + 4 sibling RPCs + strict contract/api/repository/route | AI-report `projectReviewRequest`; the change-request business tables | one append-only migration |
| W2S4 | AI gateway adapter shape, document pipeline (proof asset) | disbursement/proof tables + 3–4 sibling RPCs + AI-check adapter call | face-recognition/AI-image-report flow | same/later migration (disbursement/proof tables) |
| W2S5 | `p1-date-presets`, the server-derived summary pattern | refund RPCs + summary projection/route | trend charts, export, period comparison | one append-only migration (refund/events + summary projection) |

**Migration boundary:** Wave 2 needs **new append-only migrations** (portrait marker,
accountant sibling, salary+disbursement+proof+refund tables). The slot is **observed
only (#87)** and **not reserved**; T0 allocates it on the implementation branch.

---

## I. Exact API/RPC contract proposal (shape)

For every new route/RPC: **actor is resolved server-side** (never sent); request
keys are an exact allowlist; responses are strict fail-closed projections; redaction
is per capability; OCC = `expected_version`; idempotency = `Idempotency-Key` +
`direct_entry_rpc_idempotency`; HTTP/SQL errors follow the existing taxonomy
(`denied→403`, `not-found→404`, `invalid→400`, `conflict→409`, `unavailable→503`,
`INVALID_FILTER`); responses are `private, no-store`; pagination uses keyset cursors
bounded ≤100; audit writes one immutable `direct_entry_audit_events` row
(`action`, `capability`, `scope_kind`, `outcome`, `denial_code`, `reason_id`, a
non-PII `resource_ref`).

**Allowed/denied matrix (summary):** Manager = create/resubmit proof + read own,
never decide/refund; snapshot accountant = decide/disburse/proof-decide/refund;
Full Admin = read + audit only (no unlocked refund break-glass); unauthenticated/
cross-project = denied by RPC scope. **Client never sends authority, scope,
audience or actor.**

---

## J. Acceptance & mutation matrix

**Acceptance:** IDOR/cross-project denied; portrait kind server-validated (no client
inference), `legacy_added` shows the added date; CASH requires `READY` **at submit**;
BANK_TRANSFER without portrait succeeds with the bank snapshot; accountant snapshot
holds across reassignment; no-self-review; double-submit/retry idempotent; proof
actor = Manager + version binding; **no direct `PROOF_SUBMITTED → REFUND_REQUIRED`**;
refund only by the snapshot accountant, never from `COMPLETED`; AI states fail closed
with no auto-decision/override reason; no raw PII/storage-key/signed-URL leak;
summary reconciliation/timezone correct.

**Mutation probes (must go RED):** drop the per-row scope check; re-resolve the
current accountant; remove OCC; accept a stale proof version; return a signed URL/
storage key in a list; log raw CCCD/bank/portrait; let AI auto-decide; treat
`UNAVAILABLE` as accept; allow self-review; check CASH portrait at disbursement
instead of submit; let an accountant document advance the state; allow
`PROOF_SUBMITTED → REFUND_REQUIRED`; open `REFUND_REQUIRED` from `COMPLETED` or by
the Manager; import AI-report `projectReviewRequest` into the salary flow; recompute
summary totals on the client.

---

## K. Open decisions & stop conditions

**Open (do not self-lock; T0/Owner decision required):** maximum advance amount
(and whether per-project); Full Admin refund break-glass scope; AI
provider/retention/training/cost/SLA; WebP support at runtime; worker-detail shell;
PDF preview vs signed-download fallback; accountant identity confirmation
(app_user vs recruiter — recommended app_user); exact accountant capability tokens;
portrait-kind mechanism (server-derived vs minimal marker).

**Stop conditions for go-live:** any IDOR/cross-project leak; a signed-URL/storage-key
leak; raw PII/bank in logs/audit; AI able to auto-decide or `UNAVAILABLE` treated as
safe; self-review possible; CASH without a ready portrait at submit; proof not
Manager-submitted; a refund opened by the Manager/from `COMPLETED`/directly from
`PROOF_SUBMITTED`; a live re-resolution replacing an open case's snapshot accountant;
unreconciled summary totals; an unsigned/forged webhook accepted.

---

## L. Explicit no-implementation statement

This lane is **survey-only**. It changes **one** file
(`docs/handoffs/w2-s0-b-backend-api-reuse-survey.md`). No source, schema, SQL, API,
UI, test, package, dependency or lockfile change; no migration; no Production
query/apply; no deploy; no browser/UAT; no Pre-W2 branch/worktree touched; no W2
implementation opened; **no migration reserved**.
