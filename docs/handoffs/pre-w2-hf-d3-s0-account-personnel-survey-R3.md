# Pre-W2-HF-D3-S0-R3 — server-managed provenance, stale-PENDING recovery, retention, replay semantics

> Status: `PRE_W2_HF_D3_S0_R3_AWAITING_T0_REVIEW`
> Base: `origin/main@c29b44c` (unchanged; docs-only correction on top of R2).
> Kind: docs-only correction. No source/package/SQL change, no DB access/mutation, no migration apply, no deploy, no UAT. Only this file and the pointer edit in R2 are written.
> Supersedes: R2 §1/§2/§3 (provenance marker, INDETERMINATE trigger, retention) and clarifies R2 §2.2 (BLOCKED) and R2 §2.4 (password-on-retry).

## 1. Provenance proof = server-managed `app_metadata` (corrects R2 §2.1)

R2 stored the provenance marker in `user_metadata`. **Withdrawn:** Supabase documents `user_metadata` as user-editable and advises against using it in a security context, so a user (or a compromised session) could alter or delete the marker, causing a wrong bind or a lost proof.

Corrected rule:

1. The provenance marker is written to **`app_metadata`** (e.g. `app_metadata.account_intent = <intent_token>`), which is writable/readable only via the server-side Admin API (service key). `intent_token` is an unpredictable, non-secret value derived from the intent UUID — never from the password.
2. The reconciler reads the Auth user via the Admin API and requires `app_metadata.account_intent === intent_token` before it may bind the app_user mapping. `user_metadata` is never consulted for authority.
3. Defence in depth: once resolved, the intent row records the resulting `auth_subject` server-side, so future lookups do not depend on Auth metadata alone.
4. Required tests (proves the property):
   - marker **modified** (value changed) → intent `BLOCKED`, no bind;
   - marker **removed** → intent `BLOCKED`, no bind;
   - marker present and matching → bind permitted.

## 2. Stale-PENDING detection and INDETERMINATE transition (corrects R2 §1/R2 §3)

R2 claimed a process crash leads to `INDETERMINATE`. **Withdrawn as an implicit claim:** a dead process writes nothing, so the row can stay `PENDING`. The transition must be made by a separate detector.

Corrected rule:

1. Durable phase markers on the intent: `auth_call_started_at` is written (Postgres) **immediately before** the Auth call, so a crash after the call leaves a detectable trace.
2. A server-side **sweeper** (scheduled job, also triggerable by a Full Admin action) transitions stale rows, and is idempotent and audited:
   - `PENDING` **without** `auth_call_started_at`, older than `T_pending` → `EXPIRED` (equivalent to `FAILED`: Auth was never called, so the password is definitely unchanged). Purgeable.
   - `PENDING`/`IN_FLIGHT` **with** `auth_call_started_at` older than `T_inflight` → `INDETERMINATE` + one immutable audit event (`outcome='INDETERMINATE'`, sanitized code = stale-in-flight).
3. The sweeper **never** re-calls Auth and **never** writes `APPLIED`; `APPLIED` still requires an observed Auth success. Transition-by-timeout is a truth statement ("outcome unknown"), not a success.
4. Nothing transitions `PENDING` by timeout into `APPLIED`/`FAILED` except the definitely-not-called `EXPIRED` case above.

## 3. Concrete retention for every state (corrects R2 §3)

R2 left `PENDING`/`INDETERMINATE` retention unbounded. Corrected rule (values are proposed defaults; T0 may set final numbers):

| State | Meaning | Transition to terminal | PII (`login_id`/`display_name`) purge |
|---|---|---|---|
| `PENDING` (no `auth_call_started_at`) | recorded, Auth not yet called | after `T_pending` (e.g. 15 min) → `EXPIRED` | at `EXPIRED` + `T_retain` |
| `IN_FLIGHT` (`auth_call_started_at` set) | Auth call issued, outcome pending | after `T_inflight` (e.g. 10 min) → `INDETERMINATE` (sweeper) | at `INDETERMINATE` cap |
| `APPLIED` / `FAILED` / `EXPIRED` | observed/known terminal | immediate | at `T_retain` (e.g. 24 h) |
| `INDETERMINATE` | outcome unknown | operator re-issue (fresh intent) | capped at `T_maxresolve` (e.g. 7 days) |
| `BLOCKED` / `CONFLICT` | provenance/ownership unproven | operator resolves or abandons | capped at `T_maxresolve` |

