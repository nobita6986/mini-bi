# W2-S0-C-R2 — Wave 2 contract, security & integration survey (targeted repair)

> **Status:** `W2_S0_C_R2_CONTRACT_SECURITY_INTEGRATION_SURVEY_PASS_AWAITING_T0_REVIEW`
> **Revision:** R2 — targeted repair of R1 (`8e9d879`) against the Wave 2 master
>   plan `C:\CodeApp\BI-wave-2-master-plan-2026-10-13.md`: corrects the refund
>   source states (`REFUND_REQUIRED` is reachable only from `PROOF_REJECTED`) and
>   removes Full Admin break-glass as an accepted actor (it stays an unlocked
>   Owner/T0 decision). Append-only on the same branch (no amend / no rebase / no
>   force-push).
> **Base SHA:** `origin/main@7afc02632f83a4cddff7ddfe75f7eb5308f1a969`.
> **Branch / worktree:** `audit/w2-s0-c-contract-security-integration-survey` @
>   `C:\CodeApp\BI-w2-s0-c-contract-security-integration-survey`.
> **Migration observation:** 85 files on current main; last =
>   `20261011180000_p3_w05b_a_team_reporting.sql`. **Next-available = #86**
>   (observation only; **no slot reserved**).
> **Authority (order):** the master plan (latest Owner decision) → accepted
>   `main` contracts → this memo. Preflight also read
>   `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md`.
> **Document budget:** `DELTA_ONLY`. **Survey-only. No implementation, no
>   source/schema change, no Production query.** Pre-W2 branches untouched.

---

## 0. Preflight findings

1. **The Wave 2 Lean plan now exists.** The master plan
   `C:\CodeApp\BI-wave-2-master-plan-2026-10-13.md` is the official out-of-repo
   coordination source ("nguồn điều phối chính thức của Wave 2"). The S0 blocker
   "no Wave 2 Lean plan" is therefore **resolved** — no second plan is needed on
   `main`.
2. **Survey ledger (per the master plan):** `W2-S0-A` UI reuse = `ASSIGNED` (T1A,
   not reported); `W2-S0-B` Backend/API reuse = `NOT_ASSIGNED` (T1B busy on Pre-W2);
   `W2-S0-C` = `REVIEWED_R1_REQUIRED` (this R1).
3. **W2S1 (portrait), W2S4 (disbursement/proof), W2S5 (refund) are greenfield.**
   Grep over `src/**` and `supabase/migrations/**` finds **zero** `portrait`,
   `disburse`, `refund` or `advance_payment` definitions. New tables + migrations +
   RPCs are required (slot observed only, not reserved).
4. **W2S2 (accountant assignment) is partly greenfield.** There is **no**
   first-class accounting role/bundle on `main`: "accounting" exists only as a
   test fixture (`direct-entry-v2.test.mjs:490–518`) and as the shared
   catalog-operator capability `catalog_master_manage` (`registry-capability.ts:62`).
5. **W2S3 reuses change-request primitives/patterns — not necessarily the business
   tables.** Reuse the P1.6/W04 engine's **patterns** (no-self-review, OCC,
   idempotency, mandatory reason, immutable audit, propose/decide/withdraw,
   actor-scoped RPC). The salary-advance **data model is a W2-S0-B decision**; this
   memo does **not** lock salary advance into `direct_entry_change_requests`.
6. **AI is off on current main.** `AI_REPORTS_ENABLED` / `AI_SETTINGS_ENABLED` must
   not be `true`; AI actor/rate-limit work is deferred to P3.3. The W2S4 image
   signal is **advisory and provider-gated** (§6).
7. **Pre-W2 branches not touched**; primary checkout (`codex/vps-deploy-hardening`)
   not touched.

---

## 1. Wave 2 Lean scope (locked)

