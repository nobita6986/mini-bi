# Pre-W2-HF-UI-LABELS — Thống nhất nhãn trạng thái làm việc và giới tính trên UI

> Status: `PRE_W2_HF_UI_LABELS_COMPLETE_AWAITING_T0_REVIEW`
> Kind: presentation-only UI change. No migration, no DB apply, no permission/business-rule change, no deploy VPS/Vercel.
> Base branch: `codex/pre-w2-hf-d3-s0-account-personnel-survey`.
> Owner UAT is pending; this handoff does not merge.

## 1. Mục tiêu & phạm vi

- Trạng thái làm việc: `ON` → "Đang làm"; `OFF` → "Đã nghỉ"; `UNCONFIRMED` → "Đang chờ việc".
- Giới tính: `MALE` → "Nam"; `FEMALE` → "Nữ"; `OTHER` → "Khác".
- Không để mã enum (`ON/OFF/UNCONFIRMED/MALE/FEMALE/OTHER`) xuất hiện như chữ hiển thị trên UI.
- Ô trạng thái của lưới nhập liệu chỉ hiện nhãn; bỏ phần nối "· hiệu lực YYYY-MM-DD". Ngày hiệu lực vẫn nằm nguyên trong dữ liệu lưu (`row.profile.employment.effective_date`) và các bề mặt nghiệp vụ khác.
- Dropdown giới tính trên lưới nhập liệu tiếp tục chỉ cho chọn "Nam"/"Nữ"; dữ liệu `OTHER` cũ chỉ được hiển thị "Khác" và bị khoá không cho chọn lại.

## 2. Nguyên tắc an toàn đã giữ

- Chỉ đổi presentation. Enum, API payload, validation biên (trừ một alias bổ sung, xem §6), DB và dữ liệu đã lưu giữ nguyên.
- Không migration, không đổi quyền, không sửa nghiệp vụ.
- Nhãn tập trung một nguồn duy nhất, không nhân bản bảng nhãn.

## 3. Nguồn nhãn duy nhất (mới)

`src/lib/direct-entry/display-labels.ts` (pure, không I/O):

- `WORK_STATUS_UI_LABELS` + `workStatusUiLabel(status)` — `ON`→"Đang làm", `OFF`→"Đã nghỉ", `UNCONFIRMED`→"Đang chờ việc"; null/rỗng/không nhận diện → "Chưa có trạng thái".
- `GENDER_UI_LABELS` + `genderUiLabel(gender)` — `MALE`→"Nam", `FEMALE`→"Nữ", `OTHER`→"Khác"; ô rỗng giữ rỗng; giá trị không nhận diện → "—" (không bao giờ trả mã enum).

Các bảng nhãn cũ nay trỏ về nguồn này (không còn trùng lặp):

- `worker-operations-model.ts`: `WORKER_STATUS_LABELS` / `workerStatusLabel` (worker list, filter, proposal drawer).
- `change-request-read-projection.ts`: `WORK_STATUS_LABELS` (proposer + reviewer); thêm ánh xạ `gender` trong `workerDetailsRows` để bảng so sánh trước/sau hiện "Nam/Nữ/Khác".
- `duplicate-cccd-report-contract.ts` / `submission-duplicate-cccd-contract.ts`: `EMPLOYMENT_STATUS_LABELS` / `employmentStatusLabel` (báo cáo CCCD trùng + cảnh báo CCCD trùng khi gửi).

## 4. Bề mặt đã sửa

| Bề mặt | File | Thay đổi |
|---|---|---|
| Lưới nhập liệu desktop — dòng đã lưu | `direct-entry-live.tsx` | `initial_status` chỉ còn nhãn (bỏ "· hiệu lực …"); `cells.gender` hiện nhãn tiếng Việt từ giá trị canonical |
| Lưới nhập liệu desktop — dòng vừa dán/xlsx | `direct-entry-live.tsx` | ingest đổi enum sang nhãn (`Nam`, `Đang chờ việc`) — payload vẫn canonical khi lưu |
| Ô select giới tính trên lưới | `direct-entry-spreadsheet-grid.tsx` | giá trị ngoài danh mục (vd `OTHER` cũ) hiện nhãn nhưng bị `disabled`, chỉ chọn được Nam/Nữ |
| Lưới nhập liệu mobile | `direct-entry-live.tsx` | select giới tính hiện nhãn, giữ option `OTHER` cũ ở dạng `disabled` |
| Hộp xem trước dữ liệu dán | `direct-entry-worker-profile-paste-dialog.tsx` | "Giới tính" và "Tình trạng làm việc hiện tại" qua helper (hết rò mã enum) |
| Danh sách/chi tiết/luồng đề xuất–duyệt NLĐ | `worker-operations.tsx`, `change-request-proposer.tsx`, `change-request-read-projection.ts`, `change-request-reviewer.tsx` | tất cả qua nhãn thống nhất |
| Báo cáo CCCD trùng | `duplicate-cccd-report-panel.tsx` (qua contract) | badge/ô trạng thái dùng nhãn thống nhất |
| Cảnh báo CCCD trùng khi gửi | `direct-entry-duplicate-cccd-dialog.tsx` (qua contract) | dòng "Trạng thái hiện tại: …" dùng nhãn thống nhất |
| Demo/shell nhập liệu | `ui-model.ts`, `direct-entry-shell.tsx` | `workStatus` demo dùng "Đang chờ việc" |
| Hộp xem trước dữ liệu dán — gợi ý lỗi | `worker-profile-import-contract.ts` | `PASTE_STATUS_INVALID` liệt kê nhãn mới |

