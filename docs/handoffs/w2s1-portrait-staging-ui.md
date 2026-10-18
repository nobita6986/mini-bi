# W2S1 — UI staging ảnh hồ sơ (nhập NLĐ mới) + CCCD preview

- Nhánh: `feature/w2s1-portrait-staging-ui`
- Worktree: `C:\CodeApp\BI\.worktrees\w2s1-portrait-staging-ui`
- Base: `1467c6d4f8491a86019f8e8ad45322b4a852ee54` = head PR #60 (`codex/w2s1-api-followup`, backend W2S1 staging + CCCD preview đã review)
- **Merge commit `732cdf2`**: merge `feature/w2s1-worker-portrait-ui` @ `0db7e71` (UI chi tiết NLĐ + panel ảnh hồ sơ + policy khóa thay ảnh) vào nhánh này — theo quyết định của T0. Không cherry-pick, không rebase, không sửa PR #60.
- Phạm vi: UI + client boundary + test/wiring. Không sửa backend/API/RPC/SQL/migration/cấu hình auth, không đổi capability/authorization/scope.
- Không apply migration vào DB thật, không truy cập staging/Production/VPS, không deploy, chưa push, chưa merge.
- **Sửa lỗi vòng đời stage (commit nối tiếp):** stage trước đây được gắn theo `sourceRow` (vị trí dòng) nên khi
  sửa/thay/sắp xếp lại bảng, ảnh cũ có thể bị gửi cho NLĐ khác. Nay stage được **ràng buộc bằng binding nội dung dòng**
  và mọi **kết quả stage về muộn** (sau khi dòng đổi hoặc hộp thoại đóng) đều bị vô hiệu hóa + dọn an toàn.
  **Policy khóa ảnh hồ sơ không thay đổi.**
- **Sửa tiếp (commit nối tiếp mới nhất):** vòng đời stage chuyển thành **reducer thuần**
  (`reducePortraitStageLifecycle`) để test được **hành vi**. Hai lỗi được sửa: (a) trước đây ID bị xóa khỏi state
  **ngay cả khi DELETE thất bại** ⇒ mất ID, không thể dọn lại; (b) đóng hộp thoại xóa sạch state **trước khi** hủy xong
  ⇒ mở lại có thể tái sử dụng stage đã gửi DELETE. Nay **chỉ xóa ID khi đã hủy được hoặc đã xác định trạng thái cuối**;
  mọi trường hợp còn lại giữ ID ở trạng thái `stale` để thử dọn lại và **không bao giờ** được gửi vào batch.
- **Sửa race response cũ ghi đè upload mới (commit nối tiếp này):** mỗi lần stage có **generation/request ID duy nhất**
  (`stage-start`/`stage-result` mang `requestId`); `stage-result` **chỉ** cập nhật slot đang ở `staging` **đúng `requestId`**
  — không còn so `sourceRow` + row binding (sau khi dán lại y hệt, binding trùng lại nên cách cũ để response A ghi đè B).
  Response cũ trả về một stage **đã tạo trên server** được đưa vào **danh sách orphan riêng** để hủy, **không** ghi vào slot
  và **không** làm mất stage mới.

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
  **Ràng buộc vòng đời:** `portraitRowBinding` (binding = `sourceRow` + băm nội dung dòng, không giữ bản sao PII),
  `selectBindablePortraitStages` (chỉ dòng còn khớp binding mới được gửi `portrait_stage_id`),
  `selectStalePortraitStages` (stage đã tạo nhưng không còn khớp ⇒ phải hủy/dọn),
  `reducePortraitStageLifecycle` (reducer thuần cho vòng đời stage: `stage-start` / `stage-result` / `invalidate` /
  `cancel-result` / `orphan-cancel-result`), `INVALIDATED_PORTRAIT_BINDING` (gán khi vô hiệu hóa để stage cũ không bao giờ khớp lại),
  `selectOrphanPortraitStages` + `PortraitStageOrphan` (danh sách stage server đã tạo nhưng response về muộn, cần hủy),
  `EMPTY_PORTRAIT_STAGE_LIFECYCLE`.
- `src/lib/direct-entry/worker-portrait-stage-client.test.mjs` — test thuần + **test hành vi reducer** (không mất ID khi DELETE lỗi,
  xác nhận hủy mới xóa ID, đóng hộp thoại giữ ID nhưng vô hiệu hóa binding, response muộn vào orphan, **race A→B cả hai thứ tự**).
  (`isStalePortraitStageRequest` của bản trước đã được **thay bằng reducer** — reducer còn giữ được ID để dọn.)
- `src/components/direct-entry/worker-portrait-staging-ui.test.mjs` — test nối UI ↔ builder + **test hành vi ở mức payload thật**
  (dùng `reducePortraitStageLifecycle` → `selectBindablePortraitStages` → `buildFullProfileRequestBody`, không chỉ so chuỗi source),
  gồm race A→B (payload **chỉ** chứa stage B) và thứ tự response ngược lại.