| Lane | Scope (locked) |
|---|---|
| **W2S1** | **Worker Portrait + full worker detail.** A worker detail surface showing everything the server authorizes: portrait, CCCD front/back images, employment contract and other documents, name/employee code/gender/DOB, CCCD + issue date/place per `pii_view`, address/phone per `pii_view`, project/start date/labor type, recruiter/provider, current work status, payment per `payment_view`, pending change request + last decision (if authorized), and per-document-type completeness status. Independent capability-based redaction. |
| **W2S2** | **Accountant assignment**: one effective accountant per project; effective-dated, versioned, audited; the salary-advance request **snapshots the accountant/assignment at submit**. |
| **W2S3** | **Salary-advance request + initial decision**: Manager submits; assigned (snapshot) accountant approves/rejects with reason, OCC, idempotency, immutable audit, no self-review. |
| **W2S4** | **Disbursement + identity review + proof**: mark disbursed (`DISBURSED_WAITING_PROOF`); Manager submits proof; accountant reviews (human); advisory AI image signal. |
| **W2S5** | **Refund + basic summary + UAT**: `REFUND_REQUIRED` → `REFUNDED`; basic summary; W2-R2 gate. |

**Deferred (explicitly out of Wave 2 Lean):** `DRAFT`/cancel flow; explicit
accountant transfer + bulk reassignment; refund after `COMPLETED`/reversal;
partial disbursement/refund; batch approve; general notification center; advanced
summary charts/export/period comparison/forecast; multiple accountants per project;
full Accounting/Admin CRUD console; multi-manager/project CRUD; `pii_export`
(Pre-W2); AI Production activation + authenticated AI actor + atomic rate limit
(P3.3); invite/reset/MFA/recovery (P3.2); a second workflow/RBAC/audit engine.

---

## 2. State machine and transition actors (locked — official)

```
REQUESTED
├── REJECTED
└── APPROVED
     └── DISBURSED_WAITING_PROOF
          └── PROOF_SUBMITTED
               ├── COMPLETED
               └── PROOF_REJECTED
                    ├── PROOF_SUBMITTED ...   (Manager resubmits)
                    └── REFUND_REQUIRED
                         └── REFUNDED
```

**Removed from the current contract (not aliases, not extra transitions):**
`DRAFT`, `PENDING`, `CANCELLED`, `DISBURSED`, `PROOF_ACCEPTED`, `CLOSED`,
`REFUND_REQUESTED`, `REFUND_APPROVED`. A client form that has not been submitted
is **not** a persisted business state. Renaming a state requires a master-plan
change first.

**Transition actors (locked):**
- **REQUESTED** is created by the **Manager** submit; the DB rechecks Manager,
  project, worker and accountant assignment **at submit**. A project with no
  accountant cannot submit.
- **REQUESTED → REJECTED | APPROVED**: the **snapshot accountant** of the case
  decides; reject requires a reason; **no self-review** (the manager may not
  decide their own request).
- **APPROVED → DISBURSED_WAITING_PROOF**: the snapshot accountant marks the
  disbursement after money is actually handed over; stores actor, time, amount and
  method; **no partial disbursement**.
- **DISBURSED_WAITING_PROOF → PROOF_SUBMITTED**: the **Manager** submits the
  mandatory proof.
- **PROOF_SUBMITTED → COMPLETED | PROOF_REJECTED**: the snapshot accountant reviews
  (human); reject requires a reason. `PROOF_SUBMITTED` has **no** direct path to
  `REFUND_REQUIRED`.
- **PROOF_REJECTED → PROOF_SUBMITTED**: the **Manager** resubmits (new proof
  version + new AI check).
- **PROOF_REJECTED → REFUND_REQUIRED → REFUNDED**: **only the case's snapshot
  accountant** (the locked MVP authority) opens `REFUND_REQUIRED` (reason
  required); the accountant confirms the money was received back; refund is an
  append-only event; **no partial refund**; **no refund from `COMPLETED`** in MVP.
  (A Full Admin refund break-glass is an **unlocked** Owner/T0 decision — §10 — and
  is **not** an accepted actor here.)
