# P2.5-W06-R2 - Runtime access + pagination

Status: `P2.5-W06-R2_LOCAL_PASS_AWAITING_T0_REVIEW`. Base `origin/main@32fa36ce72697fe7a799f4c41cd50012205543c4`; parent `0e2cbbaf7c7ddb71f6b43bdd2f3fd37a7113dbf3`. Branch `feature/p2-5-w06-worker-operations-ui`. No migration/backend contract, no Production apply, no deploy, no merge main.

## Delta

**F1 - reviewer AccessDenied luc mo trang**

- `initialWorkerTab(actor, canSeeAllWorkers)`: (entry_admin|change_review)+all → `all`; chi `change_request_create` → `managed`; entry_* → `uploader`. Page truyen projection toi thieu `{ capabilities, scopes:[{kind}] }` (khong auth_subject/app_user_id) — chi la lua chon UI ban dau, RPC van la authority.
- Moi tab giu `TabPage` rieng: 403 cua mot audience chi hien loi trong tab do, khong con `return <AccessDenied />` toan trang; nguoi dung doi tab duoc sau 403; review queue va cac tab khac khong bi thao.
- Doi tab/filter reset page cua scope do (state `loading`).

**F2 - thieu cursor/pagination**

- `TabPage<T>` + `applyPage`/`beginLoad`/`failLoad`/`resetTabPage`/`appendUnique` (dedupe stable id: `workerRowKey`/`submissionRowKey`/`requestRowKey`).
- Query builder `workersQuery`/`submissionsQuery`/`requestsQuery` chi gui cursor khi co; doi tab/filter khong mang cursor cu.
- `parseChangeRequestPageResponse` dung `projectChangeRequestListPage` — bo cast raw `as ChangeRequestListItem[]`.
- "Tải thêm" khi `has_more=true`; load-more loi giu nguyen page da tai (`failLoad` giu `items`).
- `DirectEntryChangeRequestList` nhan `hasMore` that.

## Before → after

| | 0e2cbba | R2 |
| --- | --- | --- |
| Reviewer mo trang | initialTab=uploader, submissions 403 → AccessDenied ca trang | initial tab=all, loi cuc bo theo tab |
| Pagination | khong co (1 page, bo cursor) | cursor + "Tải thêm" + append dedupe + reset theo scope |
| Review queue | cast raw payload, hasMore=false | `projectChangeRequestListPage`, hasMore that |

## Tests

`test:p2.5-w06` 38/38 (model 19 + component 19) — gom regression hanh vi moi: initial tab theo actor, append 2 page khong trung/khong sot, reset cursor khi doi tab/filter, load-more loi giu page, query khong mang cursor cu, malformed envelope/next_cursor fail-closed, review payload qua projector. 0e2cbba khong co cac helper nay nen assertion that bai that su.
`test:server` 204/204 · `test:app-nav-02a` 91/91 · `test:p2.5-w03` 22/22 · `test:p2.5-w05` 7/7 · typegen+typecheck 0 · lint 0 errors (13 warnings) · build 0 · `git diff --check` clean.

## Blocker

- Khong blocker backend. Production sequencing #50-#56 van thuoc T0; khong claim Production-ready.
