# automation/n8n — khu vực của T2 (AI Assistant n8n)

Thư mục này dành cho artifact của workflow n8n theo cấu trúc repo ở `docs/P0.md` §10:

| Đường dẫn | Nội dung | Owner |
|---|---|---|
| `automation/n8n/workflows/` | Workflow export đã loại secrets | T2 |
| `automation/n8n/docs/` | Mapping, hướng dẫn cấu hình credential, runbook | T2 |

T1 (web/database) không tạo hoặc sửa workflow n8n.

**Trước khi viết workflow, đọc:**

- `docs/contracts/daily-recruitment-breakdown-v0.2.md` — contract **`daily-recruitment-breakdown/0.2`**
  (grain theo ngày + dự án + người tuyển + HRP/Vendor + loại hình làm việc).
- `docs/handoffs/p0-t1-g1.md` — khối **T2 HANDOFF**: payload, mapping, validation,
  upsert, error handling, fixture, expected database result và acceptance criteria.

> **Lưu ý:** contract `daily-recruitment-count/0.1` đã bị retire. Không dựng workflow theo bản cũ.

**Không được đưa vào thư mục này:** access token, service key, connection string,
dữ liệu ứng viên hoặc raw Sheet row.
