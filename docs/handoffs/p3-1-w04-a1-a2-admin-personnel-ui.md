# P3.1-W04-A1/A2 — Admin shell và Personnel Catalog UI

## Base và phạm vi

- Branch: `feature/p3-1-w04-a1-a2-admin-personnel-ui`.
- Base `origin/main`: `f9d77c690a8430c53248daf4b1ebd5216fdcd6bb`.
- Final implementation/source SHA after T0 R1: `d3dfc305d2bfe4fdb6b27fa4655a15a226472298`; commit handoff được tạo riêng sau đó.
- Base có 70 migrations; migration cuối là `20261009060000_p3_1_w01c_b_team_membership.sql`.
- Không thêm migration, dependency hoặc API backend. UI chỉ gọi W01B API hiện có.
- Chỉ triển khai Admin shell/navigation và Personnel catalog. Không triển khai Membership UI, Team UI, Leader UI, Vendor, Labor Type hoặc Access Admin.

## Routes, components và models

### Page/UI routes

- `/admin` — `src/app/admin/page.tsx`; server-side quyết định quyền và trang tổng quan Admin.
- `/admin/catalog/personnel` — `src/app/admin/catalog/personnel/page.tsx`; server-side quyết định quyền trước khi render client manager.
- `src/app/admin/layout.tsx` — tái sử dụng `AppShell`, xử lý access decision và chỉ render subnav có authority.
- `src/components/admin/admin-subnav.tsx` và `src/lib/admin/admin-navigation.ts` — internal Admin navigation với duy nhất section Nhân sự đang triển khai.
- `src/components/admin/personnel-catalog-manager.tsx` — list, search, inactive filter, paging, create, edit, activate/deactivate và retry/conflict UX.
- `src/lib/admin/personnel-catalog-model.ts` — query/body builders, strict response projectors, outcome classification và conflict-lock helper.

### W01B API được sử dụng

| Method / route | Mục đích | Contract chính phía UI |
|---|---|---|
| `GET /api/admin/catalog/personnel` | Danh sách | Luôn gửi `page_size=25`, cùng `search`, `include_inactive`, `page`; kiểm tra strict envelope và echo bộ lọc. |
| `POST /api/admin/catalog/personnel` | Tạo hồ sơ | `expected_version=0`; gửi mã, tên, vị trí, `valid_from`, reason bắt buộc và idempotency key. |
| `GET /api/admin/catalog/personnel/[recruiterId]` | Đọc lại hồ sơ có thẩm quyền | Strict project response; dùng để xác nhận/reload sau OCC conflict. |
| `PATCH /api/admin/catalog/personnel/[recruiterId]` | Cập nhật hồ sơ | Chỉ gửi mã, tên, vị trí, authoritative `expected_version`, reason và idempotency key. |
| `POST /api/admin/catalog/personnel/[recruiterId]/active` | Kích hoạt/ngừng hoạt động | Gửi `active`, authoritative `expected_version`, reason và idempotency key; không hard-delete. |

Các route dùng backend W01B; client không gọi Supabase, RPC hoặc database trực tiếp. Contract nguồn: `src/lib/direct-entry/personnel-catalog-contract.ts`; API và repository hiện hữu: `src/lib/direct-entry/personnel-catalog-api.ts` và `src/lib/direct-entry/personnel-catalog-repository.ts`.

## Authority và page access

| Predicate | Điều kiện chính xác | Kết quả |
|---|---|---|
| `catalog_operator` | `catalog_master_manage` và effective scope `all` | Cho phép `/admin` và Personnel; gồm Accounting có catalog authority. |
| `admin_security` | Cả `entry_admin`, `recruiter_master_manage`, `team_master_manage` và effective scope `all` | Cho phép Admin theo Full Admin canonical. |
| `admin_area` | `catalog_operator OR admin_security` | Predicate duy nhất của top-level nav entry `admin`. |
| Mọi trường hợp khác | Thiếu capability, thiếu `all`, `entry_admin` đơn lẻ, `team_manager_assign` đơn lẻ hoặc chỉ có thuộc tính chức danh như Leader/PM/Staff | Không cấp quyền. |

Không suy quyền từ role, email, `personnel_position` hay client state. Actor disabled/missing mapping nhận trạng thái account unavailable; actor ambiguous hoặc lỗi resolve fail-closed thành temporary unavailable. Cả `/admin` và `/admin/catalog/personnel` có page decision server-side; menu hiding không thay thế page/API/RPC guard.

Đăng ký đúng một top-level Admin entry (`id: admin`, `path: /admin`, `capability: admin_area`) trong `src/lib/navigation/registry.ts`. Admin subnav chỉ có Personnel; không có link Team/Vendor/Labor Type/Access. Predicate tập trung ở `src/lib/navigation/registry-capability.ts`; route decisions ở `src/lib/auth/direct-entry-page-access.ts`. `src/lib/navigation/resolve-nav-actor.ts` cung cấp request-scoped actor projection tối thiểu; dashboard resolve nav actor cho Admin kể cả khi Direct Entry UI flag tắt.

