# PRE-W2-HF: Xóa submission DRAFT

## Phạm vi và trạng thái

- Branch: `codex/draft-submission-delete`, tạo trên `origin/main@865757397c404e11e6c44207c071a89941b4bbad`.
- Chỉ hỗ trợ xóa một submission `DRAFT` thuộc actor hiện tại; không xóa tuần tự các entry ở client.
- Đây là **xóa mềm/tombstone**, không phải hard-delete hay bảo đảm xóa toàn bộ dữ liệu lịch sử.
- Migration append-only mới: `20261019130000_pre_w2_hf_draft_submission_delete.sql` (slot #122).
- Checksum SHA-256 qua `migrationChecksum()`: `2a4d37d591d8aa88d7ab00a9ad0696723e49a4577f430f237b86a619f5d2f15c`.
- Migration chỉ được kiểm tra offline/PGlite; chưa apply vào bất kỳ DB thật nào.

## Endpoint

`DELETE /api/direct-entry/submissions/{submissionId}`

Request:

- `Content-Type: application/json`
- `Idempotency-Key`: 1–128 ký tự, không chứa control character.
- Body chính xác: `{ "expected_version": <số nguyên dương> }`.
- Không nhận actor, role, capability, scope hoặc authority từ client.
- Origin/CSRF guard và `DIRECT_ENTRY_API_ENABLED` được giữ nguyên; endpoint gated sẽ trả `404`.

Response `200`:

```json
{
  "ok": true,
  "submission_id": "<uuid>",
  "deleted": true,
  "version": 4,
  "entries_deleted": 2,
  "cleanup_objects_queued": 3
}
```

`cleanup_objects_queued` là số mục còn trong hàng đợi, **không** chứng nhận object đã bị xóa khỏi storage.
Response là `private, no-store`.

Lỗi được trả theo mã đã sanitize: `400` cho request/key không hợp lệ,
`401 UNAUTHENTICATED`, `403 SUBMISSION_DELETE_DENIED`,
`404 SUBMISSION_NOT_FOUND`, `409 SUBMISSION_CONFLICT` hoặc
`409 SUBMISSION_PROCESSING`, và `500 SUBMISSION_DELETE_UNAVAILABLE`.

## Transaction, quyền và tính nguyên tử

- Actor được resolve từ session server-side. RPC xác nhận `submission_create`, creator, đúng một own-scope grant còn hiệu lực và quyền own-scope cho từng entry.
- RPC khóa các entry đang hoạt động rồi khóa submission, kiểm tra lại trạng thái/version và chuyển trạng thái nguyên tử từ `DRAFT` sang `DELETED`. Race với submit được tuần tự hóa trên aggregate; state/version đã đổi thì transaction bị từ chối.
- Idempotency được lưu bằng pattern hiện hữu: cùng actor/key/payload replay kết quả; dùng lại key với payload khác conflict.
- `CLAIMED` document/portrait stage làm delete trả conflict; không tự thu hồi stage đang được xử lý.
- Entry được tombstone (`deleted_at`, tăng version), submission được đánh dấu `DELETED`; revision và audit được giữ lại. Không cascade sang submission khác hoặc entry đã được chia sẻ ngoài submission.

## Dữ liệu con và cleanup storage

- `ATTACHED` portrait stages thuộc submission được enqueue theo stage ID (`PORTRAIT_STAGE`).
- Tài liệu `DOCUMENT_STAGED`/`DOCUMENT_FINAL` được enqueue bằng `document_id` và storage key chỉ khi hồ sơ không được tham chiếu bởi entry ở submission khác.
- Hàng cleanup có lease/token và số lần thử. Reaper claim theo batch; lỗi xóa object giữ mục pending để retry. Xóa object hiện idempotent đối với object không còn tồn tại.
- Runner tái sử dụng `worker-portrait-stage-reaper` qua `pnpm exec node scripts/reap-w2-s1-portrait-stages.mjs`; cần `W2S1_PORTRAIT_STAGE_REAPER_ENABLED=true`, credentials service-role, R2 và scheduler/operator định kỳ. Script hiện chỉ chấp nhận Supabase ref `oyykqfxkyqhxgrfntokl` cùng Preview bucket `DOCUMENT_BUCKETS.preview`.
- Scheduler chưa được cấu hình/deploy trong thay đổi này. Runner hiện **không hỗ trợ Production DB/bucket**; không bật rộng quyền môi trường trong PR. Nếu feature được bật ở Production, T0 cần chốt runner/scheduler Production riêng trước khi tuyên bố object cleanup được vận hành ở đó.
- Audit/revision và các row tombstone vẫn được giữ. Việc xóa storage là bất đồng bộ; retry chưa hoàn tất thì object vẫn tồn tại.

## Kiểm chứng và giới hạn

- Test offline/PGlite bao phủ ownership/scope, state/version conflict, idempotent retry, race delete–submit, rollback nguyên tử, audit/revision và cleanup retry.
- Test PostgreSQL concurrency mới được đăng ký vào lane CI và đã chạy cục bộ thành công.
- Không truy cập, query hoặc thay đổi Production (`kiamyvfymxdattohfwmt`), staging, VPS hay DB từ xa; không deploy.
- Migration cần T0 xử lý sau review/CI trên DB Vercel được phép `oyykqfxkyqhxgrfntokl`; chưa được apply.
