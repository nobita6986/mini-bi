# Pre-W2-HF-D3-S0-R1 — Account ↔ recruiter-personnel survey: rebaseline + saga/audit correction

> Status: `PRE_W2_HF_D3_S0_R1_REBASELINED_AWAITING_T0_REVIEW`
> Base: `origin/main@c29b44c` (87 migrations; survey branch rebased onto main).
> Kind: docs-only correction/addendum. No source/package/SQL change, no DB access/mutation, no migration apply, no deploy, no UAT. Only this addendum and the pointer edit in the S0 survey are written.
> Supersedes: S0 §5/§7/§9 for account-creation atomicity, "zero residue", byte-identical replay and password-reset audit.
> Superseded-by: R2 — `pre-w2-hf-d3-s0-account-personnel-survey-R2.md` (reset-password indeterminate state, account-create provenance + password idempotency, PII classification, D5 escalation).

## 1. Rebaseline (mandatory point 1)

- S0 was based on `9c2fdb5` (85 migrations). `origin/main` is now `c29b44c` (**87 migrations**, 41 commits ahead). The survey branch has been rebased onto `c29b44c`; no migration slot is chosen or reserved.
- New migrations reviewed:
  - `#86` `20261013120000_pre_w2_p1_worker_export.sql` — full-PII worker Excel export RPC (`direct_entry_export_workers`). Touches `direct_entry_audit_events`, `direct_entry_reason`, worker-directory audience; **no** account/personnel create/edit/password.
  - `#87` `20261013130000_pre_w2_hf_c_global_duplicate_cccd_read_access.sql` — widens the duplicate-CCCD reader guard to any enabled mapped actor via `direct_entry_assert_actor_mapping`. **No** account/personnel create/edit/password.
- Conclusion: the S0 data-relationship map, call graph, reuse matrix and "create/edit/password are absent" findings are **unchanged** after rebaseline. Only the base SHA and ledger count change.

## 2. Account creation is NOT atomic — saga/reconcile required (mandatory point 2)

S0 wrongly stated "one transaction … zero residue on failure … replay returns stored result" for account creation. That is **incorrect** and is withdrawn.

Reality:

- `admin.auth.admin.createUser(...)` mutates **Supabase Auth**, which is outside the Postgres transaction.
- `direct_entry_create_app_user(...)` inserts into `public.direct_entry_app_users` in a **separate** Postgres transaction.
- There is no distributed transaction across Auth + Postgres. If Auth succeeds and the RPC fails (or the process dies between the two), an **orphaned Auth user** remains.

Corrected semantics (saga):

1. A single client `idempotency_key` spans the whole saga and is stored durably in Postgres **before** the Auth call (the saga intent row). The login identifier is a stable, unique business key (`login_id` → `<login_id>@hrpartner.vn`), so the Auth step is "create if absent by that login", not a blind create.
2. Order: (a) validate + write `app_user_create_intent` (actor, target login_id/display_name, reason_id, idempotency_key, state=`PENDING`); (b) `admin.auth.admin.createUser` (or "get by login if already present"); (c) `direct_entry_create_app_user(auth_subject, display_name, reason, idempotency_key)`.
3. If (c) fails after (b) succeeded, the intent stays `PENDING` and a **reconcile** step (idempotent, safe) may complete the mapping for the already-created Auth user under the same `idempotency_key`. Reconcile must:
   - never **delete** the orphaned Auth user automatically (no destructive cleanup without an approved policy);
   - never **auto-link** the Auth user to an existing recruiter by email/display-name match;
   - complete only when the Auth user's login identifier exactly matches the intent's `login_id`, and the target `auth_subject` is not yet mapped to another app_user.
4. Replay semantics are therefore **not** byte-identical across the Auth boundary. The DB RPC side keeps byte-identical same-key replay (existing `direct_entry_rpc_idempotency`); the Auth side is "create-if-absent by stable login id". The saga returns a stable, deterministic result for the same `idempotency_key`.
5. "Zero residue on failure" is replaced by "**recoverable** intermediate state, no orphan that cannot be reconciled, no silent data loss, no incorrect auto-link".

New DDL implication (corrects S0 §7 "no new tables"): a durable intent/outbox table (e.g. `direct_entry_app_user_create_intents`, or reuse a generic saga state) is required for the create (and reset) flow. Its columns carry only non-PII `login_id`, `display_name`, actor/target UUIDs, `reason_id`, `idempotency_key`, state, timestamps — **never** the password.

## 3. Password reset audit + partial failure (mandatory point 3)

S0 implied reset-password has reason/idempotency/audit like an ordinary RPC. That is **not** achievable atomically because `admin.updateUserById({ password })` mutates Supabase Auth outside Postgres.

Corrected semantics:

1. Resolve `account_ref → auth_subject` via a service-role-only RPC (projections hide `auth_subject`). No email/`auth_subject` leaves the server.
2. Durable intent first: write a `password_reset_intent` row (actor, target app_user/auth_subject, reason_id, idempotency_key, state=`PENDING`). **Never** store the password or any password hash in the intent/audit/log.
3. Call `admin.updateUserById({ password })`.
4. On Auth success: set state=`APPLIED` + write an immutable `password_reset` audit event (`resource_ref` = a non-PII bounded token, `outcome='APPLIED'`, `reason_id`). If that Postgres write fails, the `PENDING` intent is recoverable: retry with the same key re-attempts only the audit write (mark APPLIED), it does **not** reset the password again.
5. On Auth failure: set state=`FAILED` + audit `outcome='FAILED'` with a sanitized denial code; no password changed; no password ever written.
6. Partial-failure policy: the password change is the single source of truth in Auth; Postgres only records intent + outcome. Reconcile never re-derives or re-applies a password.

## 4. Locked T0 / Owner decisions for R1

| ID | Decision to lock | Recommended answer |
|---|---|---|
| D1 | Create/edit/reset account authority | **Full Admin only** (same `direct_entry_assert_actor_app_user_admin`; Accounting denied) |
| D2 | Login/email rule | Login = `login_id@hrpartner.vn`; **no email change** in this slice |
| D3 | Password policy | **Per-account password**, no shared default; reject a single `DEFAULT_PASSWORD` for all accounts |
| D4 | Create-personnel-from-account permission + atomicity | **Full Admin only**; Postgres-atomic (recruiter + HRP membership + verified link in one transaction), with account existence as a precondition |
| D5 | One recruiter ↔ multiple accounts | **Open decision.** E5 guard is per app_user, so one recruiter can currently link to multiple accounts. Recommend adding a per-recruiter verified-link guard later, or accept as-is for this slice |
| D6 | Data preservation | Confirm: no delete, no merge-by-email, no UUID change, no auto account↔personnel attach without a proven explicit relationship |
| D7 | Out-of-scope guardrails | Confirm: no invite link, no public sign-up, no MFA, no forgot-password/recovery, no account recreation, no department/RBAC model |

## 5. Corrected minimal contracts (replaces S0 §5)

- **Edit `display_name`** (S0 §5.2): **unchanged and correct** — a single Postgres RPC with OCC/reason/idempotency/revision/audit. No saga needed.
- **Create personnel from account** (S0 §5.4): **unchanged and correct** at the Postgres layer (single transaction). No Auth step is involved; account existence is a precondition. The create-account saga above is its prerequisite.
- **Create account** (replaces S0 §5.1): saga as in §2 above (intent → Auth create-if-absent → app_user RPC → reconcile).
- **Reset password** (replaces S0 §5.3): intent-first + Auth mutate + durable audit + reconcile as in §3 above.

## 6. Corrected migration impact (replaces S0 §7 "no new tables")

Required (future append-only migrations, one reviewed work item at a time; **no slot reserved**):

1. `direct_entry_create_app_user` RPC (+ ACL + self-check) — insert into `direct_entry_app_users`.
2. `direct_entry_update_app_user_display_name` RPC — field-scoped update; requires widening the W03A `direct_entry_app_user_revisions.action` CHECK (or a T0-approved reuse).
3. `direct_entry_get_app_user_auth_subject` RPC — service-role-only resolver for reset password.
4. `direct_entry_create_personnel_from_account` RPC — atomic recruiter + HRP membership + verified link.
5. **New durable saga/intent table(s)** for account-create and password-reset intents (non-PII only; never password). This corrects S0's "no new tables" statement.

No new columns on `direct_entry_app_users`/`recruiters`/links are required.

## 7. Corrected acceptance / mutation matrix (replaces S0 §9 for A1/A3/A5/A6/A9)

| # | Case | Expected |
|---|---|---|
| A1 | Full Admin creates account | Auth user created (create-if-absent by login_id) + app_user mapped; intent ends `APPLIED`; deterministic result for the same `idempotency_key` |
| A3 | Existing login reused | No second Auth user; existing `auth_subject` either maps (if already mapped) or is refused; no orphan |
| A5 | Same key + same payload replay | deterministic (not necessarily byte-identical across Auth); no second Auth user/app_user |
| A6 | Same key + different payload | 22023 before any Auth/DB mutation |
| A5b | Auth created but app_user RPC failed | intent `PENDING`; reconcile completes the mapping; orphan never auto-deleted, never auto-linked |
| A9 | Admin reset password | password changed in Auth; `password_reset` audit `APPLIED`; no password/hash in audit/log/intent |
| A9b | Reset succeeds but audit write fails | intent `PENDING`; retry writes only the audit, does not reset again |
| A9c | Reset Auth fails | audit `FAILED`; password unchanged; no password stored |

All other S0 rows (A2, A4, A7, A8, A10–A14) remain unchanged.

## 8. Boundary

Read-only correction: no source/package/SQL edit, no DB access/mutation, no migration apply, no deploy VPS/Vercel, no browser/UAT, no account creation/modification. No PII, email, user UUID, credential, password or raw database error was read or printed. Only the S0 survey header/ledger pointer and this R1 file are written.