### Sửa

- `src/lib/direct-entry/full-profile-batch.ts` — `FullProfileRequestRow.portrait_stage_id?`; `buildFullProfileRow(row, portraitStageId?)` chỉ thêm field khi có ảnh; `buildFullProfileRequestBody(rows, portraitStageIds?)` + bản server-generated; `fullProfileRequiredCapabilities` thêm `document_upload` khi có ảnh; `FullProfileSubmitState.portraitStageIds` để CTA chặn đúng.
- `src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx` — mỗi dòng có slot **Ảnh hồ sơ**: chọn ảnh ⇒ stage; trạng thái staging/đã-stage/lỗi + thông báo riêng; nút **Hủy ảnh** (DELETE); `stagedStageIds` đưa vào payload khi lưu; sau `retry`/`conflict`/`rejected` gọi **recovery** để biết trạng thái thật; đóng hộp thoại ⇒ DELETE mọi stage chưa gắn; `saved` ⇒ xóa state stage (server đã ATTACHED).
- `src/lib/direct-entry/worker-detail-projection.ts` — thêm `workerCccdPreviewUrl`, `workerCccdPreviewable` (không đổi hàm/hành vi cũ).
- `src/components/direct-entry/worker-detail-dialog.tsx` — mục **Tình trạng từng loại hồ sơ** chuyển thành danh sách có khung ảnh CCCD (`CccdPreview`) dùng route `cccd-preview`; CCCD không sẵn sàng/ngoài phạm vi ⇒ hiện "không xem được" + nút thử lại; cập nhật ghi chú (hợp đồng lao động vẫn dùng luồng quản lý tài liệu hiện có). Portrait preview giữ nguyên, **không** dùng cho CCCD.
- `src/components/direct-entry/worker-detail-dialog.test.mjs` — cập nhật assertion CCCD preview.
- `package.json` — lane `test:w2-s1-worker-portrait-ui` thêm 2 test mới (resolve merge như mục 0).

## 3. Trạng thái UI

- **Staging:** chọn ảnh theo từng dòng → ảnh nằm ở bản nháp; hiện "Ảnh đang ở bản nháp; máy chủ sẽ gắn vào hồ sơ khi lưu thành công." Chưa lưu thì ảnh chưa thuộc hồ sơ.
- **Ràng buộc ảnh ↔ NLĐ:** mỗi slot giữ `binding` = `sourceRow` + băm nội dung dòng (mã NLĐ, họ tên, ngày bắt đầu,
  dự án, người tuyển, loại hình LĐ, CCCD, ngày sinh, điện thoại). Khi gửi batch, **chỉ** dòng còn khớp binding mới mang
  `portrait_stage_id`; dòng bị sửa/thay bằng NLĐ khác hoặc bị sắp xếp lại ⇒ binding lệch ⇒ ảnh cũ **không** được gửi
  cho hồ sơ mới và bị hủy ngay (không để mồ côi).
- **Request đang chạy trả về muộn:** mỗi lần stage cấp một **`requestId`** duy nhất; `stage-result` chỉ áp dụng khi slot
  đang `staging` và **đúng `requestId`**. Mỗi lần đổi dữ liệu / đóng hộp thoại, reducer `invalidate` **vô hiệu hóa binding
  ngay** (chuyển mọi stage đã tạo sang `stale`, **giữ nguyên `stage_id`**) và tăng epoch. Response cũ về sau **không** ghi
  vào slot hiện tại; nếu server **đã tạo** stage, nó vào **danh sách orphan** để hủy — **không mất ID** và **không ghi đè
  upload mới**.
- **Xóa ID chỉ khi chắc chắn:** `cancel-result` chỉ xóa slot khi hủy **đã xác nhận** (`204` ⇒ `cancelled`) hoặc đã xác định
  **trạng thái cuối** (`404` không thuộc phạm vi actor, `409` đang CLAIMED/ATTACHED). Lỗi mạng/5xx ⇒ giữ ID ở `stale`,
  hiện nút **"Thử dọn ảnh cũ chưa hủy được"** (`profile-portrait-cleanup-retry`) và nút "Dọn lại ảnh cũ" theo từng dòng.
- **Đóng rồi mở lại:** state không bị xóa trước khi hủy xong; stage còn lại ở `stale` với binding
  `INVALIDATED_PORTRAIT_BINDING` nên **dù dán lại đúng dữ liệu cũ cũng không tái sử dụng** stage đã gửi DELETE
  (payload batch không có `portrait_stage_id` cho stage đó).
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
| `pnpm test:w2-s1-worker-portrait-ui` (4 file) | **70/70 PASS** |
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

