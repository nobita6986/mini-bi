# W2S1 — UI staging ảnh hồ sơ (nhập NLĐ mới) + CCCD preview

- Nhánh: `feature/w2s1-portrait-staging-ui`
- Worktree: `C:\CodeApp\BI\.worktrees\w2s1-portrait-staging-ui`
- Base: `1467c6d4f8491a86019f8e8ad45322b4a852ee54` = head PR #60 (`codex/w2s1-api-followup`, backend W2S1 staging + CCCD preview đã review)
- **Merge commit `732cdf2`**: merge `feature/w2s1-worker-portrait-ui` @ `0db7e71` (UI chi tiết NLĐ + panel ảnh hồ sơ + policy khóa thay ảnh) vào nhánh này — theo quyết định của T0. Không cherry-pick, không rebase, không sửa PR #60.
- Phạm vi: UI + client boundary + test/wiring. Không sửa backend/API/RPC/SQL/migration/cấu hình auth, không đổi capability/authorization/scope.
- Không apply migration vào DB thật, không truy cập staging/Production/VPS, không deploy, chưa push, chưa merge.

## 0. Kiểm tra trước/sau merge

- Trước merge: primary `main @ c660ce9` (không đụng); nhánh UI cũ `0db7e71` **worktree sạch**; nhánh mới `1467c6d` (WIP được `git stash` để worktree sạch đúng yêu cầu, pop lại sau merge).
- Conflict khi merge: **chỉ `package.json`** (mục `scripts`). Cách resolve: giữ lane `test:w2-s1-backend` **của PR #60** (12 file, gồm `full-profile-api`, `worker-portrait-stage-api`, `w2-s1-stage-recovery-concurrency`, migration 112–114) và **thêm** lane `test:w2-s1-worker-portrait-ui`. Chuỗi `test` canonical đã tự gộp và chứa **cả hai** lane. Đây là thay đổi cơ học ở danh sách script — **không đổi hành vi/logic/contract**.
- Sau merge: `git diff --stat 0db7e71 HEAD` trên 4 file policy/UI (`worker-detail-projection.ts`, `worker-portrait-panel.tsx`, `worker-detail-dialog.tsx`, `worker-operations.tsx`) = **rỗng** ⇒ policy khóa thay ảnh và UI chi tiết NLĐ **giữ nguyên byte-for-byte** như đã review.
- Không còn marker conflict; `git diff --check` sạch.

## 1. Contract đã dùng (không tự tạo endpoint/API khác)

| Việc | Endpoint / shape |
| --- | --- |
| Tạo stage ảnh | `POST /api/direct-entry/worker-portrait-stages`, `multipart/form-data` **đúng một** field `file`; JPEG/PNG ≤ giới hạn tài liệu ⇒ `201 {ok, stage_id, mime_type, size_bytes, status:"STAGED"}` |
| Hủy stage | `DELETE` cùng route, JSON **chỉ** `{ stage_id }` ⇒ `204` |
| Recovery | `POST /api/direct-entry/worker-portrait-stages/recover`, JSON `{ stage_id }` ⇒ `200 {ok, stage_id, status, idempotency_key}` |
| Gắn ảnh khi lưu | `POST /api/direct-entry/batches/full-profile`, mỗi row `portrait_stage_id`; server claim theo actor + `Idempotency-Key` của batch rồi reserve/copy/finalize sau khi RPC tạo draft thành công |
| Preview CCCD | `GET /api/direct-entry/entries/{entryId}/documents/{documentId}/cccd-preview` (`document_view` + purpose `cccd_preview`, không fallback `entry_privileged_edit`) |

Client **không** gửi actor/auth subject/app user/capability/scope/team, **không** gửi bytes/base64 ảnh trong payload batch, **không** gửi storage key/URL.

## 2. Thay đổi theo file/symbol

### Mới

- `src/lib/direct-entry/worker-portrait-stage-client.ts` — client boundary cho staging:
  `stageWorkerPortrait`, `cancelWorkerPortraitStage`, `recoverWorkerPortraitStage` (fetch tiêm vào) + `projectPortraitStage`, `projectPortraitStageRecovery`, `classifyPortraitStageResponse`, `classifyPortraitStageCancelResponse`, `portraitPromotionState`, thông báo lỗi. Dùng lại `checkWorkerPortraitFile` của `worker-detail-projection.ts` (một nguồn duy nhất cho kiểm tra tệp).