- **Accountant snapshot:** the request **snapshots the accountant/assignment at
  submit**; the RPC must **not** silently re-resolve the *current* assignment to
  replace the snapshot accountant of an open case. Explicit transfer and bulk
  reassignment are **deferred**.
- Every transition is a server RPC with mandatory reason (where required) +
  `expected_version` (OCC) + idempotency + immutable audit.

---

## 3. Portrait + worker-detail contract (W2S1)

- **Full worker detail (§1):** the detail surface renders every authorized group
  (portrait, CCCD front/back, contract + documents, identity/placement, PII,
  payment, change-request state, document completeness). The shell (drawer/dialog/
  page) is a UI-survey decision; **the content groups are fixed** and none may be
  dropped.
- **Redaction:** PII, payment and document groups are **redacted independently** per
  capability; the client never infers authority from the tab or a display role. No
  raw storage key, internal actor id or long-lived signed URL is returned.
- **Assets:** versioned portrait with an explicit **kind**: `original`/enrollment
  (first accepted, never overwritten), `current` (latest approved), `legacy_added`
  (first portrait added for an old worker, showing the added date — **not** assumed
  to be the onboarding photo). Old versions stay in audit/history.
- **Snapshot is immutable.** A salary-advance request continues to use the portrait
  version/checksum **snapshotted at submit**. **A newer portrait does not change or
  invalidate an existing request and does not force re-review.** The review UI may
  *show* that a newer portrait exists for reference, but the decision stays bound to
  the request's immutable snapshot.
- **CASH requires `portrait.status = READY`, checked at SUBMIT** (not deferred to
  disbursement); if missing, the UI guides the Manager to add the portrait first.
- **BANK_TRANSFER does NOT require a portrait** (it requires bank details, §4).
- **Storage:** reuse private R2 + the existing signed upload/download posture;
  dedicated document type `WORKER_PORTRAIT`; MIME/magic-byte/checksum/size checks;
  strip sensitive EXIF/metadata; short-lived `private, no-store`; **no crop editor,
  camera, gallery, face recognition or portrait AI in W2S1**.

## 4. Bank-transfer contract (W2S3/W2S4)

- **Fields (locked):** `bank` (active `direct_entry_banks` catalog),
  `account_number` (text, leading zeros preserved), `account_holder_name`; snapshot
  into the request at submit.
- **Manual ownership review at the accountant review.** String normalization only
  *assists* comparison; it **never concludes ownership**. If the accountant cannot
  confirm, they **reject with a reason** so the Manager fixes the details and
  resubmits.
- **Masking/logging/audit:** the full account number is shown only to the manager
  who created the request, the responsible accountant and Full Admin; all other
  lists are masked (`••••` + last 4). The account number never enters a URL,
  analytics, client log or error log; audit stores a canonical hash (reuse
  `direct_entry_payload_hash`), not raw values.
- **Changing payee details after a decision** creates a new version/request; no
  silent mutation.

## 5. Proof-review contract (W2S4)

- **Actor:** the **Manager submits and re-submits** the mandatory proof; the
  accountant only reviews and decides. An **accountant-uploaded document is
  optional supporting evidence only** — it does **not** replace the Manager proof
  and does **not** by itself move the case to `PROOF_SUBMITTED`.
- **CASH:** manual **image comparison** by the accountant — the cash proof photo is
  compared with the snapshot portrait **by a human**.
- **BANK_TRANSFER:** **financial comparison** — bank, approved account number,
  recipient name, amount and time/content from the receipt.
- **Locked:** a bank receipt is **not** face-verification evidence; the memo makes
  **no claim that a bill verifies a face**, and **no automated face recognition** is
  performed anywhere in Wave 2.
- **Binding:** each proof is logically bound to the correct **request version,
  disbursement event, amount, method and proof version**; a stale or
  wrong-case proof is rejected. Re-submission creates a new proof version and a new
  AI check; old documents/results are never overwritten.

## 6. AI-result posture (W2S4)

