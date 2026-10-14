# Pre-W2-HF-D3 — Hợp đồng cuối: Tài khoản truy cập và Nhân sự tuyển dụng

**Trạng thái:** `PRE_W2_HF_D3_CONTRACT_FINAL_READY_FOR_IMPLEMENTATION`

**Baseline:** `origin/main@aba3c58` · migration ledger `91/91`

**Thay thế:** toàn bộ chuỗi khảo sát `S0 → R1 → R2 → R3 → R4 → R5 → R6` trên nhánh `codex/pre-w2-hf-d3-s0-account-personnel-survey`

**Tính chất:** contract docs-only; chưa có source/API/SQL/UI implementation, chưa apply DB, chưa deploy.

## 1. Kết luận ngắn

HF-D3 sửa mô hình theo đúng nguyên tắc:

1. **Tài khoản truy cập được tạo trước.**
2. **Nhân sự tuyển dụng chỉ được tạo từ một tài khoản đang hoạt động và chưa gắn nhân sự.**
3. Một tài khoản và một nhân sự có tối đa **một liên kết hiệu lực 1:1**; lịch sử liên kết cũ vẫn được giữ.
4. Full Admin được tạo tài khoản, sửa tên hiển thị, đặt lại mật khẩu và tạo nhân sự từ tài khoản.
5. Không mở đổi email/login, invite, MFA, recovery, quên mật khẩu, tái tạo tài khoản đã xóa hoặc mô hình phòng ban trong Pre-W2.
6. Không xóa/gộp tài khoản hay nhân sự hiện có; không tự liên kết dựa vào email hoặc tên.

Đây là hợp đồng duy nhất dùng để chia task implementation. Không dùng riêng bất kỳ kết luận nào của R1–R6.

## 2. Bằng chứng và phát hiện

| ID | Bằng chứng trên `main` | Phát hiện bị khóa |
|---|---|---|
| E1 | `auth.users` → `direct_entry_app_users.auth_subject` → `direct_entry_app_user_recruiter_links` → `recruiters` | Tài khoản và nhân sự là hai aggregate khác nhau, nối bằng link row; không suy quan hệ từ email/tên. |
| E2 | Account runtime hiện chỉ có list/get/enable/disable | Chưa có create, sửa `display_name`, admin reset password. |
| E3 | Personnel catalog đang cho tạo recruiter tự do | Luồng này trái mô hình Owner yêu cầu và phải được thay bằng “tạo từ tài khoản”. |
| E4 | Các bảng Direct Entry thu hồi DML khỏi browser và `service_role` | Runtime Postgres write phải đi qua RPC `SECURITY DEFINER` hẹp, có guard/audit/OCC/idempotency. |
| E5 | Supabase Auth và Postgres không cùng transaction | Tạo account/reset password phải dùng durable intent; không được tuyên bố atomic xuyên hai hệ. |
| E6 | `direct_entry_app_user_revisions.action` là CHECK đóng | Migration phải mở rộng action rõ nghĩa; không tái sử dụng nhãn sai nghiệp vụ. |
| E7 | Link hiện chống overlap theo account nhưng chưa chống overlap theo recruiter | Cần guard đối xứng để khóa 1:1 hiệu lực. |

## 3. Phạm vi đã khóa

### 3.1 Có trong HF-D3

- Tạo access account bằng `login_id`, tên hiển thị và mật khẩu riêng.
- Sửa tên hiển thị của account; nếu account đang link nhân sự, đồng bộ tên nhân sự trong cùng transaction Postgres.
- Full Admin đặt mật khẩu mới cho account hiện có.
- Tạo Nhân sự tuyển dụng từ account đang hoạt động, chưa có link hiệu lực.
- Thay nút tạo personnel tự do bằng luồng chọn account.
- Bổ sung durable intent/reconcile tối thiểu cho hai thao tác qua Supabase Auth: create và reset password.
- Audit, OCC, idempotency, deny-by-default và các regression/mutation tests liên quan.

### 3.2 Không có trong HF-D3

- Đổi email hoặc `login_id` sau khi tạo.
- Invite/link có hạn, mật khẩu lần đầu, bắt đổi mật khẩu, MFA/challenge/recovery codes.
- Quên mật khẩu tự phục vụ, khôi phục/tạo lại account đã xóa.
- Xóa Auth user, xóa app user, merge theo email/tên, đổi UUID.
- Mô hình phòng ban Kế toán/IT hoặc phân quyền theo phòng ban.
- Tự sửa capability/scope/team/project khi tạo account/personnel.

Các mục trên vẫn thuộc Wave 3 hoặc task riêng; không dựng abstraction “cho sau này” trong HF-D3.

