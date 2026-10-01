# automation/n8n — khu vực của T2 (AI Assistant n8n)

## Quyết định của Owner về workflow

- **Workflow JSON KHÔNG được lưu/push vào Git.**
- Workflow được quản lý trực tiếp trong n8n.
- **Source of truth là workflow ID trong n8n**: `P0-T2-WF01 - Daily recruitment breakdown ingestion`
  (ID `rnjvFA81uOBrVRQJ`, contract `daily-recruitment-breakdown/0.2`).
- Repo chỉ lưu metadata, runbook và bằng chứng nghiệm thu đã sanitize.

## Nội dung trong thư mục này

| Đường dẫn | Nội dung | Owner |
|---|---|---|
| `automation/n8n/docs/p0-t2-wf01-runbook.md` | Runbook vận hành WF01 (metadata + hướng dẫn, không có JSON/secret) | T2 |

> Không có thư mục `workflows/` vì workflow JSON không được track (xem quyết định trên).

**Trước khi chỉnh workflow, đọc:**
- `docs/contracts/daily-recruitment-breakdown-v0.2.md` — contract `daily-recruitment-breakdown/0.2` (R1).
- `docs/handoffs/p0-t1-g1.md` — khối T2 HANDOFF (payload, mapping, validation, upsert, error handling).
- `automation/n8n/docs/p0-t2-wf01-runbook.md` — runbook WF01.

**Không được đưa vào Git:** access token, service key, connection string, workflow JSON,
dữ liệu ứng viên hoặc raw Sheet row.
