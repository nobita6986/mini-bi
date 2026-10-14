# Pre-W2-HF-D3-S0-R4 — atomic Auth claim, orphan-safe purge, marker wording, baseline sync

> Status: `PRE_W2_HF_D3_S0_R4_SYNCED_AWAITING_T0_REVIEW`
> Base: `origin/main@0e5e27d` (88 migrations; branch synced preserving history). New #88 = D2 active-duplicate-CCCD semantics — unrelated to account/personnel.
> Kind: docs-only. No source/package/SQL change, no DB access/mutation, no migration apply, no merge, no VPS deploy, no UAT. Only this file and the pointer edits (S0/R3) are written.
> Supersedes: R3 §2/§3 (concurrency claim, purge safety) and clarifies R3 §1 (marker secrecy wording) and R3 §3 (TTL values).
> Note: Owner performs UAT; this memo performs none.

## 1. Atomic claim before any Auth call (corrects R3 §2)

Problem: two requests reading the same `PENDING` intent (no `auth_call_started_at`) could each write the marker and each call `createUser`/`updateUserById`, producing inconsistent result/audit.

Corrected rule — a single **conditional claim** decides who may call Auth:

1. The claim is one conditional, single-row, transactional update with a state guard, e.g.:
   `UPDATE ... SET state='IN_FLIGHT', auth_call_started_at=now(), claimed_by=<request_token> WHERE idempotency_key=... AND state='PENDING' AND auth_call_started_at IS NULL`.
2. Exactly one request observes `rowcount = 1` (the **claim winner**); **only** the winner may call `createUser`/`updateUserById`.
3. Every loser observes `rowcount = 0` and must **re-read** the intent, then:
   - `IN_FLIGHT`/`APPLIED`/`FAILED`/`INDETERMINATE` → **no Auth call**; return the current state / resolution path.
   - `BLOCKED`/`CONFLICT`/`EXPIRED` → return that outcome; **no Auth call**.
4. The claim also serializes with the unique canonical `login_id` guard, so at most one live create-per-login exists.
5. Required tests: two concurrent identical create (and reset) requests → exactly **one** Auth call; the loser returns its outcome with **no** Auth call and no duplicate/contradictory audit row.

## 2. Orphan-safe purge: keep the provenance handle (corrects R3 §3)

Problem: if Auth created the user but the process died before saving `auth_subject`, the intent becomes `INDETERMINATE`; R3 purges PII at `T_maxresolve` but keeps only `{idempotency_key, outcome}`, which cannot locate the Auth user. That can strand an orphan while re-creation is blocked by the existing login.

Corrected rule — purge is **state-aware** and must never drop the only handle needed to reconcile:

| State | Auth user exists? | Purgeable? | Minimum evidence to retain |
|---|---|---|---|
| `EXPIRED` (Auth never called) | No | Yes, at `T_retain` | non-PII tombstone `{idempotency_key, outcome}` only |
| `APPLIED` (auth_subject recorded) | Yes, known | PII yes, at `T_retain` | non-PII tombstone `{idempotency_key, outcome, opaque auth_subject ref}` |
| `FAILED` (observed) | No / unchanged | Yes, at `T_retain` | non-PII tombstone |
| `INDETERMINATE` | **Unknown** | **No, not until resolved** | **canonical `login_id` (search key) + `intent_token`** |
| `BLOCKED` / `CONFLICT` | Unproven | **No, not until resolved** | canonical `login_id` + `intent_token` |

Rules:

1. `INDETERMINATE`/`BLOCKED`/`CONFLICT` **cannot** be purged while unresolved: the canonical `login_id` is the only evidence that lets a server-side reconciler find the Auth user and finish or explicitly reject the saga. Dropping it would strand an orphan permanently.
2. At `T_maxresolve`, unresolved rows are **escalated** (alert to Owner/operator) and retained under a restricted, quarantined access; they are **not** silently purged. The "no indefinite PII retention" goal is met by making these rows rare, alert-driven and access-restricted — but the handle is kept until resolution, or until an **explicit Owner decision** (recorded in audit) authorizes a purge/abandon.
3. When Owner/operator **cannot verify** the outcome: the orphan Auth user is **retained, never auto-deleted**; re-creation for that login stays blocked by the unique `login_id` guard, and the attempt surfaces the `INDETERMINATE`/`BLOCKED` intent so the operator can reconcile (bind only if provenance proves, else leave blocked). No auto-delete, no auto-bind.
4. Purge never breaks audit or replay: audit events are immutable and independently retained and reference a non-PII token; the non-PII tombstone keeps replay deterministic (a purged key is answered by the tombstone, or "intent unknown → issue a new intent", never a blind re-create).

Required test: crash-after-Auth then past `T_maxresolve` → escalation raised, provenance handle retained (Auth user still findable), orphan not deleted, re-create blocked and surfaced.

## 3. Marker wording: not secret, trusted only from the Admin API (clarifies R3 §1)

R3 §1.1 implied the marker is kept confidential. Corrected wording:

- `app_metadata` is **not user-editable**, but it **may appear in the user's own JWT**. The marker is therefore **not a secret** and must not be treated as one.
- It is valid as **provenance evidence only because the server trusts the value read back through the server-side Auth Admin API** (`getUserById`), never a value taken from the client or the user's JWT.
- Set at creation via the Admin API (`createUser({ app_metadata })`); read back via the Admin API. `user_metadata` is never consulted for authority (it remains user-editable).

## 4. TTL values must be T0-locked (clarifies R3 §3)

The R3 values (`T_pending`, `T_inflight`, `T_retain`, `T_maxresolve`) and the sweeper cadence are **illustrative defaults, not locked**. T0 must lock them before any time-based acceptance test with concrete durations is written.

## 5. Baseline sync (this revision)

- Branch synced from `c29b44c` to `0e5e27d` preserving history (the four doc commits were rebased; no source change). New #88 (D2) reviewed — unrelated to account/personnel. Ledger now 88.

## 6. Acceptance additions (extends R3 §7)

| # | Case | Expected |
|---|---|---|
| A12a | Two concurrent identical create/reset requests on the same PENDING intent | exactly one Auth call (claim winner); loser re-reads and does not call Auth; no contradictory audit |
| A12b | Crash after Auth, past `T_maxresolve` | escalation raised; provenance handle retained; orphan not deleted; re-create blocked and surfaced |
| A12c | Marker present in user's JWT but absent from Admin-API read | not trusted; intent `BLOCKED` |
| A12d | Unresolved `INDETERMINATE` at `T_maxresolve` | not silently purged; quarantined + escalated; purge only on explicit audited Owner decision |

## 7. Boundary

Read-only correction. No source/package/SQL change, no DB access/mutation, no migration apply, no merge, no VPS deploy, no UAT, no account creation/modification. No PII, credential, password, or raw database error was read or printed. Only the S0/R3 pointer edits and this R4 file are written.