- **Advisory only** — never auto approve/reject.
- **Normalized result:** `PENDING`, `LOW_SYNTHETIC_RISK`, `REVIEW_REQUIRED`,
  `INCONCLUSIVE`, `UNAVAILABLE`.
- **Rules:** `REVIEW_REQUIRED` approve requires an **override reason**;
  `UNAVAILABLE` is **not safe** — continuing requires a manual-review confirmation
  and a reason; the result never proves an image is genuine.
- **Idempotency** by proof checksum (a refresh does not call the provider again);
  **each proof version has its own result**; store provider/model version,
  `checked_at` and state; **no secret/raw PII** in logs.
- **Egress minimization:** send only the **metadata-stripped proof image**; do not
  send portrait, name, CCCD, account number, project or leave reason when the
  provider only needs image bytes.
- **API key is server-only**; any webhook verifies signature + replay protection.
- **Provider retention/training/privacy** must satisfy a T0-accepted decision
  **before** implementation. Default on current main: **AI disabled**.

---

## 7. Threat / risk review (locked controls)

| # | Threat | Locked control |
|---|---|---|
| R1 | **IDOR / cross-project access** | Server/DB authority only; per-row scope resolved in the RPC; a client-supplied project/case id is never authority (worker detail, request, disbursement, proof, refund). |
| R2 | **Accountant reassignment mid-flow** | The case **snapshots** the accountant/assignment at submit; the RPC must not re-resolve the current assignment to replace the snapshot handler of an open case; explicit transfer/bulk reassignment is deferred. |
| R3 | **Double-submit / replay** | OCC `expected_version` + the idempotency pattern; one logical action → one record; proof idempotency by checksum. |
| R4 | **Proof/version mismatch** | Proof bound to request version + disbursement event + amount + method + proof version; stale/wrong-case rejected. |
| R5 | **Signed-URL leakage** | Reuse the R2 presign posture: ≤2-min GET, attachment-only, generic filename; never log/return storage keys or URLs; list projections carry no `signedUrl`/`bucket`. |
| R6 | **Raw PII in logs** | Sanitized logs/errors (no CCCD/portrait/bank values/name); audit uses a canonical hash, not raw values. |
| R7 | **Provider outage / cost exhaustion** | Provider-gated + off by default; bounded/rate-limited; outage = manual review; no unbounded retries; checksum idempotency. |
| R8 | **Forged webhook** | Any inbound webhook verifies HMAC signature + timestamp, is idempotent, and rejects replay. |
| R9 | **Portrait changed during review** | The request holds an **immutable** portrait snapshot; a new portrait does **not** invalidate the request or force re-review; the decision stays bound to the snapshot (UI may show a newer portrait for reference only). |
| R10 | **Financial totals drift** | Totals come from one server-side authoritative derivation; no client recompute; reconciliation pins cashflow (`disbursed_at`), reconciliation (`completed_at`) and refund (`refunded_at`) in `Asia/Bangkok`. |

---

## 8. Deliverables

### 8.1 Authoritative contract matrix

| Surface | Authority | Writes | Reads | Audit |
|---|---|---|---|---|
| Worker detail (portrait + CCCD + docs + PII) | server RPC, per-capability redaction | versioned portrait/doc rows | masked/completeness | immutable event |
| Accountant assignment | full-Admin / authorized assigner, reason+OCC | effective-dated assignment | self + admin | immutable event |
| Salary-advance request/decision | change-request **primitives/patterns** (data model = W2-S0-B) | request/item/revision | owner + **snapshot** accountant | immutable event |
| Disbursement (`DISBURSED_WAITING_PROOF`) | snapshot accountant, reason+OCC+idempotency | disbursement event (actor/time/amount/method) | accountant + admin | immutable event |
| Proof (Manager-submitted) | **Manager** submit/resubmit | versioned document (R2 posture) | accountant | immutable event |
| AI image signal | provider-gated advisory | advisory row only | accountant | provider/model/checked_at |
| Refund (`PROOF_REJECTED`→`REFUND_REQUIRED`→`REFUNDED`) | **snapshot accountant** (locked MVP) | append-only refund event | accountant + admin | immutable event |
| Basic summary | server-derived | none | accountant | none |

