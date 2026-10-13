# W2-S0-C — Wave 2 contract, security & integration survey

> **Status:** `W2_S0_C_CONTRACT_SECURITY_INTEGRATION_SURVEY_PASS_AWAITING_T0_REVIEW`
> **Base SHA:** `origin/main@7afc02632f83a4cddff7ddfe75f7eb5308f1a969`
> **Branch / worktree:** `audit/w2-s0-c-contract-security-integration-survey` @
>   `C:\CodeApp\BI-w2-s0-c-contract-security-integration-survey`.
> **Migration observation:** 85 files on current main; last =
>   `20261011180000_p3_w05b_a_team_reporting.sql`. **Next-available = #86**
>   (observation only; **no slot reserved**).
> **Authority:** repo source/contracts win over any historical summary. Preflight
>   read `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`.
> **Document budget:** `DELTA_ONLY`. **Survey-only. No implementation, no
>   source/schema change, no Production query.** Pre-W2 branches untouched.

---

## 0. Preflight findings (reconcile before implementation)

1. **No authoritative Wave 2 Lean plan exists on `main`.** `docs/` has **no**
   `W2`/`wave2`/`disburse`/`refund`/`portrait`/`accountant` plan file, and the
   external memory contains **no** `W2S1`–`W2S5` section. Wave 2 Lean is defined
   only by this task brief → **T0 must publish/confirm the plan before backend
   work**; this memo locks the contract from the brief + current source.
2. **No T1A/T1B Wave 2 memo exists** on `main`. This survey is therefore the
   current-main-independent baseline; any later T1A/T1B survey must be reconciled
   against §8–§10 here.
3. **W2S1 (portrait), W2S4 (disbursement/proof), W2S5 (refund) are greenfield.**
   Grep over `src/**` and `supabase/migrations/**` finds **zero** `portrait`,
   `disburse`, `refund` or `advance_payment` definitions. No schema, RPC or UI
   exists. Wave 2 Lean therefore needs **new tables + migrations + RPCs** (below).
4. **W2S2 (accountant assignment) is partly greenfield.** There is **no**
   first-class accounting role/bundle on `main`: "accounting" exists only as a
   test fixture (`direct-entry-v2.test.mjs:490–518`, capabilities `change_review`,
   `entry_privileged_edit`, `employment_status.apply`, `payment_view`,
   `payment_edit`, `pii_export` denied) and as the shared catalog-operator
   capability `catalog_master_manage` (`registry-capability.ts:62`). The external
   memory's Accounting bundle is policy, **not implemented source**.
5. **W2S3 (request/decision) has a reusable engine.** The P1.6/W04 change-request
   engine (`direct_entry_change_requests`/`_items`/`_revisions`,
   `direct_entry_create_change_request` / `_decide_change_request` /
   `_apply_change_item`, propose/approve/reject/withdraw APIs, no-self-review,
   OCC, idempotency, reason, immutable audit) is exactly the request/decision
   primitive to reuse — **do not build a second workflow engine**.
6. **AI is off on current main.** `AI_REPORTS_ENABLED` / `AI_SETTINGS_ENABLED`
   must not be `true`; AI actor/rate-limit work is deferred to P3.3. Any W2S4
   "AI signal" must be **advisory and provider-gated** (§6).
7. **Pre-W2 branches not touched**; primary checkout
   (`codex/vps-deploy-hardening`) not touched.

---

## 1. Wave 2 Lean scope (locked)

| Lane | Scope (locked) |
|---|---|
| **W2S1** | Worker **portrait** capture/upload + versioned portrait asset; original/current/legacy-added; snapshot into a disbursement/salary request. |
| **W2S2** | **Accountant assignment**: assign the reviewer (accountant) accountable for a disbursement case; effective-dated assignment; re-resolve on every transition. |
| **W2S3** | **Request / decision**: proposer submits a disbursement request; assigned accountant approves/rejects with reason, OCC, idempotency, immutable audit, no self-review. |
| **W2S4** | **Disbursement / proof / AI signal**: record the disbursement (CASH or BANK_TRANSFER); capture proof (cash photo / transfer receipt); manual proof review; advisory AI signal. |
| **W2S5** | **Refund / basic summary / release**: refund a disbursement; basic summary view; release/close the case. |

**Deferred (explicitly out of Wave 2 Lean):** full Accounting/Admin CRUD console;
multi-manager/project CRUD (P2.5 scope); `pii_export` (Pre-W2 only); AI Production
activation + authenticated AI actor + atomic rate limit (P3.3); invite/forced-reset/
MFA/recovery (P3.2); commission/payroll engines; generic audit explorer; any second
workflow/RBAC/audit framework; period-over-period/cross-team analytics (P4).

---

