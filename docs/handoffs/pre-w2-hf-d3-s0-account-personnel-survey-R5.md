# Pre-W2-HF-D3-S0-R5 — bounded retention, per-intent-type footprint, tombstone classification

> Status: `PRE_W2_HF_D3_S0_R5_AWAITING_T0_REVIEW`
> Base: `origin/main@0e5e27d` (unchanged; docs-only on top of R4). Branch already synced; no re-sync needed.
> Kind: docs-only. No source/package/SQL change, no DB access/mutation, no migration apply, no merge, no UAT, no VPS deploy. Only this file and the pointer edit in R4 are written.
> Supersedes: R4 §2 (purge table, retention-exception claim, and the "non-PII" label on the opaque `auth_subject` ref). Corrects Must-fix 1 and Should-fix 2/3.

## 1. Two intent types, two retention footprints (fixes Should-fix 3)

R4 kept `login_id` + `intent_token` for **all** unresolved intents without distinguishing intent kinds. Corrected: the two kinds have different discovery needs.

| Intent kind | Target identity known at creation? | Needs login search? | Needs provenance marker? | Minimum retained while unresolved |
|---|---|---|---|---|
| **create** account | No (login may not exist yet) | Yes — to find a possibly-orphaned Auth user | Yes (`app_metadata.account_intent`) | `login_id` + `intent_token` (only when `auth_call_started_at` set and outcome unresolved) |
| **reset** password | Yes (`account_ref` → `auth_subject` resolved before the Auth call) | No | No | `app_user_id` only (identity already known) |

Consequences:

- **Reset intents are always bounded.** Reset targets an existing, already-identified account, so there is no orphan-discovery problem and no need for `login_id` or a provenance marker. They purge on the normal `T_retain`/`T_maxresolve` schedule.
- The unresolved-retention problem in §2 applies **only** to **create** intents with `auth_call_started_at` set and an unresolved outcome.
- For a create intent, `display_name` is purged **immediately** at `INDETERMINATE`; only `login_id` is needed to locate the Auth user.

## 2. Bounded retention — Owner must choose (fixes Must-fix 1)

R4 claimed the "no indefinite PII retention" goal was still met for unresolved intents because they are alerted and access-restricted. **That claim is withdrawn: alerting and access limits reduce exposure but do not impose a maximum retention period.** Unresolved create intents are therefore a genuine retention exception that must be decided explicitly, not asserted.

Owner must pick one:

- **Option A (recommended) — explicit Owner-approved retention exception.** Retain the minimum create-intent handle (`login_id` + `intent_token`) until a **mandatory decision deadline `T_decide`**, at which the intent must be resolved (reconcile or abandon). The decision deadline *is* the bound; the record is not retained indefinitely by default. This exception must be **explicitly approved by Owner** (it is currently a proposal, not an accepted fact). `display_name` is never part of it.
- **Option B — hard bound, no auto-reconcile.** Purge the raw `login_id` at `T_handle_max`. The orphan then becomes a **known, non-reconcilable** exception: the login stays blocked by the unique `login_id` guard, the orphan Auth user is documented, and resolution is manual/out-of-band. Storage is strictly bounded, at the cost of automatic reconciliation.

Either way: **never auto-delete the Auth user**, and the chosen option is recorded as an explicit Owner decision (not silently claimed).

## 3. Tombstone classification (fixes Should-fix 2)

- A stable `auth_subject` / `app_user_id` UUID is a **pseudonymous identifier**, **not** "non-PII", even when random/opaque — it can be linked back to a person through the mapping tables. "Opaque" does not make it non-identifying.
- Replay of a terminal create intent needs only the account reference; it does **not** need `auth_subject`. Therefore **drop `auth_subject` from the tombstone**.
- Minimal tombstone = `{idempotency_key, outcome}`. A retained account reference (if needed to answer replay deterministically) is classified as a pseudonymous identifier with an explicit read access (service-role only) and its own retention deadline. No identifier is labelled "non-PII" merely because it is a UUID.

## 4. Corrected purge / retention table (replaces R4 §2 table)

| Intent kind | State | Purgeable? | Minimum retained | Notes |
|---|---|---|---|---|
| create | `EXPIRED` (Auth never called) | Yes, at `T_retain` | tombstone `{idempotency_key, outcome}` | no Auth user exists |
| create | `APPLIED` (auth_subject captured) | PII yes, at `T_retain` | tombstone `{idempotency_key, outcome}` (+ account ref if required for replay) | no `auth_subject` in tombstone |
| create | `FAILED` (observed) | Yes, at `T_retain` | tombstone | — |
| create | `INDETERMINATE` / `BLOCKED` / `CONFLICT` | **No, per Option A/B** | `login_id` + `intent_token` (Option A until `T_decide`; Option B purged at `T_handle_max`) | only case with a possible orphan |
| reset | any terminal (`APPLIED`/`FAILED`/`EXPIRED`) | Yes, at `T_retain` | tombstone | — |
| reset | `INDETERMINATE` | Yes, at `T_maxresolve` | `app_user_id` (already known) | no login/provenance retention needed |

Purge still never breaks audit or replay: audit events are immutable/independent and reference a non-PII token; the tombstone keeps replay deterministic (a purged key is answered by the tombstone, or "intent unknown → issue a new intent", never a blind re-create).

## 5. Acceptance additions (extends R4 §6)

| # | Case | Expected |
|---|---|---|
| A13a | Unresolved create intent at `T_decide` (Option A) | mandatory Owner decision surfaced; not silently retained beyond the deadline |
| A13b | Option B selected: create intent at `T_handle_max` | `login_id` purged; orphan documented; login stays blocked; manual resolution only; Auth user not deleted |
| A13c | Reset intent `INDETERMINATE` past `T_maxresolve` | purged (bounded); no `login_id`/provenance retained |
| A13d | Any tombstone | contains no `auth_subject`; only `{idempotency_key, outcome}` (+ optional classified account ref) |

## 6. Boundary

Read-only correction. No source/package/SQL change, no DB access/mutation, no migration apply, no merge, no VPS deploy, no UAT, no account creation/modification. No PII, credential, password, or raw database error was read or printed. Only the R4 pointer edit and this R5 file are written.