## UI và interaction contract

- Danh sách hiển thị tên, mã, vị trí, trạng thái, version và ngày HRP hiệu lực; UUID kỹ thuật chỉ dùng nội bộ cho key/route, không dùng làm nhãn.
- Search, include inactive và paging dùng API canonical; query có giới hạn, mặc định page size luôn được truyền rõ ràng.
- Projector từ `personnel-catalog-model.ts` từ chối payload sai shape hoặc sai filter echo, không biến lỗi thành danh sách rỗng.
- Mỗi intent tạo idempotency key một lần; retry cùng intent tái sử dụng body/key đó.
- Reason bắt buộc cho create/update/set-active. Create gửi version `0`; update và set-active gửi version authoritative đang đọc.
- `409` khóa mutation của hồ sơ đó. Chỉ mở khóa khi GET detail (hoặc list xác nhận create conflict) thành công và payload authoritative hợp lệ; lỗi reload giữ nguyên khóa.
- Kích hoạt/ngừng hoạt động có xác nhận rõ ràng, không xóa cứng và hồ sơ inactive vẫn có thể xem qua filter.
- Loading, empty, denied, unavailable, error và conflict là các trạng thái riêng. 401/403 không được thể hiện như “0 bản ghi”; lỗi không hiển thị raw database response.
- UI tiếng Việt, table semantic có vùng cuộn ngang, form có label, status/alert roles và Radix Dialog quản lý focus/keyboard.

## Reuse

- Dùng navigation registry/pure predicates, page decision hiện có, `resolveActorForRequest`, `AppShell`, `AccessDenied`, `AccountUnavailable` và `TemporaryUnavailable`.
- Dùng `Card`, `Alert`, `EmptyState`, `ErrorState`, Radix Dialog, cùng `validateReason`, `newIdempotencyKey`, version/UUID validators và intent patterns từ Project Operations.
- Trạng thái active/inactive dùng badge ngữ nghĩa cục bộ; `StatusBadge` hiện hữu biểu diễn trạng thái run báo cáo nên không phù hợp để tái sử dụng cho personnel.
- Không thêm spreadsheet, generic CRUD framework, RBAC client-side, dependency hoặc API validation trùng lặp.

## Tests và gates

- `test:p3-1-w04-a1-a2`: 145 pass after T0 R1; authority/nav/page-access, one-entry/subnav, strict personnel projection/query/body, OCC/idempotency, dialog error visibility, dismissible conflict lock and authoritative 404 handling, plus structural UI/API checks. Lane được đăng ký đúng một lần trong `package.json` và canonical `pnpm test`.
- `test:p3-1-w01a-capability-contract`: pass; 23 capability tokens.
- `test:p3-1-w01b-personnel`: pass.
- Các nav, AppShell và Direct Entry page-access regression được chạy trong focused lane.
- Full canonical `pnpm test`: pass, exit code 0; final runner 144 pass / 0 fail. Lane W04-A1/A2 được chạy đúng một lần.
- `pnpm exec next typegen`, `pnpm typecheck`, `pnpm build`: pass. Production build xác nhận routes `/admin` và `/admin/catalog/personnel`.
- `pnpm lint`: 0 errors; 14 warnings cũ ở file không thuộc thay đổi của task.
- `pnpm docs:check`: 6/6 pass; `pnpm secrets:check`: pass, 1,613 file được quét; `pnpm db:migrate -- --offline`: 70/70 valid, không truy cập database; `git diff --check`: pass.

### T0 R1 UX follow-up

- Mutation errors (invalid, denied, unauthenticated, not found) are displayed as an accessible alert inside the open dialog.
- OCC conflict dialogs can be dismissed. Entity locks and retryable authoritative reload controls remain available outside the dialog; conflict state is keyed by entity so resolving one conflict does not release another.
- An authoritative detail `404` is treated as a no-longer-available record: its mutation lock is cleared and the list reloads. `403`, other non-success responses, transport errors and malformed projections retain the lock and expose a retryable reload error.
- Replaced the mixed-language message with Vietnamese-only copy.
- R1 gates: focused lane 145/145 pass, `pnpm typecheck`, targeted ESLint, `pnpm build`, and `git diff --check` pass. Full canonical suite was run and passed before the R1 follow-up; it was not rerun after R1.

## Còn lại và ranh giới

- W04-A3: Membership current/scheduled/history và assign/move/unassign; phụ thuộc W01C-B.
- W04-A4: Team catalog UI; phụ thuộc W01C-A.
- W04-B Leader UI: chờ W01D ổn định/được đưa vào base.
- Owner-only browser UAT chưa chạy theo yêu cầu. Không chạy browser, Playwright, CUA hay UAT.
- Không truy vấn/áp dụng database Production, không deploy.