## 2. State machine and transition actors (locked)

Single case aggregate `disbursement_case`; every transition is a server RPC with
reason + expected_version (OCC) + idempotency + immutable audit + no-self-review.

```
DRAFT
  --submit (proposer)----------------------------> PENDING
PENDING
  --approve (assigned accountant, != proposer)--> APPROVED
  --reject  (assigned accountant, != proposer)--> REJECTED
  --cancel  (proposer | accountant)-------------> CANCELLED
APPROVED
  --disburse CASH   (accountant; requires portrait READY) --> DISBURSED
  --disburse TRANSFER (accountant; requires bank details; NO portrait) --> DISBURSED
  --cancel  (accountant)-------------------------> CANCELLED
DISBURSED
  --submit_proof (proposer | accountant)--------> PROOF_SUBMITTED
PROOF_SUBMITTED
  --accept_proof (accountant; AI advisory only)--> PROOF_ACCEPTED
  --reject_proof (accountant; reason required)---> PROOF_REJECTED
PROOF_REJECTED
  --resubmit_proof (proposer | accountant)------> PROOF_SUBMITTED
PROOF_ACCEPTED
  --close (accountant)---------------------------> CLOSED
CLOSED | DISBURSED | PROOF_* 
  --request_refund (proposer | accountant)-------> REFUND_REQUESTED
REFUND_REQUESTED
  --approve_refund (accountant)------------------> REFUND_APPROVED
  --reject_refund  (accountant)------------------> back to prior state
REFUND_APPROVED
  --record_refund (accountant)-------------------> REFUNDED
```

**Transition actors (locked):** `proposer` (case creator / authorized worker
owner); `accountant` = the **effective assigned accountant** resolved at the
moment of the transition (never cached in the client); `admin` (full-Admin
triple) as break-glass with reason. **A transition must re-resolve the assigned
accountant inside the RPC**; a reassignment mid-flow invalidates the previous
accountant's authority. **No self-review**: the proposer may never approve/reject
their own case (reuse the change-request no-self-review rule).

---

## 3. Portrait contract (W2S1)

- **Assets:** each worker (or case) has a versioned portrait asset with an
  explicit **kind**: `original` (first capture), `current` (latest accepted), and
  `legacy_added` (backfilled for pre-existing workers with no original). The
  asset is immutable per version; re-capture creates a new version.
- **Snapshot into the request:** when a salary/disbursement request is created,
  it records the **portrait version id** in effect at that instant (an immutable
  reference), so a later portrait change does not silently rewrite the request's
  evidence.
- **CASH requires `portrait.status = READY`.** A CASH disbursement fails closed if
  the snapshot portrait is missing or not ready.
- **BANK_TRANSFER does NOT require a portrait** (it requires bank details instead).
- **Classification:** the portrait is high-sensitivity PII; it is stored via the
  existing document storage posture (§9) — short-lived, attachment-only,
  generic-filename presigned access; no storage key or signed URL returned to the
  list projection or written to logs.
- **No automatic portrait→identity conclusion** (no face recognition; §5/§6).

## 4. Bank-transfer contract (W2S4)

- **Fields (locked):** `bank` (from the active `direct_entry_banks` catalog),
  `account_number` (stored as **text**, leading zeros preserved),
  `account_holder_name`.
- **Manual accountant ownership review:** the assigned accountant must manually
  confirm the account holder/ownership; the system records the decision + reason.
- **No automatic ownership conclusion:** a name-match between the worker and the
  account holder is at most an **advisory signal** and must never auto-approve,
  auto-reject or auto-disburse.
- **Masking/logging/audit:** masked display (`••••` + last 4) in read/list
  projections unless `payment_view`; **no raw account number / bank data in
  logs, errors, audit text or `resource_ref`**; audit stores a canonical hash
  (reuse `direct_entry_payload_hash`) not the raw values.

## 5. Proof-review contract (W2S4)

- **CASH:** manual **image comparison** by the accountant — the cash proof photo
  is compared with the case/portrait evidence **by a human**.
- **BANK_TRANSFER:** **financial comparison** — the transfer receipt is compared
  against the request amount/reference/receiver; a bank transfer receipt is
  financial evidence, not identity evidence.
- **Locked:** there is **no claim that a bill/receipt verifies a face**, and
  **no automated face recognition** is performed anywhere in Wave 2.
- Proof is bound to `(case_id, case_version, request_amount)`; a proof whose
  `case_version` does not match the current version is rejected (proof/version
  mismatch, §7).

## 6. AI-result posture (W2S4)

- **Advisory only.** The AI signal may surface to the accountant but must **never
  auto-approve or auto-reject** a case/proof/refund.
- **Override reason:** an accountant who overrides the AI signal must supply a
  reason, captured in the immutable audit.
