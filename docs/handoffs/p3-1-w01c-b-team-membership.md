# P3.1-W01C-B-R1 - three T0 review blockers fixed: P3_1_W01C_B_R1_LOCAL_PASS_AWAITING_T0_REVIEW

Branch feature/p3-1-w01c-b-team-membership. Base f1c635123e23ccd66969b3a631858b4ab4861886 -> final (this commit). Fast-forward only; migration #70 is edited in place because it is still unreleased (no #71), migrations #1-#69 stay byte-identical. No Production query/apply/deploy, no browser/UAT, no dependency, no merge of main.

## FIX 1 - keep the W01C-B scope exact
#70 now relaxes ONLY recruiter_team_memberships_check (valid_to > valid_from -> >=) and swaps the membership uniqueness constraint for the marker-excluding partial index. The scope and capability CHECK changes were removed from #70: a zero-length scope/capability interval is again rejected with 23514 exactly as before #70, and a self-check re-asserts both stay strict until W01D introduces them atomically with the leader designate/revoke RPCs. Regression: the membership marker written by the audited RPC is inert, a raw membership marker is 23514, a raw zero-length scope/capability is 23514, and every pre-existing effective predicate is unchanged.

## FIX 2 - split creation and revocation authority
Assign/move still require an active recruiter plus a canonical effective HRP provider membership. Unassign/cancel now uses a new close-only lock helper (direct_entry_lock_membership_close_target) that enforces the recruiter row lock and OCC without creation eligibility, so a stale open membership can still be closed when the person is inactive, the HRP membership has expired or is missing, or the provider has switched to Vendor - and unassign still creates no membership, changes no team, never re-dates valid_from and never re-activates the person. Regression covers all three ineligible subjects (unassign OK, assign/move P0002, stale version and back-date conflict zero residue).

## FIX 3 - calendar-valid API dates
teamMembershipAssignRequest / teamMembershipUnassignRequest now validate real calendar dates through the shared pure parseIsoDate (never new Date("YYYY-MM-DD")): 2026-02-30, 2026-13-01 and 2026-00-10 return 400 MEMBERSHIP_INVALID before the session/repository, while 2028-02-29 stays valid. The mutation response projection still trusts the DB date.

## Evidence
- Focused lane 34/34 (22 DB + 12 API); W01C-A 25/25, W01B 29/29, W01A 9/9 stay green. #1-#69 byte-identical; migration #70 is the only new migration.
- Mutation-check, each demonstrated red and then restored byte-identical: re-open the scope/capability schema in #70 -> 1 red; point unassign back at the strict creation lock -> 1 red; replace the calendar validator with the old regex -> 3 red. The six earlier blockers were re-verified too: vendor guard 1 red, reserved trigger 3 red, OCC 2 red, marker-effective 1 red, revision drop 5 red, back-date protection 1 red.
- Gates all exit 0: pnpm test (52 lanes, 1909/1909 pass, 0 fail), next typegen, typecheck, lint (0 errors / 14 pre-existing warnings), build, docs:check (6/6), secrets:check, db:migrate -- --offline = 70 migration(s) valid, git diff --check.

## Scope limit
Membership only: no W01D leader lifecycle, W02 project-manager assignment, Vendor lifecycle, labor type, account/grant/link administration or UI, and no scope/capability write RPC.
