# mini-bi — Sales Performance & Reporting System V1

Hệ thống báo cáo kết quả kinh doanh và quản trị KPI cho BoD / Leader / Staff.

Luồng dữ liệu: **Google Sheets → n8n → Supabase/PostgreSQL → Next.js → người dùng**.
"Kết quả kinh doanh" trong dự án này là **số người được tuyển theo ngày**, không phải tiền.

> Trạng thái hiện tại: **P0 (Foundation)**. Repo có trang nền, data contract và ingestion
> boundary trên Supabase DEV. **Chưa có** dashboard BoD (P1), auth (P3), KPI (P4),
> và chưa có workflow n8n trong repo này.

## Tài liệu baseline

| Tài liệu | Nội dung |
|---|---|
| `docs/master-plan.md` | Mục tiêu, kiến trúc, phạm vi, roadmap P0–P4 |
| `docs/P0.md` … `docs/P4.md` | Kế hoạch thực thi từng phase |
| `docs/contracts/daily-recruitment-count-v0.1.md` | **Data contract v0.1** (nguồn tham chiếu cho T2/n8n) |
| `docs/handoffs/p0-t1-g1.md` | Handoff kỹ thuật của task P0-T1-G1 (không chứa secret) |
| `docs/acceptance/p0-t1-g1-fixtures.md` | Kết quả kiểm thử contract |

## Stack

| Thành phần | Phiên bản |
|---|---|
| Next.js (App Router) | 16.3.8 — Turbopack mặc định |
| React | 19.2.8 |
| TypeScript | 5.9.x (`strict`) |
| Tailwind CSS | 4.3.x (qua `@tailwindcss/postcss`) |
| Supabase JS | 2.117.x |
| Zod | 4.6.x |
| Package manager | pnpm 10.34.5 (một lockfile duy nhất: `pnpm-lock.yaml`) |

## Bắt đầu

Yêu cầu: Node.js ≥ 20.9 (đã kiểm tra trên v24.9.0) và pnpm.

```bash
pnpm install
cp .env.example .env.local   # rồi điền giá trị (xem dưới)
pnpm dev                     # http://localhost:3000
```

### Biến môi trường

`.env.example` chỉ chứa **tên biến và placeholder**. Giá trị thật lấy từ cấu hình môi
trường do chủ dự án cấp và **không** được commit (xem `.gitignore`).

| Biến | Phạm vi | Bắt buộc | Ghi chú |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | có | URL project Supabase |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | có | Key công khai; bị RLS/RPC grants từ chối mọi truy cập dữ liệu |
| `SUPABASE_SECRET_KEY` | server-only | khi cần đọc/ghi server | **Key đặc quyền, bypass RLS.** Không đặt tiền tố `NEXT_PUBLIC_` |
| `SUPABASE_DB_URL` | server-only | cho script ngoài Next.js | Không nạp vào web runtime |
| `SUPABASE_POOLER_HOST` / `SUPABASE_POOLER_PORT` | server-only | khi host `db.<ref>` chỉ có IPv6 | Xem mục Migration |
| `SUPABASE_CONFIG_FILE` | server-only | không | Đường dẫn file cấu hình ngoài repo cho script |

Thiếu biến bắt buộc ⇒ ứng dụng báo lỗi cấu hình rõ ràng. **Không có giá trị mặc định và
không có fallback im lặng.**

## Script

| Lệnh | Việc |
|---|---|
| `pnpm dev` | Chạy dev server |
| `pnpm build` | Build production |
| `pnpm start` | Chạy bản đã build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm db:migrate` | Áp dụng migration lên Supabase (thêm `-- --dry-run` để xem trước) |
| `pnpm fixtures:check` | Chạy bộ ca nghiệm thu contract trên DEV |
| `pnpm secrets:check` | Quét secret trong client bundle và source |

## Migration

Migrations nằm ở `supabase/migrations/`, đặt tên `<timestamp>_<mô tả>.sql`, áp dụng theo
thứ tự tên file. Mỗi file chạy trong **một transaction** và được ghi nhận vào
`public.schema_migrations` kèm checksum.

- **Không sửa file migration đã áp dụng.** Runner sẽ dừng nếu checksum lệch — hãy tạo file mới.
- Chỉ T1 (owner database) được tạo/sửa migration.
- Không chạy migration trực tiếp trên PROD ngoài quy trình đã duyệt.

### Kết nối DB từ máy dev

Host `db.<project-ref>.supabase.co` của project DEV **chỉ có bản ghi AAAA (IPv6)**. Nếu máy
không có IPv6 ra Internet, đặt `SUPABASE_POOLER_HOST` trong `.env.local` để đi qua Supavisor
pooler (session mode, cổng 5432); script sẽ tự ghép user `postgres.<project-ref>`.

Pooler dùng PKI riêng của Supabase, không có trong CA store của Node. Repo **pin sẵn root CA**
ở `supabase/certs/supabase-pooler-root-2021-ca.pem` để vẫn xác minh chứng chỉ server.
Khi Supabase xoay CA, cập nhật file này. Chỉ dùng `SUPABASE_DB_TLS_INSECURE=1` để xử lý sự cố
cục bộ — script sẽ in cảnh báo rõ ràng.

## Ingestion boundary

```sql
public.replace_daily_recruitment_snapshot_v01(p_payload jsonb) returns jsonb
```

- Chỉ `service_role` được thực thi; `PUBLIC`/`anon`/`authenticated` đã bị thu hồi quyền.
- Payload là **tổng hợp** theo contract `daily-recruitment-count/0.1`; **không** chứa dữ liệu ứng viên.
- Thay thế toàn bộ snapshot daily counts của đúng một source trong một transaction.
- Cùng payload gửi lại ⇒ `outcome = unchanged`, không tạo duplicate.

Chi tiết đầy đủ: `docs/contracts/daily-recruitment-count-v0.1.md`.

## Cấu trúc repo

```text
src/app/                    layout, trang nền
src/components/ui/          UI primitives (Card, Alert)
src/lib/contracts/          schema/type của data contract
src/lib/supabase/           Supabase server client
src/lib/env.ts              validation biến môi trường
supabase/migrations/        DDL + RPC có version
supabase/certs/             root CA pin cho pooler (chứng chỉ công khai)
scripts/                    migration runner, fixture check, secret check
docs/contracts/             contract + fixture
docs/acceptance/            bằng chứng kiểm thử
docs/handoffs/              handoff kỹ thuật
automation/n8n/             (dành cho T2) workflow export, mapping, runbook
```

## Quy tắc bảo mật

- Không đưa secret vào source, frontend, Git, log hoặc tài liệu bàn giao.
- `SUPABASE_SECRET_KEY` là key đặc quyền: chỉ dùng server-side.
- Bảng dữ liệu bật RLS và **không có policy** cho `anon`/`authenticated` ⇒ truy cập ẩn danh bị chặn.
- Không lưu hồ sơ ứng viên, raw Sheet row hoặc PII vào database/Git.
- Chạy `pnpm secrets:check` trước khi commit và sau khi build.

## Giới hạn đã biết (P0)

- Chưa có Auth người dùng và chưa có phân quyền BoD/Leader/Staff (P3).
- Chưa có run-start marker/lease chống chạy đồng thời; xem `docs/handoffs/p0-t1-g1.md`.
- Chưa có lịch sử snapshot (chỉ giữ bản hiện hành).
- Chưa có UI vận hành nguồn dữ liệu (P2) và chưa có dashboard (P1).
