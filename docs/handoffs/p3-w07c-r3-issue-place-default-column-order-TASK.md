# P3-W07C-R3 — Direct Entry column order + server default for CCCD issue place

## Task

`P3-W07C-R3_DIRECT_ENTRY_COLUMN_ORDER_AND_ISSUE_PLACE_SERVER_DEFAULT`

## Status

`P3-W07C-R3_ISSUE_PLACE_DEFAULT_COLUMN_ORDER_LOCAL_PASS_AWAITING_INTEGRATION`

## Base

- Branch: `feature/p3-w07c-r3-issue-place-default-column-order`
- Base SHA: `origin/main@c86cd9288e5af6ba7b654e5b8d5a88753c3fa54c`
- Source tree: `C:/CodeApp/BI-p3-w07c-r3-issue-place-default-column-order`

## Scope

1. Reorder Direct Entry default-visible columns: `Dự án → HRP/Vendor → Người tuyển / Vendor → Loại hình LĐ → còn lại`. `recruiter_id` still required, recruiter dropdown still wired by `provider_type`.
2. Bỏ `Nơi cấp` (`national_id_issued_place`) khỏi **mọi** bề mặt nhập Direct Entry: desktop grid (default visible), mobile staged card, quick editor drawer, dialog nhập hồ sơ (preview panel), và template Excel mới. Không cần hiển thị read-only.
3. Đồng bộ chính xác header / thứ tự cột giữa mẫu Excel mới và parser/importer. KHÔNG còn tương thích ngược với file Excel mẫu cũ (còn cột `Nơi cấp` hoặc cột `Mã NLĐ` ở đầu) — upload file không khớp 16 header theo đúng thứ tự sẽ trả `XLSX_INVALID` rõ ràng.
4. RPC `direct_entry_create_full_profile_batch` ghi `national_id_issued_place = {"state":"provided","value":"Bộ Công An"}` cho mọi NLĐ Direct Entry tạo mới, bất kể client gửi thiếu / rỗng / giá trị khác. Không COALESCE — RPC ghi đè hoàn toàn giá trị client nhưng vẫn giữ field này trong JSONB. Không backfill hồ sơ lịch sử, không sửa luồng cập nhật hồ sơ hiện có.
5. Migration slot `20261008060000` (#46 trên branch hiện tại; #47 sau khi W05A #45 integrate). Source-preserving patch qua `pg_proc.prosrc` + `pg_get_functiondef`; assertion security boundary (`prosecdef=true`, `proconfig @> array['search_path=pg_catalog, public']`, `service_role` EXECUTE granted, `anon` / `authenticated` / `public` EXECUTE denied).

## Out of scope

- Historical entry backfill hay update RPCs khác — chỉ create-batch bị patch.
- Removing `national_id_issued_place` khỏi `WORKER_PROFILE_FIELDS`, `direct-entry-v1` Zod schema, validator.
- Production apply, main push, deploy.

## Bổ sung R3 — Favicon

- Thay `src/app/favicon.ico` (Next.js App Router convention tại top-level `app/`) bằng file ICO mới (`C:\Users\Admin\Downloads\favicon.ico`, 15086 bytes, SHA256 `042EBC6A9FCFFCD0D4DF27B26ED0467AF6DB00D85C7AE0E7E3621DD1BDAB40ED`).
- Next.js tự phát sinh `<link rel="icon" href="/favicon.ico" sizes="any" />` trong `<head>` — không cần code.
- Sau build: `.next/static/media/favicon.<hash>.ico` (15086 bytes) + `.next/server/app/favicon.ico`. Routes manifest đăng ký `/favicon.ico`.
- KHÔNG tham chiếu đường dẫn `C:\Users\Admin\Downloads` trong runtime/build.
- KHÔNG thêm dependency; KHÔNG chạm Production / main / deploy.