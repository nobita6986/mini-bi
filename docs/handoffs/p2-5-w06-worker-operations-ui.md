# P2.5-W06-R1 - Reviewer access, all-workers view and full proposer

Status: `P2.5-W06-R1_LOCAL_PASS_AWAITING_T0_REVIEW`. Base `origin/main@32fa36ce72697fe7a799f4c41cd50012205543c4`; parent `6cc2b5626e5764e318d2aed9117c70f61a0fba1c`. Branch `feature/p2-5-w06-worker-operations-ui`. No migration (contract #52-#56 du), no Production apply, no deploy, no merge main.

## Delta

- **F1 - shared authority**: `workerOperationsNavPredicate` (entry_admin|change_review + all, hoac change_request_create, hoac entry_own|entry_team|entry_admin) + `workerOperationsAllScopePredicate` / `workerOperationsReviewPredicate` trong `registry-capability.ts`; nav entry doi sang capability `worker_operations`; `decideWorkerOperationsPageAccess` dung CUNG predicate voi nav. Reviewer (change_review + all) vao duoc; reporting audience=all thieu capability bi tu choi; entry_own/entry_team van nhu cu.
- **F2 - all workers + review queue**: tab "Toàn bộ NLĐ" (`scope=all`) chi duoc offer khi server actor projection xac nhan (entry_admin|change_review)+all, RPC W03 van enforce; section review queue tai su dung `DirectEntryChangeRequestList` + `DirectEntryChangeRequestReviewer` (authority W05, `can_decide` server) voi catalog cache hien co; khong nhung Direct Entry editor.
- **F3 - proposer targets**: drawer gom 3 target dung builder hien co — `buildWorkerDetailsProposal` (complete canonical worker_details, display_name giu nguyen, 5 protected field read-only), `buildPaymentProposal` (nhan "Thông tin tài khoản ngân hàng"), `buildWorkStatusProposal` (giu nguyen leave reason/date/OCC). Khong co DOCUMENT/CCCD; khong lap validation song song.

## Access matrix (thuc te)

| Actor | Nav/page | scope=all tab | review queue | CTA de xuat |
| --- | --- | --- | --- | --- |
| Uploader (entry_own/team) | allow | khong | khong | chi khi `allowed_actions=true` |
| Recruiter (verified link) | allow (qua entry/change_request_create) | khong | khong | read-only (`NOT_PROJECT_MANAGER`) |
| PM (assignment hieu luc) | allow | khong | khong | `allowed_actions=true` tren row SUBMITTED |
| Admin (entry_admin + all) | allow | co | khong | theo row |
| Reviewer (change_review + all) | allow | co | co | khong (chi xem/duyet) |
| all scope thieu capability | deny | - | - | - |

## Gates

`test:p2.5-w06` 26/26 (model 11 + component source 15) · `test:app-nav-02a` 91/91 · `test:server` 204/204 · `test:p2.5-w03` 22/22 · `test:p2.5-w05` 7/7 · `test:p2.5-w06a` 4/4 · typegen+typecheck 0 · lint 0 errors (12 pre-existing warnings) · build 0 · `git diff --check` clean.

## Blocker

- Khong co blocker backend: contract #52-#56 du cho ca ba finding.
- Production sequencing #50-#56 van thuoc T0.
