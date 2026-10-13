# W2-S0-B-R1 — Wave 2 backend/API reuse survey (targeted repair)

> **Status:** `W2_S0_B_R1_BACKEND_API_REUSE_CONSISTENCY_PASS_AWAITING_T0_REVIEW`
> **Revision:** R1 — targeted repair of the W2-S0-B survey (`7ba2de5`) against the
>   current Wave 2 master plan. Append-only on the same branch (no amend / no
>   rebase / no force-push).
> **Base SHA:** `origin/main@afd13420365bff2801f5a6731649e1c278ffb894`.
> **Branch / worktree:** `audit/w2-s0-b-backend-api-reuse-survey` @
>   `C:\CodeApp\BI-w2-s0-b-backend-api-reuse-survey`.
> **Migration ledger:** **86**; last =
>   `20261013120000_pre_w2_p1_worker_export.sql` (#86). **Next-available = #87**
>   (observation only; **no slot reserved**).
> **Authority (order):** the Wave 2 master plan
>   `C:\CodeApp\BI-wave-2-master-plan-2026-10-13.md` → accepted `main` contracts →
>   the accepted W2-S0-C-R2 security survey → this memo.
> **CodeGraph:** `.codegraph/` exists in the primary checkout, but **no CodeGraph
>   tool is exposed in this session**; targeted grep/read (documented fallback).
>
> **⚠ Master-plan hash discrepancy (evidence, not a content conflict):** the R1
>   brief pins SHA-256 `3EDCF2837E2A877D934A2D35B0BB6CB2A03B8CD3608269A8D935DF7C2A2B0A3A`,
>   but the on-disk plan hashes to `E439EC67434FD23ACEDD74B0D787B36A72778B45706871915E8584A422206364`
>   (583 lines, LF-only, no BOM; raw bytes == LF-normalized, so this is **not** a
>   line-ending artifact). The on-disk plan is a **newer T0 revision** whose
>   W2-S0-B ledger entry (`REVIEWED_R1_REQUIRED`) and open decision #7 state
>   **exactly** these R1 requirements, so R1 proceeds against the on-disk content.

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

**Existing primitives:** OCC `expected_version` (SQLSTATE `40001`);
`direct_entry_rpc_idempotency` + `direct_entry_idempotency_begin/finish` +
`direct_entry_payload_hash(jsonb)` → 64-hex; `direct_entry_restricted_reasons` +
`direct_entry_reason(app_user_id, reason)`; `direct_entry_audit_events`
(`action`, `capability`, `resource_ref` ≤128 + regex, `scope_kind ∈
{own,team,all,project}`, `outcome ∈ {ALLOW,DENY,APPLIED,REJECTED}`, `denial_code`,
`reason_id`, `changed_fields`); `direct_entry_revisions` family; error taxonomy
`classifySubmissionTransitionError`/`classifyWorkerDirectoryError` → `denied|
not-found|invalid|conflict|unavailable` (routes: `SUBMISSION_*`, `WORKER_*`,
`INVALID_FILTER`, `REPORTING_QUERY_FAILED`, `IDEMPOTENCY_KEY_MISMATCH`).

### Route surface (29 handlers) + key RPCs

- Worker directory: `GET .../workers` → `direct_entry_list_workers`; export
  (Pre-W2 #86) `POST .../workers/export` → `direct_entry_export_workers`.
- Entry read/write: `GET/PATCH .../entries/[entryId]` → `direct_entry_read_projection`;
  `.../privileged-edit` → `direct_entry_privileged_edit`.
- Documents: `POST .../documents` → `direct_entry_reserve_document_direct_upload`;
  `.../documents/[documentId]/finalize` → `direct_entry_finalize_document_direct_upload`;
  `.../documents/[documentId]/download` (authenticated stream);
  `direct_entry_document_direct_context`.
- Payment: `PATCH .../payment` → `direct_entry_update_payment`.
- Change requests: `.../change-requests` (+`[requestId]`, `/decision`, `/withdraw`)
  → `direct_entry_create_change_request`, `direct_entry_read_change_request`,
  `direct_entry_list_change_requests`, `direct_entry_approve_change_request`,
  `direct_entry_reject_change_request`, `direct_entry_withdraw_change_request`.
- Projects/managers: `.../projects`, `.../managers`, `.../manager-candidates` →
  `direct_entry_get_project_admin`, `direct_entry_create_project`,
  `direct_entry_rename_project`, `direct_entry_set_project_active`,
  `direct_entry_list_project_manager_assignments`,
  `direct_entry_list_project_manager_candidates`,
  `direct_entry_assign_project_manager`, `direct_entry_unassign_project_manager`.
- Catalog/drafts/reports: `.../catalog` → `direct_entry_input_catalog`; `.../drafts`
  → `direct_entry_list_own_drafts`; `.../batches` (+`/full-profile`);
  `.../duplicate-cccd-report`; `.../session`.

### Document upload/finalize/download flow + EXIF fact

`DirectEntryDocumentEditor` (reserve → presigned PUT → finalize, idempotency, 409,
replacement reason) + `DirectEntryCccdManager` (FRONT/BACK) over
`r2-document-storage.ts` (`@aws-sdk/s3-request-presigner`; staging PUT bound to
key/content-type/length, ≤5 min; GET attachment-only, generic filename, ≤2 min).
Strict projection `document-detail-projection.ts`
(`DETAIL_DOCUMENT_TYPES = CCCD_FRONT|CCCD_BACK|EMPLOYMENT_CONTRACT`); MIME/size
from `cccd-document-pair.ts`.

**FACT (R1):** the current pipeline checks MIME/magic/checksum/size but **does
NOT strip EXIF/metadata** — there is no server-side sanitizer. EXIF stripping is
**new backend work** with a mandatory test before the W2S1 release; it must **not**
be documented as reuse.

### Worker directory/detail, payment, project assignment, change-request

- Worker directory: `worker-directory-{contract,api,repository}.ts` →
  `direct_entry_list_workers` (18-key row, no raw PII, `allowed_actions`).
- Entry detail: `document-detail-projection.ts` + `write-repository.readEntry`
  (`direct_entry_read_projection`); canonical `worker_details` only with `pii_view`.
- Payment: `payment-contract.ts` (`PAYMENT_STATES`, `projectPaymentInput(activeBankIds)`,
  masked projection), `payment-{api,repository}.ts`, route.
- Project assignment: `project-admin-{contract,api,repository}.ts` +
  `project-operations-model.ts` (OCC + reason + idempotency + `classifyResponse` +
  `splitAssignments`), keyed by `manager_recruiter_id`.
- Change request: `change-request-*` models/projections (no-self-review, OCC,
  idempotency, reason, immutable audit).

---

## B. W2S1 — Worker portrait + full worker detail

**Portrait contract (R1 — two axes, not one enum):**
- **`origin ∈ { ENROLLMENT, LEGACY_ADDED }`** is the **immutable** marker of the
  *first* portrait. `ENROLLMENT` = captured during new intake; `LEGACY_ADDED` =
  added for a worker who pre-dates the feature and **carries `added_at`**.
- **`is_current` / `current portrait` slot** is a pointer to the latest *approved*
  version. The **first `LEGACY_ADDED` portrait can be `current` at the same time**.
- The server returns a **validated projection**; the client **must not infer**
  origin/current from the `version`, `SUPERSEDED`, `created_at` or record age.
  The **`{original|current|legacy_added}` single-enum is not used.**
- **CASH snapshot** records the **current portrait `document_id` + `version` +
  `checksum`** at submit; the origin marker does not replace the snapshot version.

**Smallest proposal (T0-accept):**
1. **Storage — EXTEND the existing document pipeline, no new abstraction.** Add a
   `WORKER_PORTRAIT` `DocumentType`; reuse reserve→PUT→finalize, MIME/magic/checksum/
   size, private bucket, short-lived access.
2. **Origin/current projection — server-resolved.** Prefer deriving `origin`
   (first-portrait fact) and `is_current` (approved/current pointer) from the
   portrait rows **server-side**; if that cannot be made deterministic, add **one**
   minimal marker (an `origin`/`is_current` column on the portrait row or a tiny
   sibling) — a T0 architecture decision, not a default new abstraction.
3. **Snapshot immutability:** snapshot current portrait doc/version/checksum at CASH
   submit; later portrait changes do not touch the snapshot or force re-review.
4. **Full worker detail — EXTEND the existing entry-detail read** (portrait group,
   per-document completeness, pending change request + last decision) with
   **independent** PII/payment/document redaction; no raw storage key, internal actor
   id or long-lived URL in any projection.
5. **EXIF/metadata sanitizer — NEW backend work** (§A fact) with a **mandatory test
   before the W2S1 release**; not reuse.
6. **Preview delivery — two accepted options:** (1) **same-origin authenticated byte
   stream** (extend the `download` route style; nothing URL-like in the payload);
   (2) a **short-lived signed URL** under the R2 posture (≤2 min, attachment-only,
   generic filename; **never** logged, persisted, or embedded in a label/ARIA).
   Recommendation: option (1). **A short-lived signed URL is allowed** (see §J).

**Do NOT touch:** `direct_entry_change_requests` business rows; the existing
CCCD/contract document types.

---

## C. W2S2 — Accountant assignment

**Identity (R1 — LOCKED, not an open decision):** the accountant identity is
`public.direct_entry_app_users.app_user_id` (account), **independent of any
recruiter/personnel record**. The candidate RPC returns **active accounts only**.
Only active accounts may be assigned.

**Non-overlap invariant (R1 — the `valid_to IS NULL` partial unique is NOT
enough):** within one project the effective intervals must **not overlap at the
DB**. Smallest option: a **PostgreSQL exclusion / non-overlap constraint** on
`(project_id, [valid_from, valid_to))` (e.g. `EXCLUDE USING gist (project_id WITH
=, daterange(valid_from, valid_to, '[)') WITH &&)`), **or** a **current-only**
model (no future-dated assignment) enforced by `UNIQUE (project_id) WHERE valid_to
IS NULL` **only if MVP proves future assignment is not needed**. Recommend the
exclusion constraint (keeps effective-dating without overlap). History is never
overwritten; `A request snapshots accountant + assignment id at submit`; the RPC
must not re-resolve the current assignment to replace an open case's snapshot
accountant. Explicit/bulk transfer = **deferred**.

**RPCs (NEW siblings):** `direct_entry_get_project_accountant`,
`direct_entry_list_project_accountant_assignments`,
`direct_entry_list_accountant_candidates` (active accounts only),
`direct_entry_assign_project_accountant`, `direct_entry_unassign_project_accountant`.

**Capability isolation (R1):** the accountant uses a **salary-domain capability +
a case-scoped projection** limited to the assigned/snapshot accountant. **Do NOT
grant** the broad `change_review`, `pii_view`, `payment_view`, `payment_edit` or
`document_view` bundles merely for salary advance — those tokens open the worker
directory / review / document surfaces. The accountant must **not** see the
recruitment Dashboard, Nhập liệu, the Worker Directory, the change-review queue,
or Admin Catalog because of finance authority.

**Minimal token names (proposal; T0 accepts — no "future" tokens):**
- `salary_advance_submit` — Manager submits/re-submits the mandatory proof.
- `salary_advance_review` — snapshot accountant decides / disburses / reviews proof
  / opens-confirms refund (case-scoped server-side).
- `salary_advance_summary_view` — the basic summary.
- Accountant-assignment administration reuses Full Admin / the catalog-operator
  authority family (or one `salary_advance_admin` sibling if T0 prefers); **no**
  capability is granted "for the future".

**Reuse boundary:** reuse only the project-admin **validators/outcome/OCC/reason/
idempotency/effective-date/UI pattern**. **Do NOT** parameterize/repoint
`project-operations-model` or `manager_recruiter_id`.

---

## D. W2S3 — Salary-advance request

**Data model:** **NEW sibling** salary tables (`direct_entry_salary_advance_requests`
+ items/events/revisions) — reuse change-request **primitives/patterns**, not the
business tables. A W2-S0-B decision; not a default reuse of
`direct_entry_change_requests`.

**Contract:**
- Manager selects a worker **within a project they currently manage** (reuse the
  `managed` audience predicate); the request binds to the **employment entry +
  project**; the DB rechecks Manager/project/worker/accountant assignment at submit.
  A project with no accountant cannot submit.
- **Money (R1):** **PostgreSQL `bigint`** for the amount; the **wire/API uses a
  canonical positive decimal string** (never `float` and never a JSON number), so
  precision does not depend on JavaScript numbers. **Hard ceiling = Owner/T0 open
  decision** (the survey does not pick a number).
- **Method:** `CASH | BANK_TRANSFER`.
- **One open request per employment entry — DB-enforced (R1), not
  check-then-write.** Open set is exactly
  `REQUESTED, APPROVED, DISBURSED_WAITING_PROOF, PROOF_SUBMITTED, PROOF_REJECTED,
  REFUND_REQUIRED`; closed set is `REJECTED, COMPLETED, REFUNDED`. Enforce with a
  **partial unique index/constraint** over the open states.
- **Snapshot the accountant assignment at submit; no-self-review; OCC +
  idempotency + reason + immutable audit.**
- **State:** `REQUESTED → REJECTED | APPROVED`.
- **CASH:** require `current portrait READY` **checked at submit**; snapshot current
  portrait document/version/checksum.
- **BANK_TRANSFER:** no portrait; snapshot `bank` (active catalog) + `account_number`
  (text, leading zeros) + `account_holder_name`; **manual ownership review, never
  auto-concluded**; masking in lists; **no raw bank data in URL/log/error/audit**
  (canonical hash).
- **Strict salary-specific projection/API/RPC. Do NOT import AI-report
  `projectReviewRequest`.**

**RPCs (NEW siblings):** `direct_entry_create_salary_advance_request`,
`direct_entry_read_salary_advance_request` (case-scoped),
`direct_entry_list_salary_advance_requests`, `direct_entry_decide_salary_advance_request`.

## E. W2S4 — Disbursement, proof, AI signal

- `APPROVED → DISBURSED_WAITING_PROOF`: **snapshot accountant** marks disbursed
  (actor/time/amount/method); **no partial disbursement**.
- **Evidence storage (R1):** the Manager **proof** and the optional accountant
  **supporting document** are **salary-request/disbursement sibling records**; only
  the upload/storage **transport** is reused. **Do NOT** put financial evidence into
  the candidate/worker document history (`direct_entry_document_versions`).
- The accountant document is **optional supporting evidence only** — it does not
  replace the Manager proof and does not advance the state.
- **Manager submits/resubmits the mandatory proof** (new proof version + new AI
  check; history never overwritten).
- Proof bound to **request version + disbursement event + amount + method + proof
  version**; a stale/wrong-case proof is rejected.
- CASH: **human** compares the snapshot portrait with the cash-envelope proof.
  BANK_TRANSFER: **financial** comparison (bank/STK/holder/amount/time). **No claim
  that a bill verifies a face; no face recognition.**
- **AI (advisory only):** states `PENDING|LOW_SYNTHETIC_RISK|REVIEW_REQUIRED|
  INCONCLUSIVE|UNAVAILABLE`; never auto approve/reject; `REVIEW_REQUIRED` override
  and `UNAVAILABLE` continuation require a reason; **idempotency (R1) scoped to the
  server-side tuple `(proof document/version, checksum, provider/model/config
  version)` — never a global checksum dedupe, and the checksum is never exposed to
  the client or logs**; store provider/model/version/`checked_at`; send only the
  **metadata-stripped proof image** (never portrait/CCCD/name/STK/project);
  **server-only secret**; webhook signature/replay **only if** the provider needs a
  webhook. Provider/retention/training/cost/SLA = **open decision**.
- **RPCs (NEW siblings):** `direct_entry_mark_salary_advance_disbursed`,
  `direct_entry_submit_salary_advance_proof`,
  `direct_entry_decide_salary_advance_proof`,
  `direct_entry_attach_salary_advance_supporting_document` (optional evidence).
  The AI check is a server-only adapter call (metadata-stripped proof) reusing the
  AI gateway's provider-adapter/`generateStructured` shape — **not** the AI-report flow.

## F. W2S5 — Refund + basic summary

```
PROOF_SUBMITTED
├── COMPLETED
└── PROOF_REJECTED
     ├── PROOF_SUBMITTED     (Manager resubmits)
     └── REFUND_REQUIRED
          └── REFUNDED
```
- **No `PROOF_SUBMITTED → REFUND_REQUIRED` directly. Refund locked authority =
  snapshot accountant only; Full Admin refund break-glass = open decision (not
  granted). No refund from `COMPLETED`. Append-only, no partial.**
- **RPCs (NEW siblings):** `direct_entry_open_salary_advance_refund`,
  `direct_entry_confirm_salary_advance_refund`.
- **Basic summary (MVP):** presets **Hôm nay / Tuần này / Tháng này**; server-derived
  KPI + per-project and per-method tables; cashflow `disbursed_at`, reconciliation
  `completed_at`, refund `refunded_at`; **Asia/Bangkok**. **No trend chart, export,
  period comparison or forecast.** No client aggregation.

---

## G. Reuse decision matrix

| Concern | Decision | Rationale |
|---|---|---|
| actor/session/capability/scope | **REUSE_UNCHANGED** | `getDirectEntryActor`, `direct_entry_resolve_actor_context`, `guardApiSession`, `decideSessionPageAccess`, `direct_entry_has_capability/scope`; **new salary tokens** for the salary domain. |
| project authority | **REUSE_UNCHANGED** | `direct_entry_actor_can_access_project` + current PM assignment predicate. |
| change-request primitives | **DO_NOT_REUSE (table) / REUSE pattern** | reuse the patterns; do not insert salary rows into `direct_entry_change_requests`. |
| project assignment primitives | **NEW_SIBLING** | accountant sibling keyed by `app_user_id` with a DB non-overlap invariant; do not repoint `manager_recruiter_id`. |
| payment/bank catalog | **EXTEND_EXISTING** | reuse `direct_entry_banks` + the masked projection/allowlist; the salary case-scoped projection delivers the minimum bank view (no broad `payment_view`). |
| worker directory/detail | **EXTEND_EXISTING** | add portrait/completeness/pending-request groups to the entry-detail read; keep capability redaction. |
| document storage | **EXTEND_EXISTING (transport only)** | reuse `r2-document-storage` for the portrait + proof **transport**; portrait extends the document pipeline, **proof/supporting evidence are salary sibling records** (not candidate document history). |
| audit/revision/idempotency | **REUSE_UNCHANGED** | `direct_entry_audit_events`, `direct_entry_revisions`, `direct_entry_rpc_idempotency`, `direct_entry_payload_hash`. |
| EXIF/metadata stripping | **NEW (required)** | the current pipeline does not strip EXIF; add a server-side sanitizer + test before W2S1 release. |
| reporting aggregation | **REUSE pattern / NEW_SIBLING projection** | reuse the server-derived read-model pattern; the salary summary is its own projection. |
| AI gateway/provider adapter | **REUSE pattern / NEW adapter call** | reuse the gateway's provider-adapter/`generateStructured` shape server-only; **do not** reuse the AI-report `projectReviewRequest` flow; scoped idempotency tuple. |

---

## H. Smallest backend touch set (survey only — no files created)

| W2S | Extend existing | New (required) | Do NOT touch | Migration boundary |
|---|---|---|---|---|
| W2S1 | document pipeline transport (+`WORKER_PORTRAIT`), entry-detail read | portrait origin/current projection (+optional minimal marker); **EXIF sanitizer + test**; same-origin preview stream (or signed-URL path) | `direct_entry_change_requests`; existing CCCD/contract types | one append-only migration (portrait marker + projection) |
| W2S2 | project-admin validator/OCC/reason/idempotency patterns | `direct_entry_project_accountants` (app_user_id, **non-overlap constraint**) + 5 sibling RPCs + Admin API/route + salary capability tokens | `project-operations-model`, `manager_recruiter_id`, `direct_entry_project_manager_assignments` | one append-only migration |
| W2S3 | `direct_entry_banks`, masked projection, worker `managed` audience | salary request tables (**bigint** + decimal-string wire) + partial-unique open-state constraint + 4 sibling RPCs + strict contract/api/repository/route | AI-report `projectReviewRequest`; change-request business tables | one append-only migration |
| W2S4 | AI gateway adapter shape, document **transport** | salary **sibling** proof/disbursement-evidence tables + 3–4 sibling RPCs + scoped AI-check adapter call | `direct_entry_document_versions` (candidate history); face-recognition/AI-report flow | same/later migration |
| W2S5 | `p1-date-presets`, the server-derived summary pattern | refund RPCs + summary projection/route | trend charts, export, period comparison | one append-only migration (refund/events + summary projection) |

**Migration boundary:** Wave 2 needs **new append-only migrations**; the slot is
**observed only (#87)** and **not reserved**; T0 allocates it on the implementation
branch.

---

## I. Exact API/RPC contract proposal (shape)

For every new route/RPC: **actor resolved server-side** (never sent); exact request
allowlist; strict fail-closed projections; per-capability redaction; OCC
`expected_version`; idempotency `Idempotency-Key` + `direct_entry_rpc_idempotency`;
amount as a **canonical positive decimal string** on the wire; errors per the
existing taxonomy (`denied→403`, `not-found→404`, `invalid→400`, `conflict→409`,
`unavailable→503`, `INVALID_FILTER`); `private, no-store`; keyset cursors ≤100; one
immutable `direct_entry_audit_events` row (`action`, `capability`, `scope_kind`,
`outcome`, `denial_code`, `reason_id`, non-PII `resource_ref`).

**Allowed/denied matrix (summary):** Manager (`salary_advance_submit`) = create +
resubmit proof + read own; snapshot accountant (`salary_advance_review`) = decide/
disburse/proof-decide/refund via a **case-scoped projection**; summary
(`salary_advance_summary_view`); Full Admin = read + audit only (no unlocked refund
break-glass); unauthenticated / cross-project = denied by RPC scope. **Client never
sends authority, scope, audience or actor.**

---

## J. Acceptance & mutation matrix (R1)

**Acceptance (added/changed items in bold):** IDOR/cross-project denied; **portrait
origin marker ∈ {ENROLLMENT, LEGACY_ADDED} is immutable and `is_current` is a
separate pointer; the first `LEGACY_ADDED` may be current; the client never infers
origin/current from version/SUPERSEDED/timestamp**; CASH requires the **current**
portrait `READY` at submit; **EXIF/metadata is stripped server-side (new work with a
test)**; BANK_TRANSFER without portrait; **accountant identity = app_user_id;
assignment intervals never overlap at the DB; candidates are active accounts only**;
**the accountant uses the salary-domain capability + a case-scoped projection and
cannot see Dashboard/Nhập liệu/Worker Directory/change-review queue/Admin Catalog**;
**amount stored as bigint and carried as a canonical decimal string, never float/JSON
number**; **exactly one open request per employment entry, DB-enforced**; accountant
snapshot holds across reassignment; no-self-review; double-submit/retry idempotent;
**proof + supporting evidence are salary sibling records (not candidate document
history)**; **AI idempotency is scoped to (proof doc/version, checksum,
provider/model/config version) with no client/log checksum exposure**; proof actor =
Manager + version binding; no direct `PROOF_SUBMITTED → REFUND_REQUIRED`; refund only
by the snapshot accountant, never from `COMPLETED`; **a short-lived signed URL is
allowed (R2 posture), long-lived/raw storage key/logged/persisted/labels forbidden**;
summary reconciliation/timezone correct.

**Mutation probes (must go RED):** drop the per-row scope check; re-resolve the
current accountant; remove OCC; accept a stale proof version; put financial evidence
into `direct_entry_document_versions`; expose a checksum to the client/log; use a
**global** checksum for AI idempotency; store the amount as a JSON number/float;
implement one-open-request as check-then-write instead of a DB constraint; use a
`valid_to IS NULL` unique that allows overlapping intervals; return a **long-lived**
signed URL, a raw storage key, or log/persist/label a URL; grant
`change_review`/`pii_view`/`payment_view`/`payment_edit`/`document_view` to the
accountant for salary; allow `PROOF_SUBMITTED → REFUND_REQUIRED`; open
`REFUND_REQUIRED` from `COMPLETED` or by the Manager; let the accountant document
advance the state; import AI-report `projectReviewRequest`; recompute summary totals
on the client.

---

## K. Open decisions & stop conditions

**Open (T0/Owner; do not self-lock):** maximum advance amount (and per-project);
Full Admin refund break-glass scope; **stranded-case recovery contract** (see
below); AI provider/retention/training/cost/SLA; WebP support at runtime;
worker-detail shell; PDF preview vs signed-download fallback; exact salary capability
token names (proposed in §C). **Removed as open (now LOCKED):** accountant identity
(`app_user_id`).

**Stranded-case recovery — GO-LIVE BLOCKER:** if the snapshot accountant is disabled
or loses the mapping while a case is open, one of the following must exist before
go-live — (a) an audited **Full Admin break-glass**, (b) an explicit **case transfer**,
or (c) **block disable/unassign** while open cases exist. The survey does **not**
choose the option or grant break-glass; T0/Owner decides (master plan open decision #7).

**Stop conditions for go-live:** any IDOR/cross-project leak; a long-lived/raw
storage-key/signed-URL leak (or a logged/persisted/labelled URL); raw PII/bank in
logs/audit; AI able to auto-decide or `UNAVAILABLE` treated as safe; a client/log
checksum exposure; self-review possible; CASH without a current ready portrait at
submit; **EXIF not stripped**; **overlapping accountant assignment intervals**;
**amount stored/sent as float/JSON number**; **more than one open request per
employment entry**; proof not Manager-submitted (or an accountant document advancing
the state); a refund opened by the Manager/from `COMPLETED`/directly from
`PROOF_SUBMITTED`; a live re-resolution replacing an open case's snapshot accountant;
**no stranded-case recovery contract**; unreconciled summary totals; an
unsigned/forged webhook accepted.

---

## L. Explicit no-implementation statement

This lane is **survey-only**. It changes **one** file
(`docs/handoffs/w2-s0-b-backend-api-reuse-survey.md`). No source, schema, SQL, API,
UI, test, package, dependency or lockfile change; no migration; no Production
query/apply; no deploy; no browser/UAT; no Pre-W2 branch/worktree touched; no W2
implementation opened; **no migration reserved**.

---

## M. Revision log (R1)

R1 is an append-only targeted repair of the W2-S0-B survey (`7ba2de5`) on the same
branch. It closes the ten R1 items and keeps the R0 factual/reuse baseline:

1. **Capability isolation** (§C/§G/§I): the accountant uses a **salary-domain
   capability** (`salary_advance_review`) + a **case-scoped projection**; the broad
   `change_review`/`pii_view`/`payment_view`/`payment_edit`/`document_view` bundles
   are **not** granted for salary; the accountant cannot see Dashboard/Nhập
   liệu/Worker Directory/change-review queue/Admin Catalog; minimal token names are
   proposed with no "future" tokens.
2. **Accountant identity + non-overlap** (§C): `app_user_id` is **locked** (removed
   from open decisions); same-project intervals must **not overlap at the DB**
   (exclusion constraint, or current-only if MVP proves no future assignment); the
   `valid_to IS NULL` partial unique alone is insufficient; candidate RPC returns
   **active accounts only**.
3. **Portrait semantics** (§B): replaces the single enum with the **two-axis**
   contract — immutable `origin ∈ {ENROLLMENT, LEGACY_ADDED}` + an `is_current`
   pointer; the first `LEGACY_ADDED` may also be current; no client inference from
   version/SUPERSEDED/timestamp; CASH snapshots the **current** portrait
   doc/version/checksum.
4. **EXIF** (§A/§B): corrected the false reuse claim — the pipeline does **not**
   strip EXIF today; stripping is **new backend work** with a mandatory test before
   the W2S1 release.
5. **Money** (§D): `bigint` in the DB; **canonical positive decimal string** on the
   wire; no float/JSON number; the ceiling stays an Owner/T0 decision.
6. **Open-request invariant** (§D): the exact open/closed sets are stated and
   **DB-enforced by a partial unique index/constraint**, not check-then-write.
7. **Evidence storage** (§E/§G): proof + optional accountant supporting document are
   **salary sibling records**; only the upload/storage **transport** is reused; no
   evidence in the candidate `direct_entry_document_versions` history.
8. **AI idempotency** (§E): scoped to the tuple `(proof document/version, checksum,
   provider/model/config version)`; no global checksum dedupe; no checksum exposed
   to client/log.
9. **Signed-URL wording** (§B/§J): a **short-lived signed URL remains allowed** (R2
   posture); the memo now forbids only long-lived URLs, raw storage keys, logging,
   persistence and label/ARIA embedding — the earlier blanket "no signed-URL leak"
   phrasing that could negate the allowed short-lived URL is removed.
10. **Stranded-case recovery** (§K): recorded as a **go-live blocker** with the three
    options (audited Full Admin break-glass / explicit case transfer / block
    disable-unassign while open cases exist); the survey does **not** grant
    break-glass.

Acceptance, mutation probes, stop conditions, open decisions and this log were
updated in lockstep. **Master-plan SHA-256 note (see header):** the brief's pinned
hash `3EDCF283…` does not match the on-disk `E439EC67…`; the on-disk plan is the
newer T0 revision whose W2-S0-B ledger entry states exactly these ten items, so R1
proceeds against the on-disk content and flags the mismatch rather than guessing.