## 4. Quyền và ranh giới tin cậy

### 4.1 Full Admin duy nhất được ghi

Mọi mutation của HF-D3 yêu cầu actor thỏa đồng thời:

- account đang enabled và actor mapping hợp lệ;
- effective scope `all`;
- `entry_admin`;
- `recruiter_master_manage`;
- `team_master_manage`.

BoD/Kế toán không tự động được quyền chỉ vì nhãn vai trò. Browser không gửi role/scope làm authority. Tất cả quyền được resolve server-side từ DB.

### 4.2 Supabase Auth

- Chỉ server route được dùng Supabase Admin API; không đưa service-role secret ra browser/log/error/audit.
- `app_metadata.account_intent` là provenance marker do server ghi khi tạo Auth user.
- Marker **không phải secret** và không được tin từ JWT/client; reconcile chỉ tin dữ liệu đọc lại bằng Admin API.
- Auth user có sẵn nhưng không mang đúng marker của intent thì trả `BLOCKED`; không bind, không xóa, không sửa.

Tham chiếu nền tảng: [Supabase `auth.admin.createUser`](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [identity linking và email uniqueness](https://supabase.com/docs/guides/auth/auth-identity-linking), [`AdminUserAttributes.app_metadata`](https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/lib/types.ts).

## 5. Quy tắc dữ liệu nghiệp vụ

### 5.1 Tạo tài khoản

- `login_id` canonical theo regex hiện hữu: `^[a-z0-9][a-z0-9._-]{0,63}$`.
- Auth email được tạo đúng một cách: `<login_id>@hrpartner.vn`.
- `display_name`: trim, dài `1..256`, lưu ở `direct_entry_app_users`.
- Mật khẩu: `8..1024` byte như self-service hiện hữu; UI phải nhập lại để xác nhận.
- Cấm mật khẩu mặc định dùng chung. Mật khẩu/hash không được lưu trong bảng intent, audit, log, exception hoặc telemetry.
- `reason` và `idempotency_key` bắt buộc.
- Tạo account không tự grant capability/scope/link/team/project.

### 5.2 Sửa tên hiển thị

- Không đổi login/email/auth subject.
- Yêu cầu `expected_version`, `reason`, `idempotency_key`.
- Update app user, revision và audit trong một transaction Postgres.
- Nếu có recruiter link hiệu lực, update `recruiters.display_name` cùng transaction và tăng version/revision tương ứng.
- Không cập nhật recruiter lịch sử đã hết hiệu lực và không tìm recruiter theo chuỗi tên.

### 5.3 Tạo nhân sự từ tài khoản

- Account phải enabled, tồn tại duy nhất và chưa có recruiter link hiệu lực.
- Form chỉ nhận `account_ref`, `personnel_code`, `personnel_position`, `valid_from`, `reason`, `idempotency_key`.
- `display_name` luôn lấy server-side từ account; browser không được ghi đè.
- Một RPC Postgres tạo atomically: recruiter, HRP provider membership và verified/effective app-user↔recruiter link.
- `personnel_code` vẫn là mã nghiệp vụ riêng; unique/conflict thì fail, không tự liên kết với recruiter cũ.
- Personnel cũ không có account được giữ nguyên; không backfill hoặc auto-link.
- Chỉnh sửa/ngừng hoạt động personnel hiện hữu vẫn dùng workflow catalog hiện tại.

### 5.4 Cardinality

Tại mọi thời điểm:

- một app user có tối đa một verified/effective recruiter link;
- một recruiter có tối đa một verified/effective app-user link.

Migration thêm guard overlap đối xứng theo `recruiter_id`; không xóa lịch sử link đã hết hiệu lực. Nếu dữ liệu hiện tại vi phạm, migration fail closed và chỉ báo danh sách định danh nội bộ để T0 xử lý riêng; không tự sửa dữ liệu.

## 6. Durable intent tối thiểu

Chỉ create account và reset password cần intent vì đi qua Auth Admin API. Không dùng intent cho mutation thuần Postgres.

### 6.1 Trạng thái chuẩn

`PENDING → IN_FLIGHT → APPLIED | FAILED | INDETERMINATE | BLOCKED | CONFLICT | EXPIRED`

- Claim trước Auth call bằng một conditional update duy nhất: chỉ request chuyển được `PENDING` sang `IN_FLIGHT` mới được gọi Auth.
- Request thua claim đọc lại trạng thái và không gọi Auth.
- `APPLIED` chỉ khi quan sát được Auth success và hoàn tất Postgres/audit tương ứng.
- Timeout/network interruption sau khi đã bắt đầu Auth call là `INDETERMINATE`; không tự suy thành success/failure.
- Retry cùng `idempotency_key` không được gọi Auth lần hai khi trạng thái có thể đã tác động Auth.

### 6.2 Create account

1. Ghi intent trước, không chứa password.
2. Atomic claim.
3. `createUser` với email canonical, password trong memory và `app_metadata.account_intent=intent_token`.
4. RPC finalize tạo `direct_entry_app_users`, revision/audit và đánh dấu intent `APPLIED`.
5. Nếu process chết sau Auth call, Full Admin dùng reconcile; server đọc Auth user bằng Admin API và chỉ finalize khi marker khớp.
6. Auth user không marker/marker khác → `BLOCKED`; không tự bind hoặc delete.

Supabase Auth email uniqueness là duplicate guard bên Auth. Intent còn mở giữ unique canonical `login_id` bên Postgres để chặn hai create song song.

### 6.3 Reset password

1. Resolve `account_ref` → `auth_subject` server-side.
2. Ghi intent trước và atomic claim.
3. Gọi `updateUserById` một lần.
4. Ghi `APPLIED` khi nhận success, `FAILED` khi nhận failure xác định, `INDETERMINATE` khi không biết kết quả.
5. Với `INDETERMINATE`, Full Admin phát hành một reset mới có mật khẩu mới; hệ thống không replay mật khẩu cũ và không tự đánh `APPLIED`.

## 7. Retention đã chốt

| Loại | Quy tắc |
|---|---|
| `PENDING` chưa claim | Sau 15 phút chuyển `EXPIRED`; chưa gọi Auth. |
| `IN_FLIGHT` | Sau 15 phút chưa có kết quả chuyển `INDETERMINATE`; không gọi lại Auth. |
| Terminal xác định (`APPLIED`, `FAILED`, `EXPIRED`) | Sau 30 ngày null các trường định danh cá nhân; giữ tombstone `{idempotency_key, outcome}` tới 90 ngày rồi row purge nếu không còn foreign-key/audit dependency. |
| Reset `INDETERMINATE` | Giữ tối đa 30 ngày để operator xử lý, sau đó PII-field purge + tombstone; account đích vẫn tồn tại nên không cần giữ login provenance. |
| Create `INDETERMINATE`, `BLOCKED`, `CONFLICT` | Ngoại lệ phục hồi có chủ đích: giữ tối thiểu canonical `login_id` + `intent_token` tới khi Owner/T0 quyết định; cảnh báo sau 24 giờ và nhắc hàng tuần. Không auto-purge, auto-bind hoặc auto-delete Auth user. Quyết định cuối phải có audit. |

`login_id`, `display_name` là dữ liệu cá nhân; `auth_subject`, `app_user_id` là định danh giả danh. Tombstone tối thiểu không chứa các trường này. Cleanup/reclassification chạy qua RPC server-side khi Full Admin mở danh sách hoặc bấm reconcile; HF-D3 không thêm cron/scheduler mới.

Ngoại lệ create chưa giải quyết ưu tiên bảo toàn khả năng đối soát hơn hard TTL. Đây là quyết định cuối của slice này, thay cho các Option A/B/A1–A3 trong R5–R6.

## 8. API và UI tối thiểu

### 8.1 Routes

- `POST /api/admin/access/accounts` — create account.
- `POST /api/admin/access/accounts/[accountRef]/display-name` — edit display name.
- `POST /api/admin/access/accounts/[accountRef]/reset-password` — admin reset.
- `POST /api/admin/access/accounts/intents/[intentRef]/reconcile` — reconcile create intent.
- `POST /api/admin/catalog/personnel/from-account` — create personnel + HRP membership + link.

Mọi route mutation giữ pattern hiện hữu: session → Full Admin guard → same-origin/CSRF → content type → exact allowlist → repository/RPC; response `private, no-store`; lỗi không chứa email/password/Auth payload/SQL detail.

### 8.2 UI

Trang **Tài khoản truy cập** bổ sung:

- `Tạo tài khoản`;
- `Sửa tên hiển thị`;
- `Đặt lại mật khẩu`;
- trạng thái operation cần xử lý và action `Đối soát` cho Full Admin.

Trang **Nhân sự tuyển dụng**:

- thay `Thêm nhân sự` tự do bằng `Tạo nhân sự từ tài khoản`;
- chỉ liệt kê account enabled chưa có link hiệu lực;
- tên nhân sự được nạp từ account và không cho sửa trong create form;
- không thay đổi các thao tác sửa/ngừng hoạt động/quản lý nhóm hiện hữu.

## 9. Migration và tái sử dụng

### 9.1 Cần code/SQL mới

- Migration append-only kế tiếp tại thời điểm implementation; không giữ trước slot trong contract này.
- Intent table + CHECK/index/unique live-login guard và retention fields tối thiểu.
- Guard 1:1 đối xứng trên recruiter link.
- RPC create/finalize/update display-name/create-personnel-from-account/reconcile/cleanup hẹp.
- Mở rộng app-user revision action với nhãn mới rõ nghĩa.
- Server integration với Supabase Admin API và các route/UI ở §8.

### 9.2 Phải reuse

- Full Admin predicate và session access hiện hữu.
- OCC/version, restricted reason, idempotency và revision/audit patterns của W03A.
- `MIN_PASSWORD_BYTES=8`, `MAX_PASSWORD_BYTES=1024`, canonical `login_id` parser hiện hữu.
- Personnel catalog contract/repository/UI cho position, effective date, edit và active lifecycle.
- `direct_entry_app_user_recruiter_links` và overlap conventions; không tạo bảng mapping thứ hai.
- Supabase server client/Admin API hiện hữu; không thêm dependency.

## 10. Acceptance và mutation bắt buộc

### 10.1 Acceptance

- Full Admin tạo account thành công; account chưa có capability/scope/link mặc định.
- Actor thiếu bất kỳ thành phần Full Admin nào nhận `403` ở mọi mutation.
- Hai create đồng thời cùng login/intent chỉ có đúng một Auth call.
- Auth user pre-existing không đúng provenance bị `BLOCKED`, không bind/xóa.
- Sửa tên linked account đồng bộ recruiter atomically; OCC conflict không ghi nửa chừng.
- Reset success/failure/unknown map đúng `APPLIED`/`FAILED`/`INDETERMINATE`.
- Password/hash không xuất hiện trong DB intent/audit/log/HTML/JSON error.
- Tạo personnel chỉ từ enabled unlinked account; tạo recruiter + membership + link hoặc rollback toàn bộ.
- Không thể tạo hai effective accounts cho một recruiter hoặc hai effective recruiters cho một account.
- Personnel cũ, Auth user cũ và business links hiện tại không bị xóa/chỉnh tự động.
- Không đổi email/login và không mở quyền cho BoD/Kế toán ngoài Full Admin predicate.

### 10.2 Mutation probes

Ít nhất phải làm đỏ lane khi:

1. bỏ một capability/scope khỏi Full Admin guard;
2. tin role/login/marker từ client/JWT;
3. hai request cùng claim đều gọi Auth;
4. lưu/log password hoặc hash;
5. bind Auth user không đúng `app_metadata.account_intent`;
6. đổi `INDETERMINATE` thành `APPLIED` không có Auth success;
7. tạo personnel tự do hoặc lấy `display_name` từ browser;
8. bỏ guard 1:1 ở một trong hai chiều;
9. cập nhật app user nhưng không đồng bộ linked recruiter;
10. tự xóa/merge/backfill account-personnel hiện hữu.

## 11. Chia task implementation sau contract

1. **D3-A — DB foundation:** migration, intent/RPC/guards/self-check và DB tests.
2. **D3-B — Account server + UI:** Auth saga, routes create/edit/reset/reconcile và Account Manager.
3. **D3-C — Personnel-from-account + integration:** route/UI thay free-create, regression, handoff và Owner UAT checklist.

Thứ tự bắt buộc: `D3-A → T0 review/apply DB thử nghiệm → D3-B → D3-C → canonical regression → Owner UAT`. Các nhánh không tự chọn migration slot song song.

## 12. Owner UAT checklist

Owner tự thực hiện UAT; agent chỉ chuẩn bị danh sách:

- Tạo account mới, đăng nhập bằng `login_id` và mật khẩu riêng.
- Xác minh account mới chưa tự có capability/scope/personnel.
- Sửa tên account trước và sau khi gắn personnel.
- Reset mật khẩu: mật khẩu cũ bị từ chối, mật khẩu mới đăng nhập được.
- Tạo personnel từ account; tên được lấy từ account, position/effective date đúng.
- Thử account đã link, account disabled, trùng personnel code và actor không đủ Full Admin.
- Kiểm tra audit/revision không chứa password/email và dữ liệu cũ không đổi.

## 13. Biên an toàn

- Contract này không cấp quyền apply migration vào VPS/Production.
- Không deploy VPS, không truy cập/chỉnh DB VPS, không xóa dữ liệu.
- Implementation phải dừng nếu preflight thấy migration collision, dữ liệu vi phạm 1:1 hoặc Auth provenance không xác định; T0 báo Owner trước khi xử lý dữ liệu.

