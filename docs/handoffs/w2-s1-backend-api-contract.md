# Bàn giao hợp đồng Backend/API W2-S1

Tài liệu này dành cho tích hợp T1A/T1C. W2-S1 tiếp tục dùng pipeline tài liệu Direct Entry hiện có; không tạo pipeline upload/đọc thứ hai.

## Portrait khi nhập hồ sơ mới

### Tạo stage

`POST /api/direct-entry/worker-portrait-stages`

- Gửi `multipart/form-data` với đúng một trường `file` và header `Idempotency-Key` là UUID.
- Chỉ nhận JPEG/PNG. Kích thước tối đa theo giới hạn upload tài liệu hiện tại.
- Máy chủ kiểm tra chữ ký/nội dung, giải mã và re-encode bằng Sharp để loại EXIF/metadata trước khi ghi vào private R2 staging.
- Máy chủ tạo stage ID, checksum và metadata; actor luôn lấy từ session rồi xác minh lại ownership/capability trong DB.
- Phản hồi gồm `stage_id`, `mime_type`, `size_bytes`, `status`. Không trả tên tệp, object key, bucket hay URL.
- Cùng actor + cùng key + cùng MIME/size/checksum sau sanitize trả lại cùng stage; retry không tạo stage/object key thứ hai.
- Cùng actor + cùng key nhưng nội dung khác trả conflict trước khi ghi bytes. Cùng key giữa actor khác nhau là độc lập.
- API ghi stage theo ID do DB/RPC chọn; nếu response mất sau khi DB commit, retry lấy lại ID rồi ghi/lặp lại object tại key tất định đó.

### Lưu hồ sơ và promote

`POST /api/direct-entry/batches/full-profile`

- Mỗi row có thể gửi `portrait_stage_id` tường minh.
- `document_upload` là capability bắt buộc ở stage create/claim, stage-aware batch, reserve, finalize và DB completion; `change_request_create` không thay thế quyền upload.
- API claim stage theo actor và `Idempotency-Key` của thao tác lưu. Cùng stage không thể được claim bởi batch khác.
- Trước khi gọi RPC tạo batch, API bỏ `portrait_stage_id` khỏi row để mã stage không vượt qua boundary nghiệp vụ cũ.
- Chỉ sau khi RPC batch tạo draft thành công, API đọc lại version tin cậy của entry, reserve `WORKER_PORTRAIT` qua repository tài liệu hiện hành, copy stage vào storage key do DB cấp và gọi cùng luồng finalize hiện có.
- Finalize tiếp tục kiểm tra MIME/nội dung, re-encode để bỏ metadata, tính checksum từ bytes cuối, áp dụng OCC và ghi audit/lifecycle.
- Nếu DB từ chối rõ ràng thao tác lưu, recovery kiểm tra idempotency dưới lock trước khi cancel/xóa stage; nếu đã có kết quả commit thì giữ claim để retry. Nếu kết quả DB hoặc promote/finalize không xác định, không giải phóng claim và API trả lỗi thay vì giả thành công.
- Client hủy stage bằng `DELETE /api/direct-entry/worker-portrait-stages` với JSON `{ "stage_id": "uuid" }`. Chỉ chủ stage mới xóa được; stage đang claim/đã attach không thể cancel.

Client tích hợp phải tạo key ổn định cho một lần chọn ảnh, giữ cùng `File` và key khi retry POST, giữ `stage_id` tới khi lưu hoàn tất và dùng key riêng cho retry batch; nếu người dùng hủy nhập liệu, gọi DELETE. Không gửi bytes portrait trong payload batch và không gửi storage key.

### Khôi phục stage khi mất key/kết quả chưa rõ

`POST /api/direct-entry/worker-portrait-stages/recover` nhận JSON `{ "stage_id": "uuid" }`. Actor lấy từ session; DB xác minh ownership. Với stage `CLAIMED`, recovery lấy advisory lock dùng chung với batch theo actor/idempotency key rồi khóa stage trong transaction:

- Không có idempotency result đã commit: trả stage về `STAGED`, xóa claim key; caller có thể claim lại.
- Có result đã commit: giữ `CLAIMED` và trả key để client retry đúng payload/key ban đầu.
- Có record nhưng result chưa hoàn chỉnh: fail closed, không giải phóng claim.
- `ATTACHED`/`CANCELLED` là trạng thái terminal; recovery không đổi trạng thái và có thể retry xóa object.

Không hủy stage đang `CLAIMED` hoặc `ATTACHED`. Xóa object idempotent/retryable; DB state terminal được commit trước khi gọi xóa. Migration #116 bổ sung cleanup-pending có lease cho stage `STAGED` hết TTL; `CLAIMED` không bị tự thu hồi.

### B1 — TTL/reaper cho stage mồ côi

Idempotency chỉ làm retry an toàn; **không** dọn stage nếu người dùng đóng tab và không retry. Migration #116 triển khai TTL 24 giờ cho stage `STAGED`: RPC service-role claim tối đa 100 stage theo lô bằng `FOR UPDATE SKIP LOCKED`, chuyển trạng thái trong cùng transaction sang `CANCELLED` + cleanup-pending và lease 5 phút. Worker chạy tối đa 50 stage/lượt; xóa object xác định từ stage UUID qua `deleteEnrollmentPortraitStage(stage_id)` (không list bucket/prefix), rồi xác nhận bằng claim token. Xóa thất bại hoặc worker dừng trước xác nhận được retry khi lease hết hạn; xóa object lặp lại an toàn. Không tự claim/thu hồi `CLAIMED` hoặc `ATTACHED`; race với batch claim được khóa ở DB.

Runner one-shot được gọi từ root repo/runtime bằng `pnpm reap:w2-s1-portrait-stages` (script chạy `node --conditions=react-server scripts/reap-w2-s1-portrait-stages.mjs`). Mỗi lần chạy cần inject qua secret/environment manager:

- `W2S1_PORTRAIT_STAGE_REAPER_ENABLED=true`
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`
- `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

Không đưa secret vào command-line, cron text, log hoặc repository. Với môi trường container/managed jobs, scheduler cần khởi chạy đúng image/revision định danh, inject các biến từ secret store tương ứng, chạy one-shot theo lịch (ví dụ mỗi giờ), lưu exit status/log đã sanitize và alert khi exit khác 0/backlog tăng. Với VM, cron hoặc Windows Task Scheduler cần đặt working directory ở release root, gọi `pnpm reap:w2-s1-portrait-stages`, và nạp env qua secret store/wrapper bảo vệ thay vì ghi secret trực tiếp trong task/cron definition. Dev/test chỉ dùng cấu hình disposable; không trỏ runner vào DB/R2 thật trong test.

**Chưa cấu hình cron/scheduler/worker vận hành ở bất kỳ môi trường nào**; ví dụ lịch giờ chỉ là gợi ý, không phải cấu hình đã triển khai. Production cần phê duyệt vận hành riêng, service-role secret và R2 credentials trong secret store đúng môi trường trước khi bật; phần này không deploy hay cấu hình tại lượt này. Vì thế TTL/reaper chưa tự chạy.

`POST /api/direct-entry/batches` thường không nhận `portrait_stage_id`; stage-aware path hiện tại là `/batches/full-profile`. Không mở rộng endpoint thường vì cần chốt riêng contract về capability, claim atomicity, retry/idempotency và promote/finalize.

## Projection và đọc portrait

`GET /api/direct-entry/entries/{entryId}` giữ projection `worker_portrait`:

```json
{
  "origin": "ENROLLMENT | LEGACY_ADDED | null",
  "added_at": "ISO-8601 timestamp | null",
  "status": "MISSING | QUEUED | UPLOADING | QUARANTINED | SCANNING | READY | FAILED | SUPERSEDED",
  "current": {
    "document_id": "uuid",
    "version": 1,
    "checksum_sha256": "64 ký tự hex chữ thường",
    "mime_type": "image/jpeg | image/png",
    "size_bytes": 1
  }
}
```