- `src/lib/direct-entry/worker-portrait-stage-client.test.mjs` — 11 test thuần.
- `src/components/direct-entry/worker-portrait-staging-ui.test.mjs` — 8 test nối UI ↔ builder.

### Sửa

- `src/lib/direct-entry/full-profile-batch.ts` — `FullProfileRequestRow.portrait_stage_id?`; `buildFullProfileRow(row, portraitStageId?)` chỉ thêm field khi có ảnh; `buildFullProfileRequestBody(rows, portraitStageIds?)` + bản server-generated; `fullProfileRequiredCapabilities` thêm `document_upload` khi có ảnh; `FullProfileSubmitState.portraitStageIds` để CTA chặn đúng.
- `src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx` — mỗi dòng có slot **Ảnh hồ sơ**: chọn ảnh ⇒ stage; trạng thái staging/đã-stage/lỗi + thông báo riêng; nút **Hủy ảnh** (DELETE); `stagedStageIds` đưa vào payload khi lưu; sau `retry`/`conflict`/`rejected` gọi **recovery** để biết trạng thái thật; đóng hộp thoại ⇒ DELETE mọi stage chưa gắn; `saved` ⇒ xóa state stage (server đã ATTACHED).
- `src/lib/direct-entry/worker-detail-projection.ts` — thêm `workerCccdPreviewUrl`, `workerCccdPreviewable` (không đổi hàm/hành vi cũ).
- `src/components/direct-entry/worker-detail-dialog.tsx` — mục **Tình trạng từng loại hồ sơ** chuyển thành danh sách có khung ảnh CCCD (`CccdPreview`) dùng route `cccd-preview`; CCCD không sẵn sàng/ngoài phạm vi ⇒ hiện "không xem được" + nút thử lại; cập nhật ghi chú (hợp đồng lao động vẫn dùng luồng quản lý tài liệu hiện có). Portrait preview giữ nguyên, **không** dùng cho CCCD.
- `src/components/direct-entry/worker-detail-dialog.test.mjs` — cập nhật assertion CCCD preview.
- `package.json` — lane `test:w2-s1-worker-portrait-ui` thêm 2 test mới (resolve merge như mục 0).

## 3. Trạng thái UI

- **Staging:** chọn ảnh theo từng dòng → ảnh nằm ở bản nháp; hiện "Ảnh đang ở bản nháp; máy chủ sẽ gắn vào hồ sơ khi lưu thành công." Chưa lưu thì ảnh chưa thuộc hồ sơ.
- **Hủy stage:** nút Hủy ảnh khi stage còn `STAGED`; stage `CLAIMED`/`ATTACHED` bị server từ chối (409) ⇒ UI **không** báo đã hủy mà trả về trạng thái thật + thông báo.
- **Lỗi/retry:** tệp rỗng/sai MIME/vượt dung lượng bị chặn **tại client trước khi gọi mạng**; lỗi mạng/5xx/2xx không đọc được ⇒ "thử lại", không báo thành công.
- **Recovery sau kết quả không xác định:** gọi `/recover` cho từng stage rồi suy trạng thái:
  - `CLAIMED` (có `idempotency_key`) ⇒ **hồ sơ đã lưu nhưng ảnh chưa hoàn tất** — "Bấm Thử lại với cùng yêu cầu…"; key của batch **được giữ nguyên**;
  - `STAGED` ⇒ lần lưu trước chưa commit, ảnh dùng lại được;
  - `ATTACHED`/`CANCELLED` ⇒ dọn state tương ứng.
- **CCCD preview:** chỉ hiện khung ảnh khi tài liệu READY + VALIDATED + CLEAN/NOT_REQUIRED và là JPEG/PNG; ảnh ngoài phạm vi hoặc chưa sẵn sàng ⇒ hiện trạng thái "không xem được" (không tự suy quyền, không tự mở endpoint khác).
- **Policy khóa thay ảnh hồ sơ** (panel portrait) giữ nguyên: `current !== null` ⇒ không có đường upload thay thế; `QUEUED`/`UPLOADING`/`QUARANTINED`/`SCANNING` ⇒ `IN_FLIGHT`.
- Guard `/download` chung, capability/scope hiện hành **không đổi**.