### 8.2 Data-classification table

| Data | Class | Handling |
|---|---|---|
| Portrait image | high-sensitivity PII (quasi-biometric) | short-TTL attachment presign; no logs; `pii_view`; MIME/magic/checksum; EXIF stripped |
| CCCD front/back images, contract/other documents | direct_pii / documents | `document_view`; redacted independently; completeness only when unauthorized |
| CCCD / name / DOB / phone / address | direct_pii | `pii_view`; masked in lists |
| Account number / bank / holder | financial | `payment_view`; masked (`••••`+last4); hash in audit |
| Proof image / receipt | financial evidence | R2 posture; no face claim |
| Amount / totals | financial | server-authoritative; reconciliation |
| Reason text | sensitive_free_text | bounded; no PII echo |
| `auth_subject`/`app_user_id`/UUIDs/storage keys | internal | never client-visible |

### 8.3 Acceptance E-list

E1 portrait versioning (original/current/legacy_added; old versions retained).
E2 portrait snapshot is immutable; a newer portrait does not invalidate an existing
request or force re-review.
E3 CASH requires `portrait READY` **checked at submit**.
E4 BANK_TRANSFER requires no portrait.
E5 the request snapshots the accountant/assignment at submit; reassignment does not
silently change an open case's handler.
E6 no self-review.
E7 initial reject and proof reject require a reason.
E8 disburse marks `DISBURSED_WAITING_PROOF` with actor/time/amount/method, no partial.
E9 the Manager submits/resubmits the mandatory proof; an accountant-uploaded
document does not replace it or advance the state.
E10 CASH manual image comparison.
E11 BANK_TRANSFER financial comparison (bank/STK/holder/amount/time).
E12 no bill=face claim and no automated face recognition.
E13 proof bound to request version + disbursement event + amount + method + proof
version; stale rejected.
E14 AI advisory only; never auto approve/reject.
E15 `REVIEW_REQUIRED` approve requires an override reason; `UNAVAILABLE` is not safe
(manual review + reason).
E16 AI idempotent by proof checksum; each proof version has its own result;
provider/model/`checked_at` stored.
E17 independent redaction + masking (PII/payment/document) and no signed URL,
storage key or raw PII in any projection or log.
E18 server/DB scope denies IDOR/cross-project; only the snapshot accountant (locked
MVP) opens `REFUND_REQUIRED`, and only from `PROOF_REJECTED` (never directly from
`PROOF_SUBMITTED` or from `COMPLETED`); summary timezone `Asia/Bangkok` reconciles.

### 8.4 Mutation M-list

M1 drop the per-row project/scope check → IDOR red; M2 re-resolve the current
accountant to replace the snapshot handler → reassignment red; M3 remove OCC →
replay red; M4 accept a stale/wrong-case proof version → proof-match red; M5 return
a signed URL/storage key in a list → leakage red; M6 log a raw CCCD/bank/portrait →
log-scan red; M7 let AI auto-approve → AI red; M8 treat `UNAVAILABLE` as accept →
AI-safety red; M9 allow self-review → no-self-review red; M10 check CASH portrait at
disbursement instead of submit (or skip it) → portrait-gate red; M11 let an
accountant-uploaded document advance to `PROOF_SUBMITTED` → proof-actor red; M12
open `REFUND_REQUIRED` from `COMPLETED` or by the Manager → refund-actor red; M13
allow `PROOF_SUBMITTED → REFUND_REQUIRED` directly (skipping `PROOF_REJECTED`) →
refund-source red.

### 8.5 Integration order

1. **T0** has absorbed this survey (master plan `REVIEWED_R1_REQUIRED`); R1 closes
   the S0 corrections. **W2-S0-B (T1B backend/API reuse) is still required** to lock
   the exact data model.
