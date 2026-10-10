# P3.1-HF — Membership form event lifetime

## Status

`P3_1_HF_MEMBERSHIP_FORM_EVENT_LIFETIME_LOCAL_PASS_AWAITING_T0_DEPLOY`

## Incident

Opening the Personnel membership dialog and changing a move form field could
crash the client with `Cannot read properties of null (reading 'value')` before
the mutation request reached the server.

The team, effective-date, and reason handlers passed a functional state updater
that read `event.currentTarget.value` later, when React had already cleared the
handler's `currentTarget` reference.

## Fix

Each handler now copies the primitive string from `event.currentTarget.value`
inside the event callback and passes only that string into the queued state
updater. No API, database, OCC, idempotency, authority, or membership lifecycle
contract changes.

The focused regression rejects any membership form updater that reads
`event.currentTarget.value` from inside the queued callback and pins all three
captured fields.

## UAT

From Admin → Personnel, open one active personnel record with a current team,
choose Move, change the destination team, effective date, and reason, then
submit. The form must remain rendered, the POST must reach the canonical move
route, and the authoritative detail plus current/scheduled/history lists must
reload without a client exception.
