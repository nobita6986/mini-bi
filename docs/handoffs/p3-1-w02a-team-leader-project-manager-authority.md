# P3.1-W02-A Team Leader Project Manager authority

## Scope

Migration #72 extends Project Operations in place. It preserves migration
#1-#71 and the existing project, assignment, revision, OCC, reason,
idempotency, and audit ledgers. It does not introduce a parallel Project
Manager system, new dependencies, UI, routes, or API framework.

The server projects `can_manage_project_master` and `can_assign_managers` on
the existing project list and detail RPC results. Client models require both
values and never infer them from navigation or client state.

## Authority and behavior

| Actor path | Project reads | Manager candidates and assignment | Project master mutations | Audit authority |
|---|---|---|---|---|
| Legacy Project Admin (`entry_admin` + effective `all`) | All projects and assignments | All existing eligible managers | Allowed | `entry_admin`, `all` |
| Catalog operator (`catalog_master_manage` + effective `all`) | All projects and assignments | All existing eligible managers | Allowed | `catalog_master_manage`, `all` |
| Canonical Team Leader (`team_manager_assign` + effective `team` + W01D persisted leader assignment in that team) | Active projects; assignments visible only while the manager has one effective membership in the leader's team | Only eligible current members of the leader's team | Denied | `team_manager_assign`, `team`, the leader's team id |
| Staff, ordinary PM, disabled/unmapped/ambiguous actors | Denied | Denied | Denied | No mutation |

The internal Project Operations authority selector delegates leader resolution
to W01D's canonical resolver. Candidate and mutation checks use current
enabled-account, verified-link, active-recruiter, HRP-provider, and effective
team-membership state; `personnel_position`, email, and client authority
claims do not grant access.

Assignment requires an active project. Unassignment is allowed after project
deactivation, but only while the target manager remains an unambiguous current
member of the leader's own team. Historical assignments are not rewritten when
membership changes. The existing project-first, assignment-second OCC and
locking flow is retained, with leader authority and membership rechecked after
the locks. Team Leader RPCs cannot create, rename, activate, deactivate, or
otherwise mutate project master data.

## RPC and server projection map

| Existing Project Operations RPC | W02-A behavior |
|---|---|
| `direct_entry_list_projects_admin` | Retains admin catalog behavior; scopes Team Leaders to active projects and emits both authority flags |
| `direct_entry_get_project_admin` | Returns the existing master projection with both authority flags |
| `direct_entry_list_project_manager_assignments` | Retains full admin visibility; limits Team Leaders to assignments whose manager is a current, unambiguous member of their team |
| `direct_entry_list_project_manager_candidates` | Retains admin candidate eligibility and search; filters Team Leaders to eligible current own-team members |
| `direct_entry_assign_project_manager` | Preserves existing OCC/idempotency/revision semantics; allows own-team Team Leaders to assign eligible current members only to active projects |
| `direct_entry_unassign_project_manager` | Preserves existing OCC/idempotency/revision semantics; permits own-team Team Leaders to unassign even if the project is inactive |
| Project create/update/set-active RPCs | Continue to require Project Admin or catalog-operator authority; Team Leaders are denied |

Only `service_role` can execute the public RPCs. The added authority selector
is an internal `SECURITY DEFINER` helper with a fixed search path and no
application-role execute grants.

## Regression evidence

The focused PGlite lane `test:p3-1-w02a-team-leader-project-manager` covers:

- Legacy Project Admin and catalog operator compatibility, including master
  operations and `all`-scope audit fields.
- Own-team Team Leader candidate visibility, assignment, unassignment,
  post-lock membership enforcement, inactive-project restrictions, and
  `team_manager_assign` / `team` / `scope_team_id` audit fields.
- Cross-team rejection and the omission of out-of-team candidates and
  assignments.
- Rejection of staff, ordinary PM, disabled, unmapped, and ambiguous actors;
  ineligible target recruiters; stale OCC versions; and reused idempotency keys
  with conflicting input, with no rejected-mutation residue.
- Existing assignment history remaining unchanged when the target manager
  later changes teams.
- Exact addition of migration #72, byte-equivalent migrations #1-#71, and
  server-projected authority flags.

Mutation checks were run in-memory; each mutation made the focused lane fail,
and the migration file remained unchanged:

| Mutation | Result |
|---|---|
| Candidate projection leaks identity | Red |
| Candidate filtering admits cross-team recruiters | Red |
| Candidate RPC ACL grants another role | Red |
| Assignment omits post-lock leader recheck | Red |
| Assignment audit falsifies authority | Red |
| Project read flags overstate master authority | Red |
| Legacy Project Admin path is removed | Red |
| Candidate eligibility ignores enabled-account state | Red |
| Candidate eligibility ignores provider uniqueness | Red |

## Gates

| Gate | Result |
|---|---|
| W02-A focused PGlite lane | Pass, 2/2 |
| P2.5-W02 project authority/assignment lanes | Pass, 23/23 |
| P2.5-W06A manager candidate lane | Pass, 4/4 |
| W01D A1a schema / A1b1 reads / A1b2 writes | Pass, 17/17 / 1/1 / 1/1 |
| Canonical `pnpm test` | Pass |
| `pnpm exec next typegen` and `pnpm typecheck` | Pass |
| `pnpm lint` | Pass, existing warnings only; zero errors |
| `pnpm build` | Pass |
| `pnpm docs:check` | Pass, 6/6 examples |
| `pnpm secrets:check` | Pass, no secrets found |
| `pnpm db:migrate -- --offline` | Pass, 72 migrations validated without database access |
| `git diff --check` | Pass |

The local branch remains based on `1189c8a77decbecec0b402b72f428cb0525b460d`.
No Production database access, application, deployment, browser, or UAT work is
part of this change.