2. **T1B**: schema + RPCs (portrait/worker-detail, assignment, request/decision,
   disbursement, proof, refund) + focused tests. **One backend owner** to avoid
   migration/RPC drift.
3. **T1A**: UI (worker-detail surface, portrait capture/review, accountant queue,
   proof review, summary), gated by W2-S0-A.
4. **T1C**: allowed/denied + threat verification.
5. **T0**: migration apply, deploy (W2S2/W2S3/W2S4 hidden), Owner UAT.

Release split (per master plan): **W2-R1** = portrait + worker detail; **W2-R2** =
salary advance + refund + summary. Pre-W2 must be integrated and affected lanes
rebased before Wave 2 implementation opens.

### 8.6 UAT checklist (Owner)

Worker detail opens the right record (no IDOR) and shows portrait/CCCD/documents/PII
per capability; add portrait for a worker without one; CASH blocked without a ready
portrait **at submit**; BANK_TRANSFER without a portrait; request→approve/reject by
the snapshot accountant; reassign accountant mid-flow (old case keeps its handler);
mark disbursed; Manager submits proof; accountant optional document does not advance;
proof accept/reject + resubmit; refund only by the snapshot accountant and only from
`PROOF_REJECTED`; basic summary totals + timezone; masked vs full views; AI advisory
shown but never decisive; no PII/URL leakage in the network tab.

### 8.7 Stop conditions for go-live

Any of: an IDOR/cross-project leak; a signed-URL/storage-key leak; a raw PII/bank
value in logs or audit; AI able to auto-approve/reject or `UNAVAILABLE` treated as
accept; self-review possible; a CASH case without a ready portrait at submit; proof
not Manager-submitted (or an accountant document advancing the state); a refund
opened by the Manager, from `COMPLETED`, or directly from `PROOF_SUBMITTED` (skipping
`PROOF_REJECTED`); a live re-resolution replacing an open case's snapshot accountant;
unreconciled financial totals; a forged/unsigned webhook accepted.

---

## 9. Reuse matrix (no new frameworks)

| Concern | Reuse | Do NOT |
|---|---|---|
| Session/actor | `resolveActorForRequest`, `getDirectEntryActor`, `guardApiSession`, `decideSessionPageAccess` | new auth |
| Capability/scope | the `CAPABILITIES` set + grants/scopes + `direct_entry_has_capability` / `direct_entry_assert_*` | new RBAC engine; role/email/env grants |
| Request/decision | the change-request engine's **primitives/patterns** (no-self-review, OCC, idempotency, reason, immutable audit, propose/decide/withdraw, actor-scoped RPC); the salary-advance **data model is a W2-S0-B decision** | a second workflow engine; assuming the business tables are reused unchanged |
| Reason/audit/OCC/idempotency | `direct_entry_restricted_reasons`, `direct_entry_audit_events` (+`denial_code`, `scope_kind` incl. `project`), `direct_entry_revisions`, `direct_entry_rpc_idempotency`, `direct_entry_payload_hash` | new audit store; raw PII in logs |
| Payment authority | `payment_view` (masked) / `payment_edit`; `direct_entry_payments` `bank_id`/`account_number`/`account_holder_name` | bypass payment capability |
| Documents/portrait/proof | the R2 storage posture (`@aws-sdk/s3-request-presigner`; ≤2-min GET attachment-only generic filename; ≤5-min PUT bound); existing CCCD/contract document flow; document type `WORKER_PORTRAIT` | new storage abstraction; leaking keys/URLs; face recognition |
| AI | the existing AI gateway, provider-gated and off by default | auto-decision; unapproved provider PII egress; sending portrait/CCCD/bank |
| UI | React 19, Radix UI, Lucide, Card/Alert, existing grid, Recharts, `nuqs` | new component/form/state library |
| Tests | `node:test`, PGlite, existing fixtures/canonical scripts | new test framework |

## 10. Reconciliation points / blockers

- **Master plan** now exists out-of-repo → the S0 plan blocker is **resolved** (§0.1).
- **W2-S0-B** (T1B backend/API reuse) is **not yet assigned** → required before
  implementation to lock the exact schema/RPC/data model (§8.5).
