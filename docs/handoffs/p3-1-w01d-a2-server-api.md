# P3.1-W01D-A2 — Team Leader server API

## Scope

Exposes the Team Leader lifecycle RPCs from migration #71 through the catalog
server boundary. No database migration, UI, Production action, deployment, or
browser/UAT work is included.

## Reused server patterns

- `checkSameOriginRequest` and `readBoundedJson` for mutation request safety.
- `validateClientBusinessPayload` for recursive authority-field rejection.
- `parseIsoDate` for real calendar-date validation.
- `getDirectEntryActor(createDirectEntryActorRepository())` for the session
  actor; request fields never select the actor.
- `serviceRoleRpc` and the existing strict projector/outcome/error patterns for
  RPC access and sanitized responses.

The repository is a thin RPC shim; it does not read tables or make authorization
decisions. Migration #71 remains the authorization authority.

## Route and RPC map

| Route | Operation | Migration #71 RPC |
| --- | --- | --- |
| `GET /api/admin/catalog/team-leaders?state=current|scheduled|history` | List current, scheduled, or history | `direct_entry_list_team_leaders_current`, `direct_entry_list_team_leaders_scheduled`, `direct_entry_list_team_leader_history` |
| `GET /api/admin/catalog/team-leader-candidates?team_id=...` | List candidates | `direct_entry_list_team_leader_candidates` |
| `POST /api/admin/catalog/teams/[teamId]/leaders` | Designate or replace | `direct_entry_designate_team_leader` |
| `POST /api/admin/catalog/teams/[teamId]/leaders/revoke` | Revoke | `direct_entry_revoke_team_leader` |

Only this route hierarchy is created. The contract strictly projects the
migration's leader and mutation shapes and the exact candidate shape
`{app_user_id, display_name, personnel_code}`; candidate personnel code is
required but nullable. Leader display identity is the persisted recruiter
projection returned by the RPC, not a current verified-link lookup.

## Authority and error mapping

| Operation | API boundary | Database authority |
| --- | --- | --- |
| Leader reads | Session actor only; no API-side role inference | Catalog operator may filter teams; leader may read only own effective team |
| Candidates | Session actor only | Catalog operator only; unavailable/inactive/reserved team is `P0002` |
| Designate/replace/revoke | Session actor, path team ID, exact body and idempotency checks | Catalog operator only |

The API returns sanitized `LEADER_*` responses: denied → 403, candidate
not-found → `LEADER_NOT_FOUND`/404, reserved or invalid mutation → 400,
optimistic/overlap conflicts → 409, and unknown/raw database failures → generic
unavailable. Raw database messages are never returned. Mutation responses use
strict private/no-store headers.

## Regression and mutation evidence

The focused A2 lane passed **13/13** tests, including the A1b1 and A1b2 PGlite
RPC suites. Coverage includes strict key projection, invalid calendar dates,
request ordering, same-origin and bounded JSON checks, recursive authority
rejection, session-derived actor, idempotency matching, one RPC per operation,
sanitized SQLSTATE mapping, route inventory, and persisted recruiter identity.

Eight mutation probes each made the relevant test lane fail, and each modified
file was restored byte-identically:

1. Permit an extra candidate `recruiter_id`.
2. Accept a missing leader-read state.
3. Bypass the same-origin guard.
4. Bypass recursive authority-field rejection.
5. Bypass idempotency header/body matching.
6. Misclassify `P0002`.
7. Make a second RPC call per operation.
8. Bypass ISO calendar-date validation.

## Gate evidence

- `pnpm test:p3-1-w01d-a2-leader-server` — pass, 13/13.
- W01A, W01B, W01C-A, W01C-B, and A1a focused lanes — pass.
- A1b1 and A1b2 PGlite lanes — pass within the focused A2 lane.
- `pnpm test` — pass after correcting two stale W04 lane names in the canonical
  chain to their existing script names.
- Next type generation, typecheck, lint, and build — pass (lint reports existing
  warnings outside this change).
- `pnpm docs:check`, `pnpm secrets:check` — pass.
- `pnpm db:migrate -- --offline` — all 71 migrations valid; no database access.
- `git diff --check` — pass.

## Review boundary

Base: `1189c8a77decbecec0b402b72f428cb0525b460d` (`origin/main` at task start).
This branch is awaiting T0 review; it is not merged or applied to Production.
