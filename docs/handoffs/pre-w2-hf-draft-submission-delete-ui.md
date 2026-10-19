# PRE-W2-HF — UI "Xóa đợt nhập liệu" (submission DRAFT)

- Nhánh UI: `feature/pre-w2-hf-draft-submission-delete-ui`
- Worktree: `C:\CodeApp\BI\.worktrees\draft-submission-delete-ui`
- Base: `bd99d8b` = head PR #74 (`codex/draft-submission-delete`, backend xóa atomic submission DRAFT).
- Chỉ UI phía T1A. **Không** sửa backend/route/RPC/migration của PR #74; **không** apply migration #122; không truy cập DB thật/Production; không deploy; không merge.

## 1. Contract đã dùng (đúng backend PR #74)

`DELETE /api/direct-entry/submissions/{submissionId}`

- Header `Content-Type: application/json` + `Idempotency-Key` (1–128 ký tự, không control char).
- Body **chính xác** `{ "expected_version": <số nguyên dương> }` (lấy từ `submission.version` của card).
- `200`: `{ ok, submission_id, deleted, version, entries_deleted, cleanup_objects_queued }` — projection **strict** (đúng bộ khóa, đúng kiểu).
- Lỗi: `400` invalid · `401 UNAUTHENTICATED` · `403 SUBMISSION_DELETE_DENIED` · `404 SUBMISSION_NOT_FOUND` ·
  `409 SUBMISSION_CONFLICT` / `409 SUBMISSION_PROCESSING` · `500 SUBMISSION_DELETE_UNAVAILABLE`.
- Client **không** gửi actor/role/capability/scope; session hiện tại do server resolve.

## 2. Thay đổi theo file/symbol

### Mới

- `src/lib/direct-entry/draft-submission-delete-client.ts` — `deleteDraftSubmission`, `isDraftSubmissionDeleteKey`,
  `draftSubmissionDeleteErrorMessage`. Phân loại `deleted | conflict | rejected | retry`; fail-closed khi 2xx không
  đọc được (retry, không báo đã xóa); kiểm tra input trước khi gọi mạng.
- `src/lib/direct-entry/draft-submission-delete-client.test.mjs` — 7 test: request đúng route/body/header, projection strict,
  409 conflict/processing, 403/404/401/400, 5xx/network, input invalid không gọi mạng, thông báo lỗi.

### Sửa

- `src/components/direct-entry/direct-entry-submission-list.tsx`
  - Nút **“Xóa đợt nhập liệu”** chỉ render khi `submission.state === "DRAFT"` (`data-testid="submission-delete-draft"`),
    `disabled` + `aria-busy` khi `busySubmissionId` trùng.
  - **Radix AlertDialog** xác nhận riêng: tiêu đề “Xóa đợt nhập liệu?”, mô tả nêu rõ **đợt đang ở trạng thái bản nháp**,
    **không thể hoàn tác**, và tệp chỉ vào **hàng đợi dọn phía máy chủ** (không hứa đã xóa storage).
    Nút “Xóa bản nháp” (`data-testid="submission-delete-confirm"`) disabled khi đang chạy.
- `src/components/direct-entry/direct-entry-live.tsx`
  - `onDeleteDraftSubmission`: chặn khi đang bận; chỉ nhận DRAFT; `resolveIntentKey`/`clearIntentKey` theo
    `delete_draft_submission:{id}:{version}` (cùng version ⇒ dùng lại key, version đổi ⇒ key mới);
    gửi `expectedVersion: submission.version` + `idempotencyKey`.
  - `deleted` ⇒ bỏ đợt khỏi `submissions`, clear tham chiếu UI đang trỏ tới đợt đó (edit/manage documents/proposer),
    bỏ rows của đợt, reload danh sách từ server, hiện thông báo thành công.
  - Lỗi/conflict ⇒ **giữ nguyên đợt**, hiện thông báo dễ hiểu (`role="alert"`); `retry` giữ nguyên intent key.
  - Thông báo riêng `data-testid="submission-delete-notice"` (không lẫn lỗi tải danh sách).
