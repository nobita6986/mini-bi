# Runbook — P0-T2-WF01 · Daily recruitment breakdown ingestion

> Owner: T2 (n8n). Tài liệu này là metadata + runbook đã sanitize. **Không chứa workflow JSON,
> credential ID/value, token, Authorization header hay dữ liệu ứng viên.**

## 1. Định danh workflow

| Thuộc tính | Giá trị |
|---|---|
| Name | P0-T2-WF01 - Daily recruitment breakdown ingestion |
| Workflow ID | `rnjvFA81uOBrVRQJ` |
| Contract | `daily-recruitment-breakdown/0.2` (R1) |
| Số node | 26 |
| Trạng thái | Draft / manual trigger (activeVersionId = null) |
| Tự động hoá | Không schedule, không bot, không AI |

## 2. Credential cần gắn (chỉ tên, không ghi ID/value)

| Credential | Mục đích |
|---|---|
| Google Drive account | Liệt kê file trong report folder (report_folder_id) |
| Google Sheets account | Đọc dữ liệu từng Sheet |
| Supabase DEV service role | Gọi boundary `replace_daily_recruitment_breakdown_snapshot_v02` / `record_recruitment_source_failure_v01` |

> Chỉ dùng service role của **DEV**. Không gắn credential PROD. Không ghi ID/value credential vào đây.

## 3. Config nguồn

| Khoá | Giá trị |
|---|---|
| `report_folder_id` | `1GGi9XTF-0JTI1MSzHJDYI6a6VEReCDX4` |
| `sheet_name` | `Sheet1` |
| Header / data row | dòng 1 / dòng 2 (header ở hàng 1, dữ liệu bắt đầu hàng 2) |
| Cột đọc | **B** (Dự án) · **C** (Ngày vào) · **J** (HRP/Vendor) · **K** (Người tuyển) · **L** (Loại hình LĐ) |
| `timezone` | `Asia/Ho_Chi_Minh` |

> Chỉ đọc 5 cột B/C/J/K/L. **Không** đọc các cột D–I hoặc cột M (dữ liệu cá nhân ứng viên).
> Cột A (`stt`) không dùng làm khoá hay nhận diện.

## 4. Công tắc an toàn khi chạy

| Công tắc | Ý nghĩa |
|---|---|
| `write_enabled=false` | Mặc định tắt ghi: chỉ đọc + validate + đếm, **không** gọi RPC write |
| `write_test_only=true` | Khi bật ghi, chỉ ghi nguồn test `test_drive_file_id`, không ghi các file khác |
| `test_drive_file_id` = `1wTCdDrMRAcZ0JRy30oH4FYCxSjFmsE9wF_g6_XH1otY` | File test để bật ghi an toàn |

Quy tắc vận hành: bật `write_enabled` + `write_test_only=true` để kiểm thử ghi trên file test trước.
Chỉ tắt `write_test_only` khi PO đã cho phép ghi nguồn thật trên DEV.

## 5. Chạy một nguồn (read-only)

1. Mở workflow (Manual Trigger).
2. Đặt `write_enabled=false`, chỉ định một `drive_file_id` (hoặc `test_drive_file_id`).
3. Execute node → xác nhận `files_discovered=1`, đếm `rows_read/valid/rejected/warned`, **không** có dòng `sync_runs` mới.

## 6. Chạy một nguồn có write (DEV)

1. `write_enabled=true`, `write_test_only=true`, dùng `test_drive_file_id`.
2. Execute → gọi `replace_daily_recruitment_breakdown_snapshot_v02`.
3. Kiểm tra response `outcome=applied` hoặc `unchanged`, `run_status=succeeded`.
4. Đối soát `daily_recruitment_breakdown` / `sync_runs` / `sync_errors` với Sheet.

## 7. Chạy full folder thủ công

1. `write_enabled=true`, `write_test_only=false` (khi đã được PO cho phép).
2. Manual Trigger → đọc toàn bộ file trong `report_folder_id`.
3. Kết quả mẫu nghiệm thu (Execution 278): `files_discovered=2`, `sources_succeeded=2`,
   `sources_partial=0`, `sources_failed=0`, `total_rows_read=2`, `total_rows_valid=2`,
   `total_rows_rejected=0`, `rpc_applied=1`, `rpc_unchanged=1`, `rpc_rejected=0`, `total_groups=2`.

## 8. Replay / idempotency

- Chạy lại cùng dữ liệu ⇒ cùng nguồn trả `outcome=unchanged`, tổng không đổi, không nhân đôi.
- Mỗi lần chạy mới phải dùng `sync_run_id` (UUID v4) mới.
- `last_successful_sync_at` chỉ cập nhật khi run `succeeded`.

## 9. Xử lý lỗi

| Mã | Ý nghĩa | Hành động |
|---|---|---|
| `FILE_NOT_NATIVE_SHEET` | File không phải Google Sheets gốc | Bỏ qua file, ghi `sync_errors` qua `record_recruitment_source_failure_v01` |
| `SHEET_NOT_FOUND` | Thiếu tab `Sheet1` | Báo lỗi nguồn, không ghi snapshot |
| `INVALID_HEADER` | Header không khớp cột B/C/J/K/L | Báo lỗi nguồn, không ghi snapshot |
| `SOURCE_READ_FAILED` | Không đọc được (quyền/mạng/quota) | Run `failed`; **không** gửi snapshot rỗng; giữ snapshot cũ |
| `MISSING_DATE` | Hàng có dữ liệu nhưng C trống | `row_issues` mức `error` ⇒ rejected |
| `INVALID_DATE` | C sai | `row_issues` mức `error` ⇒ rejected |

> INVALID_PROVIDER_TYPE / INVALID_EMPLOYMENT_TYPE (J/L ngoài danh mục) là **warning**, hàng vẫn được tính.
> Chi tiết: `docs/contracts/daily-recruitment-breakdown-v0.2.md`.

## 10. Backup workflow (thủ công)

Workflow JSON **không** được commit vào Git (quyết định của Owner). Khi cần backup:
1. Trong n8n, mở workflow → menu ⋯ → Download (export JSON).
2. Lưu vào nơi lưu secrets nội bộ (không phải repo), kèm ngày giờ và `workflowId`.
3. Credential được tách riêng; file export chỉ chứa tham chiếu credential (tên), không chứa giá trị.

## 11. Xác nhận trạng thái

- Không có schedule (chưa bật lịch 6 giờ).
- Không có bot `/sync`.
- Không có node AI/LLM.
- Draft / manual trigger; `activeVersionId=null` (chưa có bản active).

## 12. Không được ghi vào đây

- Credential ID/value, token, Authorization header, connection string.
- Workflow JSON hoặc payload chứa dữ liệu ứng viên (D–I/M).
- Bất kỳ PII nào.
