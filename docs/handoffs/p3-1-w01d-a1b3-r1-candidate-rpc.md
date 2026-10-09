# P3.1-W01D-A1b3-R1 — Team leader candidate RPC

> Base: `db3a4a19e38013d07a6cce198a0c6b750ce342c5`
> Scope: close the A2-S0-R1 dependency by adding the candidate list RPC to migration #71 and correcting the transition audit's changed-field set. No migration #72 or Production work.

## Candidate read

Migration #71 now creates `direct_entry_list_team_leader_candidates(auth_subject, app_user_id, team_id, search, page, page_size)`. Its only actor authority decision is the canonical `direct_entry_assert_catalog_operator`; it does not fall back to leader authority. Entry-admin-only and team-leader actors are denied. Authorization runs before team/filter validation. Missing, inactive, and reserved Vendor teams all return the same generic `P0002`.

The RPC requires an active, non-reserved business team and returns only enabled app users with exactly one effective recruiter link and exactly one verified link, an active recruiter, one canonical HRP provider identity, and exactly one effective membership matching the requested team. It excludes candidates with a current or scheduled leader assignment, team scope, or `team_manager_assign` capability. Search is bounded to 256 characters; page is bounded to 1–1000 and page size to 1–100. Recruiter names come from the linked `recruiters` row. Results are ordered by `display_name, app_user_id`. The candidate projection has exactly three keys: `app_user_id`, `display_name`, `personnel_code`.

The RPC is `SECURITY DEFINER`, pins `search_path = pg_catalog, public`, and grants `EXECUTE` only to `service_role`. The migration closing self-check verifies the canonical catalog guard precedes input validation, definer/search-path/ACL, active-team and reserved-team constraints, `P0002` for an unavailable team, stable ordering, no call to the leader resolver, no `personnel_position` dependency, and the three-key projection.

All three leader read RPCs now join the persisted assignment identity by `recruiters.recruiter_id = assignment.leader_recruiter_id`, using `recruiters.display_name` in both search and projection. They do not resolve names through the current app-user recruiter link. Regression expires the historical actor's verified link and changes the account display name; the history read still returns the persisted recruiter's display name and searches by it.

## Audit correction

The legacy scope is deliberately retained unchanged during transition. Its audit `changed_fields` is now `team_leader_assignment` and `team_manager_assign`; `team_scope` is removed because that row is not changed.

## Regression and inventory

The A1b1 PGlite lane applies all 71 migrations and verifies Full Admin and catalog operator access; entry-admin-only and leader denial; generic `P0002` for missing/inactive/reserved teams; enabled/disabled account, missing/ambiguous verified links, inactive recruiter, Vendor provider, wrong/ambiguous memberships, existing leader authority and scheduled scope exclusion; bounded search/page/page-size, stable sorting/paging and exact three-key projection. It checks recruiter-based candidate search and history reads after link expiry, as well as runtime ACL, pinned search path, and source contracts. The A1b2 transition fixture asserts the corrected `changed_fields` exactly.

Measured inventory after R1: #70 **162 / 76 / 86**; #71 **174 / 81 / 93** (total / service-role executable / internal). Across A1b1/A1b2/A1b3, six service-role RPCs and six internal helpers were added; revoking the legacy seed shifts one existing function from service-role to internal. This R1 adds the sixth RPC. Migration ledger is **71**, #71 is last, and #72 does not exist. Migrations #1–#70 remain byte-identical.

## Review delta

This delta addresses the requested local review corrections: candidate output no longer includes `recruiter_id`; leader display/search use the assignment's persisted recruiter FK; unavailable candidate teams consistently use `P0002`; and candidate order is `display_name, app_user_id`. It preserves the corrected transition audit fields and adds revoked-link history regression. Gates and any mutation-check evidence must be recorded only after rerun for this delta.

## Review-fix validation

All eight focused read-lane mutations returned nonzero as expected: same-team guard, leader-assignment guard, active-team guard, zero-length current marker handling, reserved-team exclusion, authenticated EXECUTE grant, `personnel_position` authority, and cross-team empty-result behavior. After the checks, migration #71 remained byte-identical (SHA-256 `16F48637FA5C6960EF9173DC03FFA4D2DD822BE028F15DB4610CC6D4CCE2DEB5`) and the focused lane passed.

The following all passed after the review fixes:

- Focused A1b2 write, A1b1 read/candidate, A1a schema, W01C-B membership, W01C-A team catalog, W01B personnel, and W01A capability lanes.
- Canonical `pnpm test`.
- `pnpm exec next typegen`, `pnpm typecheck`, `pnpm lint` (0 errors; 15 pre-existing warnings), and `pnpm build`.
- `pnpm docs:check`, `pnpm secrets:check`, `pnpm db:migrate -- --offline` (71 valid; no database access), and `git diff --check`.

The PGlite read lane verified migration #1–#70 byte identity, 71 migrations total, and no #72. Measured function inventory remains #70 **162 / 76 / 86** to #71 **174 / 81 / 93** (total / service-role executable / internal); this implementation adds the candidate RPC within #71, so there is no inventory delta beyond the already recorded R1 baseline.

## Boundary

No merge to `main`, Production query/apply, deployment, browser/Playwright/CUA/UAT, API/UI, A2 implementation, or later workstream. Browser UAT remains Owner-run.