- **"Unavailable" is not "safe".** A provider error/disabled/timeout must resolve
  to **needs-manual-review**, never to an implicit accept.
- **Audit:** record provider, model and the check timestamp (and the advisory
  verdict) in the immutable audit — **no raw portrait/PII** in the audit.
- **Third-party privacy/retention:** no portrait/CCCD/bank value may be sent to a
  provider without an explicit, reviewed data-processing decision; retention and
  deletion of any provider-submitted data must be specified before enablement.
  Default posture on current main: **AI disabled** (feature flag not `true`).

---

## 7. Threat / risk review (locked controls)

| # | Threat | Locked control |
|---|---|---|
| R1 | **IDOR / cross-project access** | Server-side authority only; per-row audience resolved in the RPC (reuse `direct_entry_actor_can_access_project` / project-manager assignment). A client-supplied project/case id is never authority. |
| R2 | **Accountant reassignment mid-flow** | Re-resolve the effective assigned accountant inside every transition; a stale accountant's decide/disburse is rejected (OCC + assignment check). |
| R3 | **Double-submit / replay** | OCC `expected_version` + `direct_entry_rpc_idempotency` begin/finish; the same logical action maps to one record. |
| R4 | **Proof/version mismatch** | Proof bound to `(case_id, case_version)`; stale proofs rejected. |
| R5 | **Signed-URL leakage** | Reuse the R2 presign posture: ≤2-minute GET, attachment-only, generic filename; never log/return storage keys or URLs; list projections carry no `signedUrl`/`bucket`. |
| R6 | **Raw PII in logs** | Sanitized logs/errors (no CCCD, portrait, bank values, name); audit uses a canonical hash, not raw values. |
| R7 | **Provider outage / cost exhaustion** | AI provider-gated + off by default; bounded/rate-limited calls; outage = needs-manual-review; no unbounded retries. |
| R8 | **Forged webhook** | Any inbound webhook (provider/proof/receipt) verifies an HMAC signature + timestamp, is idempotent, and rejects replay. |
| R9 | **Worker portrait changed during review** | The request holds an immutable portrait version snapshot; a portrait change after submission invalidates the review binding and forces re-review. |
| R10 | **Financial totals drift** | Totals come from one server-side authoritative ledger/derivation; no client recompute; a reconciliation test pins totals vs the recorded disbursement/refund rows. |

---

## 8. Deliverables

### 8.1 Authoritative contract matrix

| Surface | Authority | Writes | Reads | Audit |
|---|---|---|---|---|
| Portrait asset | server RPC, `pii_view`/owner authority | new versioned row | masked ref until `pii_view` | immutable event |
| Accountant assignment | full-Admin / authorized assigner, reason+OCC | effective-dated assignment | self + admin | immutable event |
| Disbursement request/decision | change-request engine (reused) | request/item/revision | proposer + assigned accountant | immutable event |
| Disbursement record | assigned accountant, reason+OCC+idempotency | disbursement row | accountant + admin | immutable event |
| Proof asset | proposer/accountant | versioned document (R2 posture) | accountant | immutable event |
| AI signal | provider-gated advisory | advisory row only | accountant | provider/model/timestamp |
| Refund | assigned accountant | refund row | accountant + admin | immutable event |
| Summary/release | server-derived | none | authorized | none |

### 8.2 Data-classification table

| Data | Class | Handling |
|---|---|---|
| Portrait image | high-sensitivity PII (quasi-biometric) | short-TTL attachment presign; no logs; `pii_view` |
| CCCD / name / DOB / phone / address | direct_pii | `pii_view`; masked in lists |
| Account number / bank / holder | financial | `payment_view`; masked (`••••`+last4); hash in audit |
| Proof image / receipt | financial evidence | R2 posture; no face claim |
| Amount / totals | financial | server-authoritative; reconciliation |
| Reason text | sensitive_free_text | bounded; no PII echo |
| `auth_subject`/`app_user_id`/UUIDs/storage keys | internal | never client-visible |

### 8.3 Acceptance E-list

E1 portrait versioning (original/current/legacy_added); E2 portrait snapshot bound
to the request; E3 CASH denied without `portrait READY`; E4 BANK_TRANSFER succeeds
without portrait; E5 request→decision with no-self-review; E6 reassigned accountant
cannot decide; E7 disbursement requires assigned-accountant authority + reason +
OCC; E8 proof bound to case_version (stale rejected); E9 CASH manual image compare;
E10 BANK_TRANSFER financial compare; E11 AI never auto-approves/rejects; E12 AI
override requires reason; E13 AI unavailable ⇒ needs-manual-review; E14 refund
approval/rejection path; E15 basic summary totals reconcile; E16 all lists masked
without the required capability; E17 no signed URL/storage key in any projection or
log; E18 `all`/cross-project access denied by server authority.