`current` là `null` nếu chưa có bản được chấp nhận. `origin` và `added_at` do DB/server xác lập; portrait không bị sao chép vào mảng `documents` chung. Khi actor không được phép xem portrait, projection không chứa bytes, storage key hay URL.

Đọc bytes portrait bằng:

`GET /api/direct-entry/entries/{entryId}/documents/{documentId}/preview`

Route trả ảnh trực tiếp với `private, no-store`, yêu cầu session, `document_view` và scope đọc hiện hành; fallback `entry_privileged_edit` chỉ áp dụng cho đúng portrait preview trong scope đã khóa. Route không trả signed URL hoặc storage key. `/download` generic không phát signed URL cho portrait.

## Preview CCCD riêng

`GET /api/direct-entry/entries/{entryId}/documents/{documentId}/cccd-preview`

- Chỉ chấp nhận `CCCD_FRONT`/`CCCD_BACK` ở trạng thái READY + VALIDATED + CLEAN/NOT_REQUIRED, JPEG/PNG và checksum hợp lệ.
- Dùng `document_view` từ session và purpose riêng `cccd_preview`. DB xác minh scope đọc entry bằng dữ liệu server hiện hành; nếu không có scope đọc submission thì dùng guard `document_view`/entry-scope thông thường. Không dùng fallback `entry_privileged_edit` của portrait preview.
- Generic `purpose='download'` không đổi: vẫn luôn gọi `direct_entry_assert_draft_access`, gồm CCCD và hợp đồng.
- Trả bytes inline, `private, no-store`, `nosniff`, CSP sandbox; không trả storage key, redirect hay signed URL. PDF và tài liệu khác bị từ chối.

## GET entry detail và 404

Regression chứng minh projection entry có CCCD vẫn đọc được với actor được repository cho phép; actor bị từ chối vẫn nhận 404 theo quy tắc che giấu hiện hữu. Chưa tái hiện được 404 riêng do CCCD; không bỏ guard, không đổi 404 thành dữ liệu rỗng. Những nguyên nhân 404 đã xác định gồm feature gate `DIRECT_ENTRY_API_ENABLED` đang tắt hoặc RPC báo denied/not-found.

## Migration và ledger

Ledger hiện có 116 migration; #115 (idempotent create stage) và #116 (TTL/reaper) được append-only; không sửa #111–#114:

- #111 `20261017100000_pre_w2_s1_worker_portrait_private_projection.sql` — checksum `migrationChecksum()`: `7e19aecfb9417645a80120704be790d67a13986788a777cac30c7b62de8c66ff`
- #112 `20261017110000_pre_w2_s1_document_direct_context_access_guard.sql` — checksum `migrationChecksum()`: `82607beb7157d90e6aeea0e667715e1ae1ca73ed76e801f15d32cffe4dcba8cd`
- #113 `20261018090000_w2_s1_worker_portrait_enrollment_staging.sql` — checksum `migrationChecksum()`: `933f05ef892520661dcb8305f7b9ccf1a8e93e4ad52b17102593e104e092f326`
- #114 `20261018110000_w2_s1_portrait_stage_recovery_cccd_scope.sql` — checksum `migrationChecksum()`: `06880235a44c3dd75fca7be4bf1d6b3e0e3d1034eddb29e8fa8681471b7d9699`
- #115 `20261018130000_w2_s1_portrait_stage_create_idempotency.sql` — checksum `migrationChecksum()`: `6a0bdb49d719e1545f8411ae3eb105341d82f346737dee2aee8f39208d55037e`
- #116 `20261018140000_w2_s1_portrait_stage_ttl_reaper.sql` — checksum `migrationChecksum()`: `e414043e82b618eb6c81a81fbc1f7cf7fd526eafb59f7d193175be4d1337aed8`