Hai regression bắt buộc cho lỗi vòng đời:

- **A→B:** stage ảnh A gắn cho dòng 1; sau khi đổi nội dung dòng 1 thành NLĐ B, `selectBindablePortraitStages` trả **rỗng**
  (batch **không** chứa stage A cho B) và `selectStalePortraitStages` trả đúng stage A để **hủy/dọn**. Bao gồm cả trường hợp
  **sắp xếp lại** (nội dung A chuyển sang dòng khác) và xóa hết dữ liệu.
- **Về muộn:** kết quả stage về sau khi dòng đổi / hộp thoại đóng **không** ghi vào slot hiện tại; nếu server đã tạo stage
  thì nó được giữ ở `stale` để dọn — **không làm mất ID**.
- Binding thay đổi khi bất kỳ trường định danh nào đổi (họ tên, CCCD, mã NLĐ, dự án, người tuyển, ngày bắt đầu, ngày sinh,
  điện thoại) **hoặc** khi vị trí dòng đổi; binding không chứa PII đọc được.

**Test HÀNH VI (không chỉ chuỗi source/helper rời):** các test dựng chuỗi action thật trên reducer rồi cho state đi qua
`selectBindablePortraitStages` → `buildFullProfileRequestBody` (builder payload thật) và khẳng định trên **payload gửi lên**:

1. đối chứng — stage còn khớp dòng thì payload có `portrait_stage_id`;
2. A→B — đổi dòng thì payload **không** có `portrait_stage_id` của stage A;
3. **DELETE lỗi mạng/5xx** — ID **không** mất, stage **không** vào payload, bấm dọn lại và hủy xác nhận thì mới sạch;
4. **đóng–mở lại** — DELETE thành công ⇒ sạch; DELETE lỗi ⇒ còn ID nhưng **dán lại đúng dữ liệu cũ vẫn không** đưa stage đó vào payload;
5. kết quả về muộn (cả `staged` lẫn lỗi) không gắn lại vào dòng/dữ liệu khác — stage đã tạo nằm trong **danh sách orphan** để hủy;
6. **RACE:** upload A đang chạy → invalidate → **dán lại cùng dòng** (binding trùng lại) → upload B → response A về sau ⇒ A **không**
   bind, **không** ghi đè B, A vào cleanup; payload **chỉ** chứa `stage_id` của B. Thử **cả thứ tự ngược** (B về trước, A về sau) ⇒
   payload vẫn chỉ có B, A vào cleanup.

## 5. Blocker còn lại

- **B1 — Không có TTL/reaper/cleanup tự động cho stage mồ côi (phía server).** Contract ghi rõ. UI đã dọn trong các nhánh
  kiểm soát được: hủy khi đóng hộp thoại, hủy khi dòng đổi (binding lệch), hủy khi kết quả stage về muộn, và nút
  "Thử dọn ảnh cũ chưa hủy được" khi DELETE lỗi (ID được giữ lại để thử tiếp). Trường hợp còn hở: người dùng
  **tắt tab/trình duyệt** trong khi request stage đang chạy — không có cơ hội gọi DELETE.
- **B2 — Tạo stage không có idempotency key (phía backend).** Nếu request create lỗi mạng **sau khi** server đã ghi, client
  không biết `stage_id` để hủy ⇒ có thể sinh stage mồ côi (liên quan B1). UI báo "chưa xác định" và cho thử lại (tạo stage mới).
  T0/T1B nên chốt có cần key cho bước create hay không.
- **B3 — Preview hợp đồng lao động chưa có.** `cccd-preview` chỉ nhận `CCCD_FRONT`/`CCCD_BACK`; hợp đồng vẫn dùng luồng quản lý tài liệu hiện có.
- **B4 — `pnpm secrets:check` không chạy được** (thiếu file cấu hình ngoài repo). Cần chạy lại ở môi trường có file; không phải phát hiện secret trong thay đổi này.
- **B5 — Chưa UAT.** Chưa đăng nhập/mở hồ sơ thật; nhánh lỗi 403/404 của entry detail và CCCD preview mới có coverage ở mức code. Chưa audit a11y (screen reader/contrast/tab order) và chưa thử mobile thật.
- **B6 — Staging chỉ nối vào luồng full-profile (dán hồ sơ).** Các đường nhập khác (nếu có) chưa gắn stage; cần T0 xác nhận luồng nào là "nhập NLĐ mới" chính thức cần ảnh.

## 6. Xác nhận

- Không sửa backend/API/RPC/SQL/migration, không đổi capability/authorization/scope, không tạo endpoint mới.
- Không sửa master plan, không sửa `.codegraph`, không sửa nhánh/PR #60.
- Không apply migration vào DB thật, không truy cập staging/Production/VPS, không deploy.
- Chưa push, chưa merge — chờ T0 rà soát tiếp.
