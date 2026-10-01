# P0 — Final Acceptance (End-to-End)

| Thuộc tính | Giá trị |
|---|---|
| Trạng thái | **PASS** (nghiệm thu P0; mở P1) |
| Contract | `daily-recruitment-breakdown/0.2` (R1) |
| Migrations | 9 migration (`20261001120000`…`20261001140200`) |
| Boundary | `replace_daily_recruitment_breakdown_snapshot_v02` · `record_recruitment_source_failure_v01` |
| Web commit | xem commit cuối P0-FINAL (report mục VII) |
| Workflow | P0-T2-WF01 - Daily recruitment breakdown ingestion (ID `rnjvFA81uOBrVRQJ`) |

## 1. Revision đã nghiệm thu

| Hạng mục | Giá trị |
|---|---|
| Workflow version (final run) | `0562b7e0-3266-42c1-ac3b-ab81872570c2` |
| Safe draft sau khôi phục | `d90c0136-9704-4cc3-873e-2c7265089f85` |
| Final full-folder execution | Execution ID `278` |
| Trạng thái workflow | Draft / manual, `activeVersionId=null`, không AI/schedule/bot |

## 2. Expected vs Actual (dữ liệu nguồn thật, T0 đã đối soát)

| Hạng mục | Expected | Actual | Kết quả |
|---|---|---|---|
| Đọc Google Sheets thật | Đọc 2 nguồn trong report folder | `files_discovered=2`, `total_rows_read=2` | PASS |
| Ghi applied | Source mới ghi lần đầu | `rpc_applied=1` (report_daily_Anhhr1) | PASS |
| Replay unchanged | Chạy lại không nhân đôi | `rpc_unchanged=1` (report_daily_Haohr1) | PASS |
| Contract rejection | Payload sai bị từ chối | `UNKNOWN_FIELD` (ca C1) | PASS |
| Source failure giữ snapshot | Lỗi nguồn không xoá dữ liệu cũ | `record_recruitment_source_failure_v01` giữ snapshot (ca C1) | PASS |
| Full-folder multi-source | Hai nguồn độc lập, không ghi đè | `sources_succeeded=2`, `total_groups=2` | PASS |
| `/pipeline-check` | Hiển thị dữ liệu thật | hiển thị 2 nguồn thật | PASS |
| Secret scan | Không secret trong bundle/source | `pnpm secrets:check` PASS | PASS |

## 3. Nguồn thật (2 nguồn, tổng 2 người)

| Nguồn | source_id | latest run | outcome | status | business_date | recruited | rows |
|---|---|---|---|---|---|---|---|
| `report_daily_Haohr1` | `9e89dfd3-c1f9-4171-8ffe-7d5b2b475a51` | `cb4ec8da-ff6a-4eec-bff6-5dce3405f0c0` | `unchanged` | `succeeded` | 2026-10-01 | 1 | 1 |
| `report_daily_Anhhr1` | `3c91bb59-59cb-476e-b2f8-dea098c9b20b` | `0bee0a95-2a8d-4b81-816e-8523f0445136` | `applied` | `succeeded` | 2026-02-13 | 1 | 1 |

- `report_daily_Anhhr1`: project/recruiter trống → DB lưu **“Không xác định”**; provider = `HRP`; employment = `Thời vụ`.
- Cả hai source có `last_successful_sync_at` đã cập nhật (run `succeeded`).

## 4. Dữ liệu fixture vs dữ liệu thật (quan trọng)

| Loại | Nội dung | Dùng cho |
|---|---|---|
| Fixture DEV (`P0FIXTURE_*`) | 2 source tổng hợp, tổng 14 người | Kiểm thử contract/RPC; **KHÔNG** dùng làm số BoD |
| Nguồn thật | 2 source (Haohr1, Anhhr1), tổng 2 người | Bằng chứng end-to-end |

## 5. Không được ghi trong tài liệu này

- Raw dữ liệu ứng viên (D–I/M), họ tên/ngày sinh/CCCD/địa chỉ/SĐT/ghi chú.
- Secret, token, credential, Authorization header.
