# Bàn giao hợp đồng Backend/API W2-S1

Tài liệu này dành cho tích hợp T1A/T1C. W2-S1 tiếp tục dùng pipeline tài liệu Direct Entry hiện có; không tạo pipeline upload/đọc thứ hai.

## Portrait khi nhập hồ sơ mới

### Tạo stage

`POST /api/direct-entry/worker-portrait-stages`

- Gửi `multipart/form-data` với đúng một trường `file`.
- Chỉ nhận JPEG/PNG. Kích thước tối đa theo giới hạn upload tài liệu hiện tại.
- Máy chủ kiểm tra chữ ký/nội dung, giải mã và re-encode bằng Sharp để loại EXIF/metadata trước khi ghi vào private R2 staging.
- Máy chủ tạo stage ID, checksum và metadata; actor luôn lấy từ session rồi xác minh lại ownership/capability trong DB.
- Phản hồi gồm `stage_id`, `mime_type`, `size_bytes`, `status`. Không trả tên tệp, object key, bucket hay URL.

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

Client tích hợp phải giữ `stage_id` tới khi lưu hoàn tất và retry bằng đúng `Idempotency-Key`; nếu người dùng hủy nhập liệu, gọi DELETE. Không gửi bytes portrait trong payload batch và không gửi storage key.

### Khôi phục stage khi mất key/kết quả chưa rõ

`POST /api/direct-entry/worker-portrait-stages/recover` nhận JSON `{ "stage_id": "uuid" }`. Actor lấy từ session; DB xác minh ownership. Với stage `CLAIMED`, recovery lấy advisory lock dùng chung với batch theo actor/idempotency key rồi khóa stage trong transaction:

- Không có idempotency result đã commit: trả stage về `STAGED`, xóa claim key; caller có thể claim lại.
- Có result đã commit: giữ `CLAIMED` và trả key để client retry đúng payload/key ban đầu.
- Có record nhưng result chưa hoàn chỉnh: fail closed, không giải phóng claim.
- `ATTACHED`/`CANCELLED` là trạng thái terminal; recovery không đổi trạng thái và có thể retry xóa object.

Không hủy stage đang `CLAIMED` hoặc `ATTACHED`. Xóa object idempotent/retryable; DB state terminal được commit trước khi gọi xóa. Chưa có TTL, reaper hoặc cleanup tự động stage mồ côi.

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

Ledger local trên branch đã được fetch/reconcile trước khi thêm migration: `origin/main` và HEAD ban đầu đều là `c660ce944caabf5415b4b796eb1e71ecd9a2de25`, có 112 file migration; #112 là `20261017110000_pre_w2_s1_document_direct_context_access_guard.sql`. Migration #113 giữ nguyên; migration recovery/scope mới append-only là #114:

- #111 `20261017100000_pre_w2_s1_worker_portrait_private_projection.sql` — checksum `migrationChecksum()`: `7e19aecfb9417645a80120704be790d67a13986788a777cac30c7b62de8c66ff`
- #112 `20261017110000_pre_w2_s1_document_direct_context_access_guard.sql` — checksum `migrationChecksum()`: `82607beb7157d90e6aeea0e667715e1ae1ca73ed76e801f15d32cffe4dcba8cd`
- #113 `20261018090000_w2_s1_worker_portrait_enrollment_staging.sql` — checksum `migrationChecksum()`: `933f05ef892520661dcb8305f7b9ccf1a8e93e4ad52b17102593e104e092f326`
- #114 `20261018110000_w2_s1_portrait_stage_recovery_cccd_scope.sql` — checksum `migrationChecksum()`: `06880235a44c3dd75fca7be4bf1d6b3e0e3d1034eddb29e8fa8681471b7d9699`

Checksum dùng helper `scripts/lib/migration-validation.mjs` (SHA-256 sau chuẩn hóa newline LF), không phải hash raw bytes. #111–#113 không bị sửa. #114 khóa create/claim bằng `document_upload`, thêm stage-aware batch với advisory/stage lock và recovery idempotency có ownership, CCCD preview riêng theo `document_view` + server scope, đồng thời ràng buộc completion theo entry/document/checksum/size/MIME và lifecycle validate/scan. Migration chỉ được kiểm tra offline bằng PGlite/PostgreSQL ephemeral; không apply vào DB thật.

## Xác minh GET 404 và quyền truy cập

- Actor có quyền và scope đọc projection entry có CCCD: 200.
- Actor bị từ chối: 404 như trước.
- Preview CCCD dùng purpose riêng `cccd_preview`, yêu cầu `document_view` từ session và scope entry được DB/server xác nhận; không dùng fallback portrait và không đổi guard download chung.
- Không truy cập staging/Production/VPS; không đọc/ghi DB môi trường thật; không deploy.

## Kiểm thử và trạng thái bàn giao

Đã bổ sung/duy trì regression cho CCCD preview (capability, scope/IDOR, MIME, lifecycle, checksum, cache và không lộ storage key), GET entry có CCCD, portrait stage/failure cleanup/cancel, EXIF stripping, idempotency/OCC qua pipeline finalize, quyền/RLS và rollback khi migration #112–#114 gặp drift.

- `pnpm test:w2-s1-backend`: đạt, 76/76 trong lần chạy focused.
- `pnpm test:p1.6-i04c3-s01`: đạt, 51/51.
- `pnpm test`: chưa hoàn tất tại máy local. Theo yêu cầu, lần chạy mới nhất được dừng khi lane `test:p2.5-hf-r2` vừa bắt đầu để chuyển việc xác minh toàn chuỗi sang GitHub CI. Các lần chạy trước đã phát hiện và sửa snapshot ledger/inventory/offset bị cũ; không có regression nghiệp vụ được xác nhận từ các lỗi đó.
- `pnpm typecheck`, `pnpm lint` và `pnpm build`: đạt ở lần kiểm tra trước các cập nhật chỉ dành cho test/handoff; build dùng Next.js 16.3.8. Lint có 14 cảnh báo hiện hữu, 0 lỗi.
- 44 test scripts ngoài W2S1 chỉ đổi assertion số ledger, tail-offset của migration lịch sử, inventory/handoff migration hoặc allowlist append-only cho #114. Đã căn 74 tail-offset theo tên migration hiện hành; không nới assertion nghiệp vụ. Hai inventory assertions được cập nhật riêng theo projection của chúng: tổng function/RPC `[252, 125, 127]` và source-derived `[252, 124, 128]`.
- Checksum #111–#114 đã được tính trực tiếp từ `migrationChecksum()`; #111–#113 giữ nguyên. Migration #114 chỉ được kiểm tra offline bằng PGlite/PostgreSQL ephemeral; không apply migration lên DB thật.

Branch `codex/w2s1-api-followup`, worktree `C:\CodeApp\BI\.worktrees\w2s1-api-followup`; base và `origin/main` là `c660ce944caabf5415b4b796eb1e71ecd9a2de25`. Follow-up được commit và push để GitHub CI kiểm tra; không merge.

Không có regression tái hiện 404 riêng do CCCD; không đổi semantics 404. Client phải gọi DELETE khi hủy portrait stage; stage bị bỏ quên nếu không gọi cleanup vẫn có thể tồn tại. Chưa có TTL, reaper hay cleanup tự động cho stage mồ côi. Không truy cập staging/Production/VPS/DB môi trường thật, không apply migration, không triển khai UI, không deploy.
