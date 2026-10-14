# Pre-W2-HF-D3-S0-R2 — saga recovery semantics + PII classification + D5 escalation

> Status: `PRE_W2_HF_D3_S0_R2_AWAITING_T0_REVIEW`
> Base: `origin/main@c29b44c` (unchanged; docs-only correction on top of R1).
> Kind: docs-only correction. No source/package/SQL change, no DB access/mutation, no migration apply, no deploy, no UAT. Only this file and the pointer edits in S0/R1 are written.
> Supersedes: R1 §2/§3/§6/§7 (account-create saga, reset-password recovery, PII classification, acceptance matrix) and re-escalates R1 D5.

## 1. Reset password: indeterminate outcome (corrects R1 §3)

R1's "retry only writes the audit" is **withdrawn — it is unsound**. If `admin.updateUserById` succeeds but the process dies before the APPLIED audit write, the intent remains `PENDING`, indistinguishable from "Auth has not changed the password yet". Without a stored password and without a durable Auth confirmation, the system cannot know whether to only-write-audit or call Auth again.

Corrected state machine (no password or hash is ever stored):

- `PENDING` — intent recorded; Auth call not yet issued (or in flight before any durable marker).
- `APPLIED` — written **only** when a durable, observed Auth success is received.
- `FAILED` — written only when Auth returns a durable, observed failure.
- `INDETERMINATE` — written when the Auth call times out / connection drops / process dies and the outcome is unknown.

Rules:

1. Never auto-mark `APPLIED`. `APPLIED` requires an observed Auth success.
2. `INDETERMINATE` is a real, audited state (`outcome='INDETERMINATE'`, sanitized code). It must never masquerade as `APPLIED`/`FAILED`.
3. Recovery for `INDETERMINATE` is **operator-driven (Full Admin)**: re-issue the reset as a **fresh intent** with a new `idempotency_key` and a new reason. Re-setting a password is a set operation, so re-issue is safe and non-destructive and produces a fresh, truthful audit trail. There is no automatic "only-write-audit" retry.
4. The audit records only what was actually observed. It must never claim a password change that cannot be proven.

Invariant: truthfulness of the audit is the boundary. When truth is unknowable, the state is `INDETERMINATE`, not `APPLIED`.

## 2. Account-create saga: provenance + password idempotency (corrects R1 §2)

R1's "create-if-absent or fetch by login" can bind a pre-existing Auth user that does not belong to this intent; matching `login_id` alone is not proof of ownership. R1 also promised "same key + different payload → reject", but the intent stores no password and no password fingerprint, so after a stop that comparison is impossible.

Corrected rules:

1. **Provenance marker.** At creation, `admin.auth.admin.createUser({ ..., user_metadata: { account_intent: <intent_token> } })` stamps a unique, non-secret `intent_token` (derived from the intent UUID, not the password) into the Auth user. The reconciler claims ownership only if the fetched Auth user's `user_metadata.account_intent` equals the intent's token.
2. **Unproven Auth user → `BLOCKED`, never bound.** If a pre-existing Auth user matches `login_id` but does not carry the intent marker, the reconciler must **not** create an app_user mapping. It marks the intent `BLOCKED`/`CONFLICT` for operator resolution. No silent bind, no delete.
3. **Concurrency.** The intent table carries a **unique canonical `login_id`** (lowercased/btrimmed). Two concurrent intents for the same login cannot both exist; the second gets a unique-violation 409 **before** any Auth call, serializing creation per login.
4. **Password idempotency is removed.** The password is never stored or fingerprinted. Idempotency is keyed on stable identity (`login_id` + `idempotency_key`/intent token), never on the password. A completed `APPLIED` intent returns the stored deterministic result; `PENDING`/`INDETERMINATE`/`BLOCKED` intents reconcile via the provenance marker. "Same key + different payload → 22023" applies **only** to the Postgres `direct_entry_create_app_user` step (which receives no password), never to the Auth step.
5. **No orphan deletion, no auto-link.** Preserved from R1. Orphaned/unproven Auth users are surfaced for operator action only.

## 3. PII classification (corrects R1 §2/§6 "non-PII")

R1 incorrectly labelled `login_id` and `display_name` as "non-PII". They are personal/identifying data:

- `display_name` = a person's name → **PII**.
- `login_id` = an employee/account identifier that can identify a person → **identifier / personal data**.

Intent-table rules (never password/hash):

- **Storage:** only `login_id` and `display_name` as strictly required; store `login_id` only and derive the email server-side at call time (do not store a separate email copy).
- **Read access:** service-role / Full Admin only; never projected to the browser; never placed in audit `resource_ref` (which stays a non-PII token/hash of the intent id).
- **Retention:** bounded TTL. Terminal intents (`APPLIED`, `FAILED`, `CONFLICT`, `BLOCKED`) are purged after a short retention window; `INDETERMINATE` intents are retained until operator resolution, then purged. A cleanup job (or explicit admin action) must exist — no indefinite retention of name/identifier.
- **Audit:** `resource_ref` and `changed_fields` must not contain `login_id` or `display_name`.

## 4. D5 escalation (blocking, Owner decision before link RPC)

R1 left D5 open. This is a **business relationship rule** and blocks `direct_entry_create_personnel_from_account` (the link-creation RPC), so Owner must decide before implementation.

- Question: may one `recruiter` (personnel) be linked to more than one Access Account?
- Current schema: the overlap guard is per `app_user` (S0 E5), so today one recruiter **can** be linked to multiple accounts.
- Recommendation: lock **one verified effective account per recruiter** (1:1), by adding a per-`recruiter_id` verified-link overlap guard symmetric to the existing per-`app_user_id` guard. This avoids split identity and ambiguity in reporting/actor resolution.
- If Owner instead allows many accounts per recruiter, the link RPC and the actor-resolution ambiguity rules must be specified accordingly (no silent change).

## 5. Corrected acceptance matrix (replaces R1 §7 for the affected rows)

| # | Case | Expected |
|---|---|---|
| A1 | Create account, Auth success observed + app_user mapped | intent `APPLIED`; deterministic result for the same intent |
| A1b | Auth user pre-exists for the login but carries no intent marker | intent `BLOCKED`/`CONFLICT`; no mapping; operator resolves |
| A5b | Concurrent second intent for the same login | 409 unique `login_id` before any Auth call |
| A5c | Create-account retry after crash | reconcile via `account_intent` marker only; unproven user is never bound |
| A9 | Reset password, Auth success observed | audit `APPLIED`; no password/hash stored |
| A9b | Reset password, Auth outcome unknown (timeout/crash) | intent `INDETERMINATE`; never auto-`APPLIED`; operator re-issues |
| A9c | Reset password, Auth failure observed | audit `FAILED`; password unchanged |

All other rows from S0 §9 / R1 §7 remain unchanged.

## 6. Boundary

Read-only correction. No source/package/SQL change, no DB access/mutation, no migration apply, no deploy, no UAT, no account creation/modification. No PII, credential, password, or raw database error was read or printed. Only the S0/R1 pointer edits and this R2 file are written.