## 4. Test và gate

| Gate | Kết quả |
| --- | --- |
| `pnpm test:w2-s1-worker-portrait-ui` (4 file) | **53/53 PASS** |
| `pnpm test:w2-s1-backend` (backend PR #60, không đổi) | 76 PASS / 0 fail |
| `pnpm test:p1.6-i04c3-r3b` (`full-profile-batch`) | 25 PASS / 0 fail |
| `pnpm test:p1.6-i04c3-r4-s02` (`banking-metadata`, đọc dialog) | 14 PASS / 0 fail |
| `pnpm test:p1.6-i04c3-s01` (full-profile contract/api/repo/route) | 51 PASS / 0 fail |
| `pnpm test:p2.5-w06` / `test:p3-1-hf-change-request-panel` (đọc `worker-operations.tsx`) | 63 / 58 PASS |
| `pnpm typecheck` | PASS |
| `pnpm lint` | 0 error; 14 warning đều ở file có sẵn, **không** file nào của task này |
| `pnpm build` | PASS (exit 0, `Compiled successfully`) |
| `pnpm docs:check` | PASS 6/6 |
| `node scripts/apply-migrations.mjs --offline` | 114 migration VALID, **không truy cập DB** |
| `git diff --check` | sạch |
| `pnpm secrets:check` | **KHÔNG CHẠY ĐƯỢC** — blocker B4 (thiếu `C:\CodeApp\supabase-bi.txt`, lỗi môi trường) |

Coverage chính: tệp không hợp lệ **không** gọi mạng; multipart đúng một field `file`; không có field authority; DELETE chỉ `{stage_id}`; 404/409 ⇒ "không hủy được"; recovery fail-closed (`CLAIMED` phải có key, khác `CLAIMED` không được có key); `CLAIMED` ⇒ trạng thái "đã lưu, ảnh chưa xong"; row chỉ mang `portrait_stage_id` khi có ảnh; CTA đòi `document_upload` khi có ảnh; dialog hủy stage khi đóng.

## 5. Blocker còn lại

- **B1 — Không có TTL/reaper/cleanup tự động cho stage mồ côi.** Contract ghi rõ; nếu người dùng đóng trình duyệt giữa lúc tạo stage, stage có thể còn lại. UI đã DELETE khi đóng hộp thoại, nhưng không phủ được trường hợp tắt tab.
- **B2 — Tạo stage không có idempotency key.** Nếu request tạo stage lỗi mạng **sau khi** server đã ghi, client không biết `stage_id` để hủy ⇒ có thể sinh stage mồ côi (liên quan B1). UI hiện báo "chưa xác định" và cho thử lại (tạo stage mới); T0/T1B nên chốt có cần key cho bước create hay không.
- **B3 — Preview hợp đồng lao động chưa có.** `cccd-preview` chỉ nhận `CCCD_FRONT`/`CCCD_BACK`; hợp đồng vẫn dùng luồng quản lý tài liệu hiện có.
- **B4 — `pnpm secrets:check` không chạy được** (thiếu file cấu hình ngoài repo). Cần chạy lại ở môi trường có file; không phải phát hiện secret trong thay đổi này.
- **B5 — Chưa UAT.** Chưa đăng nhập/mở hồ sơ thật; nhánh lỗi 403/404 của entry detail và CCCD preview mới có coverage ở mức code. Chưa audit a11y (screen reader/contrast/tab order) và chưa thử mobile thật.
- **B6 — Staging chỉ nối vào luồng full-profile (dán hồ sơ).** Các đường nhập khác (nếu có) chưa gắn stage; cần T0 xác nhận luồng nào là "nhập NLĐ mới" chính thức cần ảnh.

## 6. Xác nhận

- Không sửa backend/API/RPC/SQL/migration, không đổi capability/authorization/scope, không tạo endpoint mới.
- Không sửa master plan, không sửa `.codegraph`, không sửa nhánh/PR #60.
- Không apply migration vào DB thật, không truy cập staging/Production/VPS, không deploy.
- Chưa push, chưa merge — chờ T0 rà soát tiếp.
