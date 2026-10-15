# Pre-W2-HF Project ↔ Team authority — T0 D6 amendment

> Status: `PRE_W2_HF_PROJECT_TEAM_AUTHORITY_D6_AMENDMENT_LOCKED_FOR_T1B`
> Applies to: `pre-w2-hf-project-team-authority-contract-final.md` §D6 and migration #94.
> Scope: interval/revocation semantics only; every other contract decision remains unchanged.

## Locked rule

Mapping intervals remain half-open: `[valid_from, valid_to)`. Ordinary closed intervals
must be non-empty (`valid_to > valid_from`), and only one mapping may be effective for a
Project/Team pair on any date.

The only permitted zero-length interval is an audited same-day cancellation: when a
mapping is granted on the canonical authorization date and revoked that same date, the
Full Admin revoke RPC may set `valid_to = valid_from` so access is removed immediately.
The grant RPC always writes `valid_to = NULL`; direct writes and every other path remain
blocked by the transaction-local marker guard.

Revocation is immediate, never scheduled. An explicit `effective_to` later than the
canonical authorization date is rejected with `22023`. An omitted end date closes at
the later of the authorization date and `valid_from` (so a not-yet-effective grant can
be cancelled without creating effective access). An end date before `valid_from` is
rejected. A current-date end date on an older mapping removes access on that date.

The database interval check therefore permits `valid_to >= valid_from`; the equality
case is narrowed to the audited revoke RPC by its guard marker and is not a general
allowance for empty intervals. No mapping row or Project Manager assignment history is
deleted or rewritten.

## Regression requirement

- Same-day grant then revoke closes at `valid_from` and removes Team Leader access that
  day.
- A future `effective_to` is rejected and leaves the mapping, audit, and idempotency
  state unchanged.
- A current-date revoke of an older mapping removes Team Leader access immediately.

This amendment does not authorize applying the migration, deploying, or performing UAT.