### 8.4 Mutation M-list

M1 drop the per-row project check → IDOR red; M2 cache the accountant instead of
re-resolving → reassignment red; M3 remove OCC → replay red; M4 accept a stale
proof version → proof-match red; M5 return the signed URL in a list → leakage red;
M6 log a raw CCCD/bank/portrait → log-scan red; M7 let AI auto-approve → AI red;
M8 treat AI-unavailable as accept → AI-safety red; M9 allow self-review → no-self-
review red; M10 let CASH proceed without portrait → portrait-gate red; M11 recompute
totals on the client → totals-drift red; M12 accept an unsigned webhook → webhook
red.

### 8.5 Integration order

1. T0 confirms the Wave 2 Lean plan (reconcile §0).
2. T1B: schema + RPCs (portrait, assignment, case state machine reusing the
   change-request engine, disbursement, proof, refund) + focused tests. **One
   backend owner** to avoid migration/RPC drift.
3. T1A: UI (portrait capture/review, accountant queue, proof review, summary).
4. T1C: allowed/denied + threat verification.
5. T0: migration apply, deploy, Owner UAT.

### 8.6 UAT checklist (Owner)

Portrait capture for a worker without a portrait; CASH blocked without portrait;
BANK_TRANSFER without portrait; request→approve/reject by the assigned accountant;
reassign accountant mid-flow; disbursement + proof upload; proof accept/reject;
refund; basic summary totals; masked vs full views per capability; AI advisory
shown but never decisive; no PII/URL leakage in the browser network tab.

### 8.7 Stop conditions for go-live

Any of: an IDOR/cross-project leak; a signed-URL/storage-key leak; a raw PII/bank
value in logs or audit; AI able to auto-approve/reject or an unavailable AI
treated as accept; self-review possible; a CASH case without a ready portrait;
unreconciled financial totals; a forged/unsigned webhook accepted; the Wave 2 Lean
plan still unconfirmed by T0.

---

## 9. Reuse matrix (no new frameworks)

| Concern | Reuse | Do NOT |
|---|---|---|
| Session/actor | `resolveActorForRequest`, `getDirectEntryActor`, `guardApiSession`, `decideSessionPageAccess` | new auth |
| Capability/scope | the 23-token `CAPABILITIES` set + grants/scopes + `direct_entry_has_capability` / `direct_entry_assert_*` | new RBAC engine; role/email/env grants |
| Request/decision | the change-request tables/RPC/API/proposer/reviewer, no-self-review, OCC, idempotency, reason, immutable audit | a second workflow engine |
| Reason/audit/OCC/idempotency | `direct_entry_restricted_reasons`, `direct_entry_audit_events` (+`denial_code`, `scope_kind` incl. `project`), `direct_entry_revisions`, `direct_entry_rpc_idempotency`, `direct_entry_payload_hash` | new audit store; raw PII in logs |
| Payment authority | `payment_view` (masked) / `payment_edit`; `direct_entry_payments` `bank_id`/`account_number`/`account_holder_name` | bypass payment capability |
| Documents/proof | the R2 storage posture (`@aws-sdk/s3-request-presigner`; ≤2-min GET attachment-only generic filename; ≤5-min PUT bound) | new storage abstraction; leaking keys/URLs |
| AI | the existing AI gateway, provider-gated and off by default | auto-decision; unapproved provider PII egress |
| UI | React 19, Radix UI, Lucide, Card/Alert, existing grid, Recharts, `nuqs` | new component/form/state library |
| Tests | `node:test`, PGlite, existing fixtures/canonical scripts | new test framework |

## 10. Reconciliation points / blockers

- **Wave 2 Lean plan** not on `main` (§0.1) — T0 to publish/confirm.
- **No T1A/T1B W2 survey** to cross-check (§0.2) — reconcile before T1B.
- **Greenfield schema** for portrait/disbursement/proof/refund (§0.3) — new
  append-only migrations are required; the slot is observed only (#86), not reserved.
- **Accounting bundle** is policy, not source (§0.4) — W2S2 must define the exact
  capability/authority set before implementation.
- **AI egress/privacy** (§6) — a reviewed data-processing/retention decision is
  required before any provider receives worker data.

## 11. Explicit no-implementation statement

This lane is **survey-only**. It changes **one** file
(`docs/handoffs/w2-s0-c-contract-security-integration-survey.md`). No source,
schema, SQL, API, UI, package, dependency or lockfile change; no Production
query/apply; no deploy; no browser/UAT; no external-memory edit; no primary-checkout
change; no Pre-W2 branch touched; no T1B/T1A implementation started; **no migration
reserved**.
