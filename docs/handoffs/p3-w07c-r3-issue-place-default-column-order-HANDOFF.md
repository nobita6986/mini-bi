# P3-W07C-R3 — Direct Entry column order + server default for CCCD issue place (HANDOFF)

Status: `P3-W07C-R3_PRODUCTION_DEPLOYED_AWAITING_OWNER_UAT`
Branch: `feature/p3-w07c-r3-issue-place-default-column-order` (worktree `C:/CodeApp/BI-p3-w07c-r3-issue-place-default-column-order`)
Base SHA: `origin/main@c86cd928`; R3 code commit: `e76dc3a`.
Integration: fast-forward `main` to `e76dc3a`; feature branch and `origin/main` both point there; worktree clean.
Production ledger: 46 applied / 0 pending / 0 mismatch after applying W07C-R2 then R3; W05A remains separate.
Migration: `20261008050000_p3_w07c_r2_raw_text_dates.sql` then `20261008060000_p3_w07c_r3_issue_place_server_default.sql`.

## Thay đổi chính

**1. Cột mặc định Direct Entry (`DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS`)** — 17 cột, thứ tự: `Dự án → HRP/Vendor → Người tuyển / Vendor → Loại hình LĐ → Ngày bắt đầu làm việc → Họ và tên → …`. `recruiter_id` vẫn required; recruiter dropdown vẫn filter theo `provider_type`. Registry vẫn giữ `national_id_issued_place` với `visibleByDefault: false`, `pasteMode: "write"` (chỉ dùng cho legacy reads / projection; không còn là input surface mặc định).

**2. Bỏ `Nơi cấp` khỏi mọi bề mặt nhập Direct Entry** — desktop grid (default visible), mobile staged card, quick editor drawer, dialog nhập hồ sơ (preview panel), template Excel mới. Server-authoritative migration ghi `{"state":"provided","value":"Bộ Công An"}` cho mỗi entry tạo mới.

**3. Đồng bộ header / parser / importer của template Excel** — 16 header theo đúng thứ tự production (`Dự án → HRP/Vendor → Người tuyển / Vendor → Loại hình LĐ → Ngày bắt đầu làm việc → …`). KHÔNG còn tương thích ngược: file mẫu cũ (còn cột `Nơi cấp`) hoặc có cột `Mã NLĐ` thừa → trả `XLSX_INVALID` rõ ràng. Test mới: `rejects legacy 17-column H05 template` và `rejects legacy sheet them cot Mã NLĐ o dau`.

**4. RPC `direct_entry_create_full_profile_batch`** — source-preserving patch qua `pg_proc.prosrc` + `pg_get_functiondef`. Mỗi `v_worker_details := jsonb_build_object(...)` của entry mới ghi cứng `'national_id_issued_place', '{"state":"provided","value":"Bộ Công An"}'::jsonb` (không COALESCE; client gửi gì cũng bị ghi đè). Patch chỉ một dòng; mọi thứ khác (audit, idempotency, scope checks, function owner) bảo toàn. Migration kiểm tra security boundary ngay sau khi patch:
- `prosecdef = true`
- `proconfig @> array['search_path=pg_catalog, public']`
- `service_role` EXECUTE granted
- `anon` / `authenticated` / `public` EXECUTE denied

Lịch sử hồ sơ và update flow KHÔNG bị đụng.

**5. Lazy default client** — chỉ còn `first_work_date` (Asia/Ho_Chi_Minh today). `national_id_issued_place` không còn tự điền ở client; server migration #46 là nguồn.

**6. Favicon** — thay nội dung `src/app/favicon.ico` (Next.js App Router file convention) bằng file ICO mới 15086 bytes (SHA256 `042EBC6A9FCFFCD0…`). Next.js tự generate `<link rel="icon" href="/favicon.ico" sizes="any" />` trong `<head>` — không cần code. Build phục vụ asset tại `.next/static/media/favicon.<hash>.ico` và `.next/server/app/favicon.ico`; routes manifest đăng ký `/favicon.ico`. Không thêm dependency; không tham chiếu `Downloads` trong runtime/build.

## Production verification

- `bi.hrpartner.vn/favicon.ico` → 200, `image/vnd.microsoft.icon`, 15,086 bytes; SHA-256 khớp file nguồn.
- `/login` → 200; `/dashboard` → 200; `/direct-entry` → 307 login redirect.
- Owner UI UAT remains pending; W05A stays separate (not included; its migration was not applied).

## Test mới / sửa (rút gọn)

- `src/lib/direct-entry/worker-profile-xlsx.ts` — `XLSX_TEMPLATE_KEYS` đổi thứ tự (provider_type/recruiter_id/labor_type ngay sau project_id). Parser chỉ chấp nhận 16 header đúng thứ tự; lệch → `XLSX_INVALID`. Bỏ legacy `Mã NLĐ` skip.
- `src/lib/direct-entry/worker-profile-xlsx.test.mjs` — đồng bộ `headers[0..15]` + `sheet.getRow(2).values` với thứ tự mới. Test `rejects legacy 17-column H05` và `rejects legacy sheet them cot Mã NLĐ` mới.
- `src/components/direct-entry/direct-entry-worker-profile-paste-dialog.tsx` — bỏ dòng `["Nơi cấp", …]` trong preview panel.
- `src/components/direct-entry/direct-entry-h05-r1-ui-gaps.test.mjs` — `EXPECTED_18_COLUMNS` → `EXPECTED_17_COLUMNS` (đã bỏ `national_id_issued_place`).
- `src/components/direct-entry/direct-entry-h08-r1-defaults-text-regression.test.mjs` — R1-24/R1-25 assert `doesNotMatch` JSX `<Field label="Nơi cấp">` (chính xác JSX, không match comment).
- `scripts/p1.6-i04c3-s01-db.test.mjs` — thêm `databaseUpTo(name)` helper; rewrite test "historical rows" thành kịch bản **thật sự trước/sau migration**: apply migrations tới W07C-R2 (#45) → tạo row với `national_id_issued_place = "Hà Nội"` qua pre-R3 RPC → apply R3 migration → verify row vẫn "Hà Nội" → tạo row mới qua post-R3 RPC → verify default "Bộ Công An". Bỏ trailing blank line cuối file (fix `git diff --check`).
- `supabase/migrations/20261008060000_p3_w07c_r3_issue_place_server_default.sql` — Status = LOCAL_PASS; bỏ reference `payment/employment`; giữ assertion security boundary thực tế.
- `docs/handoffs/p3-w07c-r3-issue-place-default-column-order-TASK.md` — ghi nhất quán mobile editor trong scope; status LOCAL_PASS; thêm mục "Bổ sung R3 — Favicon".
- `src/app/favicon.ico` — thay bằng file ICO mới (15086 bytes); Next.js tự serve.

## Gates

- `pnpm test:p1.6-i04c3-r3a` → 153/153
- Targeted (worker-profile-xlsx, direct-entry-grid-columns, spreadsheet-row-model, lazy-default-entrypoints, h08, h05) → 79/79
- `scripts/p1.6-i04c3-s01-db.test.mjs` (PGlite + 10 test suites bao gồm R3 server-default / override / legacy validation / historical row safety) → 10/10
- `pnpm typecheck` ✓
- `pnpm lint` ✓ (0 errors / 11 baseline warnings)
- `pnpm build` ✓
- `git diff --check` clean

## Blocker / Deferred

- Deferred: Owner Direct Entry UAT; W05A scoped-reporting integration (not part of this release).
