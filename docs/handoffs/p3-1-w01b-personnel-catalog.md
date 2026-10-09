# P3.1-W01B-R1 - HRP/Vendor isolation + fixed revision snapshot: P3_1_W01B_R1_LOCAL_PASS_AWAITING_T0_REVIEW

Same branch feature/p3-1-w01b-personnel-catalog. Base 9341230414cd04b0838fbc4f8293755375bcbb9c -> final (this commit). Fast-forward only. Migration #68 is still unreleased, so it was edited in place instead of adding #69; migrations #1-#67 stay byte-identical. No Production query/apply/deploy, no browser/UAT, no dependency, no sub-agent, no W01C/W01D/W02.

## Delta
- FIX 1 HRP/Vendor boundary: the admin personnel catalog is now exactly the recruiters holding a canonical effective HRP provider membership (provider_type = 'hrp' AND vendor_id IS NULL AND effective today), enforced in the list, the total count, the detail read and the lock/OCC helper. get/update/set-active therefore fail closed with P0002 for a Vendor recruiter, a recruiter with no provider membership and a recruiter whose HRP membership already expired. No team membership is required, so unassigned HRP personnel stay visible. Vendor rows, memberships and history are never read or written and no Vendor lifecycle work was added.
- FIX 2 fixed revision schema: direct_entry_personnel_snapshot is now one-argument and emits exactly six keys (recruiter_id, display_name, personnel_code, personnel_position, active, version) for every action. The conditional hrp_valid_from key is gone, so create/update/set-active revisions are comparable key-by-key; hrp_valid_from survives only in the create mutation result and in the admin projections.
- FIX 3 explicit valid_from and strict boolean: create requires a non-null valid_from and never coalesces it to the authorization date (22023 with zero residue otherwise), and include_inactive accepts only absent, "true" or "false" - anything else is 400 PERSONNEL_INVALID instead of silently defaulting to true.
- Unchanged by design: exactly one catalog-operator guard, authorization before input validation, Full Admin triple or catalog_master_manage at effective all scope, OCC/reason/idempotency/audit/revision, and no account/link/team/grant/scope mutation.

## Evidence
- Focused lanes: pnpm test:p3-1-w01b-personnel 29/29 pass, pnpm test:p3-1-w01a-capability-contract 9/9 pass.
- New DB regressions: list, count and detail exclude the Vendor recruiter; update and set-active reject it; the Vendor recruiter row, its membership and the Vendor row are value-equivalent before and after; zero revision/audit/reason/idempotency residue across nine rejected calls; the no-membership and expired-HRP controls are also P0002; an HRP person with no team is still listed. Exact-key revision assertions now cover create after, update before/after and set-active before/after, plus an audit-wide scan asserting the same six keys.
- Mutation-check: removing the HRP/Vendor boundary -> 2 red (both Vendor tests); adding a conditional field to the revision snapshot -> 4 red (create, update, set-active and the audit shape scan). The migration was restored byte-identical and the lane is green again.
- Gates all exit 0: pnpm test (50 lanes, 1850/1850 pass, 0 fail), next typegen, typecheck, lint (0 errors / 14 pre-existing warnings), build, docs:check (6/6), secrets:check, db:migrate -- --offline = 68 migration(s) valid, git diff --check.

## Scope limit
Backend only: no team membership, leader lifecycle, project guard, Vendor lifecycle, labor type, account/grant/link or UI work; no Production grant or apply.
