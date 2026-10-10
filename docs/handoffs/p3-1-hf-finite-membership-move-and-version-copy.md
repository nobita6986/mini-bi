# P3.1 hotfix — Finite membership move and technical version copy

Base: `a100d124e65d6867c9d60315d0659a5c4cdc8d9e`.

## Incident and evidence

Production request logs confirmed move requests reached the server and returned
HTTP 400. A read-only, narrowly scoped check found a current membership with a
finite future end and a cancelled future membership represented by a zero-length
marker. No open-ended membership remained. No personal identifiers or credentials
are reproduced here.

The move RPC selected only `valid_to IS NULL`, so it rejected the still-effective
finite interval. Independently, the UI labelled all HTTP 409 outcomes as version
conflicts, even though the backend also uses 409 for overlapping intervals.
The available logs do not establish which condition caused the user's first 409.

## Implementation

- Append migration #77, `20261011100000_p3_1_hf_finite_membership_move.sql`.
  Select a finite interval only when it contains the requested move date and has
  not ended on the authorization date. Preserve the outgoing end on the incoming
  membership and its audit snapshot. Keep the original open-ended selection,
  authorization, locking, OCC, replay, attribution protection and atomic audit.
- Historical intervals and zero-length cancellation markers cannot be reopened.
  A move on or after a finite end cannot extend that interval. A cancelled future
  move does not automatically restore an indefinite assignment.
- Map known SQLSTATE/message pairs to bounded public error codes for overlap,
  same team, no movable membership, date before start, and attribution conflict.
  Unknown errors retain the generic safe response. Raw DB messages never reach UI.
- Explain finite end dates in the move form. Keep reload locks until detail and
  all three membership lists have loaded. No automatic retry of a stale write.
- Remove OCC counters from Personnel, Teams, Leaders, Workers, Projects,
  submissions, change requests, payment conflict panels and AI configuration.
  Keep all version fields in validated payloads and mutation requests. Replace
  technical conflict copy with actionable Vietnamese. Document upload history
  keeps its distinct upload label; it is separate from an OCC counter.
- Rebaseline existing ledger assertions and historical offsets from 76 to 77.
  Migrations #1–#76 are unchanged; no new RPC or dependency is introduced.

## Verification

The existing membership DB lane now covers schedule → cancel → stale rejection
→ reload-equivalent fresh version → finite move, including preserved end date,
audit snapshot, exactly one revision/audit, exact replay and zero-residue rejection
at the end boundary. A second case refuses historical edits. A mutation check
temporarily restores the old function inside a local rolled-back transaction and
confirms the formerly valid move fails. The real function is restored by rollback.

API regression checks repository classification → sanitized HTTP response → UI
message for all known error categories. UI regression keeps OCC, scoped retry and
authoritative reload behavior. The canonical full suite, build, lint, typecheck,
docs, secrets and offline migration checks are release gates.

Local evidence: membership DB/API 38/38; membership UI 23/23; typegen,
typecheck, webpack production build and lint passed (15 existing warnings).
Docs 6/6, secrets scan and offline validation of 77 migrations passed.
The canonical 68-lane chain was resumed after updating one changed-copy assertion
and ledger offsets. Lanes 1–67 passed; the final Vendor lane's only remaining
failure was its clean-migration-worktree check seeing the new untracked #77.
After implementation commit `8e59744`, the Vendor lane rerun passed 25/25 with
a clean migration worktree. All 68 canonical lanes therefore passed across the
initial and resumed runs (not one uninterrupted `pnpm test` invocation).
Production dry-run confirmed #1–#76 applied with matching checksums and only #77
pending. Production apply and deployment are verified separately at release.

## Owner UAT

1. Refresh the application. Personnel and Team tables and the worker correction
   dialog show no technical version counter.
2. Open a person whose future move was cancelled. Choose Move on the current
   finite membership, pick another active team and a date before its end.
   Confirm the form explains the retained end and the move succeeds.
3. Reload: the outgoing interval ends on the move date; the incoming interval ends
   on the original end date; the cancellation marker remains history.
4. Verify a stale write requests reload and a scheduling/input error explains the
   reason without describing every error as a version conflict.

No personnel assignment is automatically changed by the migration. Browser UAT
requires the owner's authenticated session and remains separate from local tests.