- **Greenfield schema** for portrait/worker-detail/disbursement/proof/refund (§0.3)
  — new append-only migrations required; slot observed only (#86), not reserved.
- **Accounting bundle** is policy, not source (§0.4) — W2S2 must define the exact
  capability/authority set before implementation.
- **AI egress/privacy** (§6) — a T0-accepted provider/retention/training/privacy
  decision is required before enablement.
- **Open decisions (master plan §"Quyết định còn phải khóa"):** max advance amount;
  **Full Admin refund break-glass scope (unlocked — the locked MVP refund authority is
  the snapshot accountant only)**; AI provider/retention/SLA; WebP support;
  worker-detail shell; PDF preview vs signed-download fallback.

## 11. Explicit no-implementation statement

This lane is **survey-only**. It changes **one** file
(`docs/handoffs/w2-s0-c-contract-security-integration-survey.md`). No source,
schema, SQL, API, UI, package, dependency or lockfile change; no Production
query/apply; no deploy; no browser/UAT; no external-memory edit; no primary-checkout
change; no Pre-W2 branch touched; no T1B/T1A implementation started; **no migration
reserved**.

---

## 12. Revision log (R1, R2)

R1 is an append-only consistency repair of the S0 survey (`e434a88`) on the same
branch, aligning it to the Wave 2 master plan:

- **State machine mapped to the official set** (§2): `REQUESTED → REJECTED |
  APPROVED → DISBURSED_WAITING_PROOF → PROOF_SUBMITTED → COMPLETED |
  PROOF_REJECTED` (→ `PROOF_SUBMITTED` resubmit, or → `REFUND_REQUIRED` → `REFUNDED`).
  The extra states are removed from the current contract.
- **Accountant snapshot** (§2/§3/§7): the request snapshots the accountant/
  assignment at submit; the RPC must not silently re-resolve the current assignment
  to replace an open case's handler; explicit transfer/bulk reassignment deferred.
- **Proof actor** (§5): the Manager submits/resubmits the mandatory proof; an
  accountant-uploaded document is optional and never replaces or advances it.
- **Portrait snapshot** (§3/§7): immutable; a newer portrait does not invalidate an
  existing request or force re-review; CASH validates `READY` at **submit**;
  BANK_TRANSFER requires no portrait.
- **Refund actor** (§2/§5/§7): only the case's snapshot accountant opens
  `REFUND_REQUIRED`; no refund from `COMPLETED`; append-only; no partial; no separate
  `REFUND_APPROVED` step.
- **Reuse clarified** (§0.5/§9): reuse change-request **primitives/patterns**, not
  necessarily the business tables; the data model is a W2-S0-B decision.
- **Plan blocker resolved** (§0.1): the master plan exists out-of-repo.
- **W2S1 expanded** (§1/§3): full worker detail (portrait + CCCD images +
  documents + capability-based redaction), not only the portrait asset.

**R2 (this commit)** closes two targeted mismatches:

- **Refund source corrected (§2/§8):** `PROOF_SUBMITTED` transitions only to
  `COMPLETED | PROOF_REJECTED`; `REFUND_REQUIRED` is reachable **only from
  `PROOF_REJECTED`** (which branches to `PROOF_SUBMITTED` resubmission or, directly,
  to `REFUND_REQUIRED`), and `REFUND_REQUIRED → REFUNDED`. The diagram, transition
  actors, contract matrix, E-list (E18), M-list (new M13), UAT and stop conditions
  were updated in lockstep; a direct `PROOF_SUBMITTED → REFUND_REQUIRED` must be RED.
- **Full Admin break-glass removed as an accepted actor (§2/§8/§10/§12):** the locked
  MVP refund authority is the **snapshot accountant only**; a Full Admin refund
  break-glass remains an **unlocked** Owner/T0 decision, recorded only in the open
  decisions (no longer in the state machine, matrix, E-list, UAT or this log).