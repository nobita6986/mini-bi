# P2.5-W06A-R2 - Close manager operations UX (rebaselined)

Status: `P2.5-W06A-R2_LOCAL_PASS`. Base `origin/main@b4a75ab` (W04 T1C #53). Branch `feature/p2-5-w06a-r2`. No Production apply, no deploy, no main push, no rebase/amend/cherry-pick of pushed branches.

## Delta (on top of W06A-R1 ported from b1452f0)

- Migration **#54** `20261008140000_p2_5_w06a_manager_candidates.sql`: service-role RPC `direct_entry_list_project_manager_candidates(auth,app,search)` — requires `entry_admin + all` scope (`direct_entry_assert_project_admin`); returns ACTIVE recruiters with a VERIFIED effective account link (exact assign eligibility), searchable by display_name/personnel_code, bounded 100. Never returns auth_subject/app_user_id or PII.
- Contract `projectAdminCandidate(s)`; repository `listManagerCandidates`; API `listManagerCandidatesAdmin`; route `GET /api/direct-entry/manager-candidates?search=`.
- Model: `splitAssignments` now 3-way (current / future / history) from the authoritative `effective` flag + valid_from/valid_to; `parseCandidatesResponse` + `candidateLabel`.
- UI: manager selector is a combobox (search by name/code, stores recruiter_id, shows label — no raw UUID); assignment panel shows "Đang phụ trách" / "Sắp hiệu lực" / "Lịch sử" separately, and every open assignment (current + future) keeps revoke with reason + correct project/assignment OCC.

## Tests

`test:p2.5-w06a` 3 (candidate authority deny no-scope; active+verified-only + search; no auth/user/PII) · `test:server` 203 · `test:app-nav-02a` 89 · model 3-way split + candidate label · component source (combobox, no raw UUID, future section) · API candidate (gate first, actor from session). typecheck 0, lint 0 errors, build 0, `git diff --check` clean.

## Remaining blocker

W06A-R2's own acceptance is complete locally; the only external dependency left is Production apply sequencing (#50-#54) which remains T0-owned and is not performed here.