- `src/components/direct-entry/direct-entry-submission-list.test.mjs` — harness render thật component:
  thêm `onDeleteDraft`, 5 test hành vi (chỉ DRAFT có nút; mở confirm không gọi API; confirm gọi đúng 1 lần;
  busy ⇒ disabled/aria-busy; copy xác nhận + wiring live `expected_version`/`Idempotency-Key`, chỉ bỏ đợt trong nhánh `deleted`).
- `package.json` — thêm test client vào lane `test:p1.6-w04-s04c-s03a`.

## 3. Hành vi UI

- Chỉ card **DRAFT** có nút xóa; `SUBMITTED`/`REVIEW` không có (không tự suy quyền từ UI — server vẫn là authority).
- Bấm nút ⇒ hộp thoại xác nhận; **Hủy** không gọi API; xác nhận mới gửi request.
- Đang chạy ⇒ nút xóa và nút xác nhận bị khóa (tránh gửi lặp).
- Thành công ⇒ đợt biến khỏi danh sách, số đợt/badge của panel compact cập nhật theo `submissions`, danh sách tải lại từ server.
- `409`/`403`/`404`/`401`/mạng/`5xx` ⇒ báo rõ và **không** tự loại đợt khỏi UI.
- Accessibility theo pattern app: Radix AlertDialog (Title/Description/Cancel/Action), không focus trap thủ công,
  `aria-busy`, thông báo `role="alert"/"status"`.

## 4. Test và gate

| Gate | Kết quả |
| --- | --- |
| `pnpm test:p1.6-w04-s04c-s03a` | **33/33 PASS** (gồm 7 test client mới + 5 test hành vi list) |
| `pnpm test:p1.6-i04c3-r2` / `r3a` (đọc `direct-entry-live.tsx`) | 68 / **183** PASS |
| `pnpm test:p1.6-i04c3-r3b` / `r4-s02` | 26 / 14 PASS |
| `pnpm test:p1.6-w04-s04c-s02c` | 25 PASS |
| `pnpm test:p3-1-hf-change-request-panel` | 59 PASS |
| `pnpm typecheck` | PASS |
| `pnpm lint` | **0 error**; 12 warning đều ở file có sẵn, không file nào của thay đổi này |
| `pnpm build` | PASS (exit 0, `Compiled successfully`) |
| `git diff --check` | sạch |

## 5. Giới hạn còn lại

- **B1 — Đây là xóa mềm/tombstone.** Server giữ audit/revision và có thể giữ dữ liệu lịch sử; UI không tuyên bố ngược lại.
- **B2 — Không tuyên bố object đã bị xóa khỏi storage.** `cleanup_objects_queued` chỉ là số mục trong hàng đợi;
  reaper/scheduler Production **chưa được cấu hình** (backend ghi rõ). UI cũng nói rõ điều này trong hộp thoại.
- **B3 — Chưa UAT.** Chưa đăng nhập/chạy với tài khoản thật; chưa audit a11y (screen reader/contrast) và chưa thử mobile thật.
- **B4 — Đợt `project_scoped`:** UI vẫn hiện nút cho DRAFT (danh sách chỉ chứa đợt của actor); nếu server từ chối quyền,
  UI hiện `SUBMISSION_DELETE_DENIED` và giữ nguyên đợt. Cần T0 xác nhận có nên ẩn trước theo `project_scoped` hay không.
- **B5 — Không có nút xóa trong composer draft cũ (`POST /batches`)** — ngoài phạm vi, backend không đổi.

## 6. Xác nhận

- Không sửa backend/API/RPC/SQL/migration; không apply migration #122; không truy cập/chỉnh sửa DB (đặc biệt Production).
- Không deploy, không merge vào `main`; commit/push riêng trên nhánh UI.
