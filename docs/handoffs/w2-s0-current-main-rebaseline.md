# W2-S0 — Current-main rebaseline after Pre-W2

> **Status:** `W2_S0_CURRENT_MAIN_REBASELINE_PASS_READY_FOR_W2S1_IMPLEMENTATION`
>
> **Type:** docs-only survey/reconciliation. No source, schema, API, UI, package,
> dependency or migration change.
>
> **Authority:** latest Owner direction → Wave 2 master plan → this current-main
> rebaseline → accepted S0-A-R3/S0-B-R1/S0-C-R2 history.

## 0. Freeze and evidence

- `origin/main` was fetched before and after the survey and frozen at
  `ec704f47a2f84a1d6d73a683489149a1266790fc` (`fix pending status cell label
  (#55)`). The final `6594b47..ec704f4` delta changes only the PENDING display
  label and its focused assertion; no W2 contract fact changed.
- The accepted S0 memos entered `main` through PR #10 at
  `50690d3334d076c0c9cb32c0eee966ab29215b45`.
- The reconciled external master plan is
  `C:\CodeApp\BI-wave-2-master-plan-2026-10-13.md`, SHA-256
  `EBC29E75DD4ED8ED6CB16256F0FC6B7131CB854BCA00A4B4E29F8A31EE0B7E19`
  (699 lines).
- Delta reviewed: `50690d3..ec704f4` = 303 paths, `+22523/-1798`.
- Migration ledger on the frozen main: **110** files; last =
  `20261016160000_pre_w2_personnel_from_account_default_access.sql`.
  **Next-available = #111** is an observation only; this survey reserves no slot.
- Work was performed in the isolated worktree
  `C:\Users\Admin\.codex\worktrees\w2-s0-rebaseline\BI`. The dirty primary
  checkout was not edited.
- The isolated worktree does not contain `.codegraph/`; targeted `rg`, `git diff`
  and direct source reads were used as the documented fallback.

The exact line numbers in the three original S0 memos are historical evidence.
Twenty-one paths they cite changed after PR #10, including the dashboard,
Direct Entry shell/grid/submission/change-review surfaces, navigation and
reporting server. Current implementation work MUST resolve symbols on the frozen
or newer main instead of copying old line numbers.

## 1. What Pre-W2 added

| Area | Current-main truth | Effect on Wave 2 |
| --- | --- | --- |
| Worker export | Recruited/managed/all scopes; full authorized export including PII/payment/note; raw date and CCCD issue date; audit/reason and row limits | Export is no longer a W2 deliverable. Reuse its server-resolved row authority only where a W2 read needs the same worker scope. |
| Worker correction | Worker name and employment-status changes use the existing proposal/review path; PM/team/global queues, history and apply flows now exist | W2S1 portrait replacement should extend the existing document/change-request boundary; salary keeps a sibling state model. |
| Account/personnel | Account create/edit/reset/reconcile, effective 1:1 account-personnel links, personnel creation from enabled accounts and default own-entry access are implemented | `direct_entry_app_users.app_user_id` is confirmed as the W2 accountant identity. Reuse account picker/pagination, not recruiter identity. |
| Project↔Team authority | Effective, audited project-team mappings, batch grant/revoke and Team Leader enforcement are implemented | Reuse the interval/OCC/idempotency/reason pattern for W2S2; do not repoint or store accountant assignment in this table. |
| Duplicate CCCD | Dashboard report is available to mapped enabled accounts and now reports canonical conflicts with at least two current `ON` episodes | Remains outside salary authority. It grants no W2 capability and needs no W2 implementation. |
| Reporting | Direct Entry is the canonical source; submitted/non-deleted rows, stored provider type and current recruiter display are used | W2S5 may reuse cards, tables and date presets, but salary summaries MUST query salary tables and case scope, not recruitment facts. |
| Direct Entry workflow | Active/history uploader queues, direct-submit batch flow, own-draft edit and richer change-request review/audit surfaces are implemented | More UI/state patterns can be reused; the salary lifecycle and evidence records remain new siblings. |

## 2. Capability and authority rebaseline

Migration `20261015150000_pre_w2_worker_data_capabilities_default.sql` grants
every mapped app account the existing worker-data capabilities `pii_view`,
`payment_view` and `pii_export`, and grants the same set when a new account is
finalized. It does **not** grant scopes, `document_view`, a salary capability or a
finance navigation entry.

This supersedes the old Pre-W2 factual assumption that a newly created account
receives no capability. It does not supersede the W2 isolation contract:

- scope is still independently resolved by server/DB;
- `pii_view`, `payment_view` and `pii_export` do not authorize salary actions;
- the navigation `finance` predicate is still fail-closed;
- no `salary_advance_*` capability exists on current main;
- Accountant assignment and every salary transition remain greenfield;
- Route/API and RPC/DB must both enforce actor + action capability + resource
  scope; hiding a menu is never authority.

W2 implementation uses the existing worker-data token names where applicable:
`pii_view`, `payment_view`, `document_view` and `pii_export`. The descriptive
label `view_payment` in the older plan is not a token and MUST NOT be introduced.
Salary uses the separate locked token names `salary_advance_submit`,
`salary_advance_review` and `salary_advance_summary_view` only after its schema
contract is opened. Accountant-assignment administration reuses the existing Full
Admin triple + effective `all` scope; it does not add another admin capability.
No broad worker-data bundle is granted merely because an account is an
Accountant.

## 3. Reconciled reuse boundary

### W2S1 — Worker portrait and full worker detail

**Reuse/extend:** the private document reserve/finalize/download transport,
strict document projection, CCCD front/back and employment-contract flows,
worker scope, existing Radix dialog patterns, change-request review/OCC and
server-side redaction.

**New but small:** `WORKER_PORTRAIT`; immutable
`origin = ENROLLMENT | LEGACY_ADDED`; server-selected current pointer; portrait
version/checksum projection; EXIF/metadata sanitizer; safe image preview; full
worker-detail composition.

Current main still supports only `CCCD_FRONT`, `CCCD_BACK` and
`EMPLOYMENT_CONTRACT`; no portrait symbol or EXIF stripping exists. Therefore the
uploader transport is mostly reused, but the portrait lifecycle is not “just one
more input field”.

Implementation default for W2S1 is deliberately narrow:

- JPEG/PNG only; WebP is deferred;
- existing private transport and short-lived delivery posture;
- PDF uses the existing authenticated/signed-download fallback; no new embedded
  PDF viewer;
- no crop, camera, gallery, face recognition or generic media framework.

### W2S2 — Accountant assignment

**Reuse patterns:** enabled-account picker and pagination; effective interval,
OCC, reason, idempotency, immutable audit and batch behavior from current admin
assignment flows.

**New sibling:** an accountant-assignment table/API/RPC keyed by `app_user_id`.
It MUST NOT reuse recruiter/personnel identity, `manager_recruiter_id` or
`direct_entry_project_team_scopes` as the accountant record.

### W2S3 — Request and initial decision

**Reuse patterns:** server-resolved project/worker scope, payment field layout,
active-bank catalog, masked projection, OCC, idempotency, mandatory reason,
no-self-review and the richer current queue/history UX.

**New sibling:** salary request/version/event records, strict salary projection,
canonical decimal-string amount over PostgreSQL `bigint`, method and immutable
accountant/bank/portrait snapshots. Do not add salary states to
`direct_entry_change_requests`; its current states remain
`PENDING|APPROVED|REJECTED|WITHDRAWN`.

### W2S4 — Disbursement and proof

**Reuse transport/UI:** private upload transport, Cards/Alerts/Dialog,
loading/error/conflict/retry and audit/idempotency primitives.

**New sibling:** proof and optional accountant supporting-document records,
request/disbursement/proof-version binding, CASH dual-image review, BANK_TRANSFER
financial comparison and advisory AI result. Evidence MUST NOT be written into
candidate `direct_entry_document_versions`.

### W2S5 — Refund and basic summary

Reuse date presets, KPI/table/empty/error primitives. Refund transitions and
server-derived salary summary are new. Recruitment facts/reporting RPCs are not
the salary data source.

## 4. Contract that remains unchanged

The Pre-W2 delta does not alter these accepted decisions:

1. Official states are
   `REQUESTED → REJECTED | APPROVED → DISBURSED_WAITING_PROOF →
   PROOF_SUBMITTED → COMPLETED | PROOF_REJECTED`, then
   `PROOF_REJECTED → PROOF_SUBMITTED | REFUND_REQUIRED → REFUNDED`.
2. There is no direct `PROOF_SUBMITTED → REFUND_REQUIRED` transition.
3. The request snapshots Accountant/assignment at submit; reassignment never
   silently changes an open case.
4. Manager submits/resubmits mandatory proof. Accountant evidence is optional
   and cannot advance the state.
5. CASH requires the server-confirmed READY current portrait at submit and
   snapshots document id/version/checksum. Review shows that immutable snapshot
   together with the cash-envelope proof.