Ghi chú: `initial_status` không nằm trong `DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS` nên trước đây không được render; việc bỏ hậu tố ngày vẫn thực hiện và không làm mất dữ liệu (ngày hiệu lực vẫn ở `row.profile.employment`).

## 5. Test hồi quy

Lane mới: `pnpm test:pre-w2-hf-ui-labels` → `node --conditions=react-server --test src/lib/direct-entry/ui-labels-regression.test.mjs` (đã đăng ký đúng một lần trong chuỗi `pnpm test`).

Chứng minh:
- UI dùng nhãn tiếng Việt (status + gender), không bao giờ trả mã enum.
- Luồng đề xuất/duyệt sửa NLĐ hiện giới tính "Nam/Nữ".
- Dán dữ liệu nhãn tiếng Việt → write model vẫn giữ enum canonical (`MALE`, `UNCONFIRMED`).
- Lưới nhập liệu không còn hậu tố "· hiệu lực"; live + preview dùng helper.

Đã cập nhật kỳ vọng cũ trong: `worker-operations-model.test.mjs`, `p2-5-hf-r3-worker-project-interaction.test.mjs`, `change-request-reviewer.test.mjs`, `duplicate-cccd-report-contract.test.mjs`, `submission-duplicate-cccd-contract.test.mjs`, `submission-duplicate-cccd-repository.test.mjs`, `submission-duplicate-cccd-preflight-roundtrip.test.mjs`.

## 6. Thay đổi nhỏ ngoài presentation thuần (để T0 xác nhận)

- `worker-profile-paste.ts`: bổ sung alias `dangchoviec` → `UNCONFIRMED` cho `STATUS_ALIASES`. Đây là alias **bổ sung** (superset): không có input hợp lệ nào trước đây trở thành không hợp lệ; cần để nhãn mới "Đang chờ việc" dán lại được và để gợi ý `PASTE_STATUS_INVALID` đúng sự thật. Không đổi luật nghiệp vụ.
- `worker-operations.tsx` (form nhập/sửa NLĐ) vốn đã cho chọn `OTHER` với nhãn "Khác" — giữ nguyên ("tiếp tục"); đây không phải dropdown giới tính của lưới nhập liệu.

## 7. Gates đã chạy

- Focused tests: lib-direct-entry + component-direct-entry + `direct-entry/page.test.mjs` — PASS (dot reporter, 0 fail).
- `pnpm typecheck` — PASS.
- `pnpm build` — PASS (Next.js 16.3.8, 4/4 static pages).
- `pnpm exec eslint <changed files>` — 0 errors, chỉ 2 warning `react-hooks/exhaustive-deps` có sẵn ở `direct-entry-live.tsx:1759,1854`.
- `pnpm lint` (toàn repo): trong môi trường này eslint không hoàn tất (treo > 7 phút, bị abort). Cần chạy lại ở CI/host khác trước khi merge. Lint phạm vi các thư mục bị ảnh hưởng đang được chạy kiểm tra bổ sung.

## 8. Phát hiện có sẵn (không thuộc phạm vi task)

- `src/lib/direct-entry/direct-entry-spreadsheet-dropdown-regression.test.mjs:132` assert `LABOR_TYPE_UI_VALUES`, nhưng hằng này **không tồn tại** ở bất kỳ đâu trong `src`; source hiện dùng `sortedActiveLaborTypes(...)`. Test này không được đăng ký trong lane `pnpm test` nào và fail sẵn trên cây hiện tại. Không sửa trong task này.

## 9. UAT gợi ý (Owner)

1. Lưới nhập liệu desktop/mobile: dán dòng có "Nam"/"Đang chờ việc" → ô hiện đúng nhãn, không hiện `MALE/UNCONFIRMED`.
2. Dòng đã lưu: ô trạng thái chỉ hiện "Đang làm/Đã nghỉ/Đang chờ việc" (không còn "· hiệu lực …"); ô giới tính hiện "Nam/Nữ".
3. Mở dropdown giới tính: chỉ chọn được Nam/Nữ; dữ liệu `OTHER` cũ hiện "Khác" (khoá).
4. Hộp xem trước dữ liệu dán + danh sách/đề xuất/duyệt NLĐ + báo cáo và cảnh báo CCCD trùng: mọi nơi hiện nhãn tiếng Việt.
5. Lưu/đề xuất: request vẫn gửi `MALE/FEMALE/OTHER`, `ON/OFF/UNCONFIRMED` như cũ.