- `INDETERMINATE`/`BLOCKED`/`CONFLICT` are **not** retained indefinitely: at `T_maxresolve` they are escalated (alert) and then purged; the unresolved fact lives on in the immutable audit/alert, not in a PII row.
- **Cleanup never breaks audit or replay:** audit events are immutable and independently retained and reference only a non-PII token, so purging an intent row leaves no dangling audit. A **non-PII tombstone** (`idempotency_key` + terminal outcome, no `login_id`/`display_name`) is retained longer than the PII so a later replay of the same key is answered deterministically ("already terminal / expired") instead of silently re-running. A replay of a purged key is answered by the tombstone; if no tombstone exists, the response is "intent unknown → issue a new intent", never a blind re-create.

## 4. `BLOCKED` reconcile = evidence re-check only (clarifies R2 §2.2)

Reconcile for `BLOCKED`/`CONFLICT` means **only** re-reading the provenance evidence (`app_metadata.account_intent`). If the marker is now present and matches, the bind may proceed; if it is missing, mismatched, or otherwise unproven, the intent **stays `BLOCKED`**. There is never an automatic bind or auto-link of an unproven Auth user to a recruiter.

## 5. Password-on-retry semantics (clarifies R2 §2.4)

Because password matching is dropped (R2 §2.4), define the retry behaviour explicitly:

1. The **effective password** is always the one Auth actually accepted at its call. The system never compares or stores passwords.
2. Retry where Auth was certainly **not** called (`PENDING` with no `auth_call_started_at`): the intent may proceed and the submitted password is the one used at the Auth call.
3. Retry with a **different password** while Auth **may** have been called (`IN_FLIGHT`/`INDETERMINATE`): the system must **not** silently re-call Auth with the new password, because the first call's outcome is unknown. It responds with a non-success "outcome unknown / requires resolution" result, and the Full Admin resolves via a fresh reset intent once the account state is known.
4. Retry of an `APPLIED` intent: the account already exists and the submitted password is **ignored**; changing the password is a separate `reset-password` operation. The response is the stored deterministic terminal result, never a second create.
5. No response ever claims success while the outcome is unknown.

## 6. D5 scope note

The Owner decision on recruiter↔account cardinality (R1/R2 D5) blocks **only** the personnel-link RPC (`direct_entry_create_personnel_from_account`). The independent **create / edit / reset account** slices may proceed once R3 is accepted; the link slice stays blocked until Owner decides.

## 7. Acceptance additions (extends R2 §5)

| # | Case | Expected |
|---|---|---|
| A1c | `app_metadata.account_intent` tampered (modified) | intent `BLOCKED`; no bind |
| A1d | `app_metadata.account_intent` deleted | intent `BLOCKED`; no bind |
| A5d | Crash after Auth, before APPLIED; row left `PENDING` with `auth_call_started_at` | sweeper marks `INDETERMINATE` + audit; never Auth-again, never `APPLIED` |
| A5e | `PENDING` with no `auth_call_started_at`, older than `T_pending` | sweeper marks `EXPIRED`; purgeable |
| A9d | `INDETERMINATE` past `T_maxresolve` | escalated, then purged; audit retained; tombstone keeps replay deterministic |
| A9e | Replay of a purged key | answered by tombstone deterministically; never a blind re-create |
| A11b | Retry same intent with a different password while `IN_FLIGHT`/`INDETERMINATE` | non-success "outcome unknown / requires resolution"; no silent Auth re-call |

## 8. Boundary

Read-only correction. No source/package/SQL change, no DB access/mutation, no migration apply, no deploy, no UAT, no account creation/modification. No PII, credential, password, or raw database error was read or printed. Only the R2 pointer edit and this R3 file are written.