6. BANK_TRANSFER requires bank, account number and holder name, not a portrait;
   the Accountant performs a manual comparison and the system makes no
   ownership/face claim.
7. AI image assessment is advisory only; it cannot approve/reject, and
   `UNAVAILABLE` is not safe.
8. Refund is opened only by the snapshot Accountant from `PROOF_REJECTED` in the
   MVP. No partial disbursement/refund and no refund from `COMPLETED`.
9. One employment entry has at most one open request, enforced by the DB rather
   than check-then-write.
10. W2 builds on actor + capability + scope; it does not create a generic role
    editor. Future W3 attendance gets an independent capability domain.

## 5. Smallest current implementation path

| Order | Slice | Minimal current-main touch boundary |
| --- | --- | --- |
| 1 | W2S1 | Extend document contract/storage projection and worker-detail read; add portrait sanitizer/version rules and one composed detail UI; focused authority/upload/version tests. |
| 2 | W2S2 | Add accountant assignment schema/RPC/server/API/admin UI using current account picker and assignment patterns; deploy hidden. |
| 3 | W2S3 | Add salary tables/events, strict API/RPC, Manager request and Accountant decision queues; deploy hidden. |
| 4 | W2S4 | Add disbursement/proof records, upload/review UI and provider-gated advisory AI integration; deploy hidden. |
| 5 | W2S5 | Add rejection/refund completion and server-derived today/week/month summary; complete UAT and enable W2-R2. |

Implementation branches MUST fetch the then-current `origin/main`, recount the
migration ledger and choose the next slot there. This survey does not reserve
`#111`.

## 6. Gates and remaining Owner decisions

S0 is ready to open **W2S1**. The following decisions do not block W2S1 but stop
later slices at their trust boundary:

- before W2S3 schema: maximum advance amount and whether it varies by project;
- before W2S2/W2S3 go-live: stranded-case recovery for an open case whose
  snapshot Accountant becomes unavailable;
- before W2S4 provider enablement: AI provider, egress, retention/training,
  cost/SLA and failure posture;
- before W2-R2: whether Full Admin receives any audited emergency mutation path
  or remains read-only, and exact list/summary scope after assignment changes.

Safe default until those decisions are recorded: fail closed. Do not invent a
fallback Accountant, global salary read or Full Admin mutation authority.

### Required acceptance deltas

- Every W2 API/RPC has positive and negative actor + capability + resource-scope
  tests; current default worker-data grants must not make a salary test green.
- A new account with default `pii_view/payment_view/pii_export` cannot see salary
  navigation, create/decide/read an unauthorized case or view salary summary.
- W2S1 separately tests PII, payment and document redaction and direct-route IDOR.
- Portrait origin/current/version are server-projected; changing the live portrait
  cannot alter an existing CASH snapshot.
- Accountant reassignment does not change an open case or leak it through list or
  summary projections.
- Proof resubmission cannot reuse an AI result for another proof/provider/config
  tuple.

### Mutation probes

The focused lanes must turn RED if any of these changes is introduced:

1. Treat `payment_view` or `pii_view` as salary authority.
2. Trust client-supplied actor, team, project or case authority.
3. Pick portrait `current` from array order/timestamp or derive `origin` from a
   version/state.
4. Re-resolve the current project Accountant over the case snapshot.
5. Reuse `direct_entry_change_requests` or candidate document history for salary
   states/evidence.
6. Compute salary summary from recruitment reporting facts or paginated client
   rows.
7. Allow direct `PROOF_SUBMITTED → REFUND_REQUIRED` or refund from `COMPLETED`.

## 7. Reproducible checks

```powershell
git fetch origin --prune
git diff --stat 50690d3334d076c0c9cb32c0eee966ab29215b45..origin/main
(Get-ChildItem supabase/migrations -File).Count
rg -n "pii_view|payment_view|pii_export" `
  supabase/migrations/20261015150000_pre_w2_worker_data_capabilities_default.sql
rg -l --glob '!docs/**' `
  "salary_advance|DISBURSED_WAITING_PROOF|WORKER_PORTRAIT|synthetic_risk" `
  src supabase/migrations
```

The final greenfield scan on the frozen main returned zero source/migration
definitions for salary advance states, `WORKER_PORTRAIT` and AI risk projection.

## 8. Scope statement

This rebaseline updates documentation only. It does not implement Wave 2, reserve
a migration, query/apply Production, deploy, or run browser/UAT. The historical
bodies of the three older S0 memos remain unchanged apart from their authority
notices; this memo is their current-main delta and operational entry point.