Checksum dùng helper `scripts/lib/migration-validation.mjs` (SHA-256 sau chuẩn hóa newline LF), không phải hash raw bytes. #111–#114 và #115 giữ nguyên. #115 thêm unique `(created_by_user_id, create_idempotency_key)` và RPC service-role-only dùng advisory transaction lock để serialize actor+key; response replay chỉ cho cùng MIME/size/checksum. #116 thêm cleanup metadata, RPC claim/complete chỉ cho service role và lease retry. Migrations chỉ được kiểm tra offline bằng PGlite/PostgreSQL ephemeral; không apply vào DB thật.

## Xác minh GET 404 và quyền truy cập

- Actor có quyền và scope đọc projection entry có CCCD: 200.
- Actor bị từ chối: 404 như trước.
- Preview CCCD dùng purpose riêng `cccd_preview`, yêu cầu `document_view` từ session và scope entry được DB/server xác nhận; không dùng fallback portrait và không đổi guard download chung.
- Không truy cập staging/Production/VPS; không đọc/ghi DB môi trường thật; không deploy.

## Kiểm thử và trạng thái bàn giao

Đã bổ sung/duy trì regression cho CCCD preview (capability, scope/IDOR, MIME, lifecycle, checksum, cache và không lộ storage key), GET entry có CCCD, portrait stage/failure cleanup/cancel, EXIF stripping, idempotency/OCC qua pipeline finalize, quyền/RLS, rollback khi migration #112–#114 gặp drift, TTL boundary, `CLAIMED` exclusion, lease/reclaim, cleanup token/ACL và race giữa reaper với stage claim.

- `pnpm test:w2-s1-backend`: **85/85 PASS**, gồm migration #112–#116, test TTL/retry PGlite và race cleanup-vs-stage-claim trên PostgreSQL ephemeral; không có test skip.
- `node scripts/apply-migrations.mjs --offline`: **116 migrations VALID**, không truy cập DB.
- `pnpm test:p1.6-i04c3-s01`: đạt, 51/51.
- `pnpm test`: chưa chạy đủ toàn chuỗi trên WIP hiện tại. Lần chạy trước bị dừng tại lane `test:p2.5-hf-r2`; các assertion ledger/inventory được cập nhật nhưng chưa xác minh toàn bộ shard. Không kết luận toàn suite đạt.
- `pnpm typecheck`, `pnpm lint` và `pnpm build`: **PASS** trên diff hiện tại; build dùng Next.js 16.3.8. Lint có 14 cảnh báo hiện hữu, 0 lỗi.
- Test scripts ngoài W2S1 chỉ đổi assertion số ledger, tail-offset của migration lịch sử, inventory migration hoặc allowlist append-only cho #115/#116. Không nới assertion nghiệp vụ. Các test này pin ledger hiện hành; migration cụ thể vẫn được kiểm tra theo filename/slot. Inventory RPC hiện là `255` tổng, `127` service-role, `128` internal.
- Checksum #111–#116 được tính trực tiếp từ `migrationChecksum()`; #111–#115 giữ nguyên. Migration #115/#116 chỉ được kiểm tra bằng PGlite/PostgreSQL ephemeral và offline; không apply migration lên DB thật.

Branch `codex/w2s1-stage-idempotency`, worktree `C:\CodeApp\BI\.worktrees\w2s1-api-followup`; changes đang là working-tree diff, chưa commit/push/merge. Không apply migration, không truy cập DB thật, không deploy.

Không có regression tái hiện 404 riêng do CCCD; không đổi semantics 404. Client nên gọi DELETE khi hủy portrait stage; nếu bỏ lỡ, stage `STAGED` sẽ chỉ được dọn khi reaper được vận hành theo lịch. Chưa cấu hình lịch chạy, nên cleanup chưa tự động hoạt động. Không truy cập staging/Production/VPS/DB môi trường thật, không apply migration, không triển khai UI, không deploy.
