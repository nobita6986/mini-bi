# PRE-W2-HF-E — Worker Excel export: Admin/BoD/Kế toán "all" scope + cột Ghi chú

- **Status:** `PRE_W2_HF_E_WORKER_EXPORT_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@0e5e27dcf5571d043a151a5f819efed843f3d52d` (ledger **88**, next slot **#89** verified — không mặc định).
- **Impl SHA:** `5b47ddda76352377de817ae0ad764d0bc288259d`
- **Branch / worktree:** `feature/pre-w2-hf-e-worker-export` trên worktree cô lập
  `C:\CodeApp\BI\.worktrees\pre-w2-hf-e` (`node_modules` là junction về primary). **Primary
  checkout không bị chạm.**

## Preflight

Fetch origin → base `0e5e27d`, ledger 88 (last migration `20261013140000_pre_w2_hf_d2_...`). Slot
kế tiếp #89 được xác minh qua `pnpm db:migrate -- --offline` (89/89). Không có migration #89 sẵn có;
không đụng migration/DB Production.

## Thay đổi (reuse P1, additive)

- **Migration append-only #89** `supabase/migrations/20261014120000_pre_w2_hf_e_worker_export_all_and_note.sql`:
  `create or replace public.direct_entry_export_workers` (cùng chữ ký). Hai thay đổi additive:
  1. `all` scope được phép nhưng **chỉ** cho DB-authoritative audience `direct_entry_worker_directory_audience`
     = effective `all` scope **AND** (`entry_admin` OR `change_review`) — tức **Admin / BoD / Kế toán**.
     `recruited`/`managed` giữ nguyên; capability conjunction `pii_export AND pii_view AND payment_view`
     vẫn áp cho mọi scope. Candidate WHERE thêm nhánh `or (v_scope = 'all')`; `scope_kind` mapping thêm
     `all → 'all'`. Không cấp quyền, không sửa dữ liệu NLĐ, không dùng service role để vượt RPC.
  2. Cột `Ghi chú` lấy từ `direct_entries.general_note` (`'general_note', b.general_note`). `payment_note`
     giữ nguyên (luôn null), **không** thay thế.
- **Contract** `worker-export-contract.ts`: scope thêm `all`; row projection 19 field (thêm
  `general_note`, string/null ≤4000); column `Ghi chú` (thứ 19).
- **UI** `worker-export-ui-model.ts`/`worker-operations.tsx`/`workers/page.tsx`: nút "Xuất Excel" xuất hiện
  trên tab **"Toàn bộ NLĐ"** khi actor có đủ export caps + all scope + (`entry_admin`|`change_review`)
  (`canExportAllWorkers`). Tab `recruited`/`managed` giữ gate cũ. Authority cuối do RPC quyết định.
- **Không** tạo trang/endpoint mới, **không** thêm dependency, **không** đổi cột/hành vi P1 (XLSX vẫn giữ
  số 0 đầu + chống formula injection qua ExcelJS literal string).

## File

- Mới `supabase/migrations/20261014120000_pre_w2_hf_e_worker_export_all_and_note.sql`.
- Mới `scripts/pre-w2-hf-e-worker-export-mutation.mjs`.
- Sửa `src/lib/direct-entry/worker-export-contract.ts`, `worker-export-ui-model.ts`,
  `worker-operations.tsx`, `src/app/direct-entry/workers/page.tsx`.
- Sửa tests: `worker-export-contract.test.mjs`, `worker-export-repository.test.mjs`,
  `worker-export-api.test.mjs`, `worker-export-xlsx.test.mjs`, `worker-export-ui-model.test.mjs`,
  `worker-export-ui.test.mjs`, `scripts/pre-w2-p1-worker-export-db.test.mjs`.
- Sửa `package.json` (lane `test:pre-w2-hf-e-worker-export`, đăng ký một lần vào `pnpm test`).

## Test & gate

- Focused lane `test:pre-w2-hf-e-worker-export` — contract/repo/api/xlsx (26) + DB (7) + UI (18) **xanh**.
  DB test thêm: Admin (entry_admin+all) xuất `all` ok + `scope_kind='all'`; BoD/Kế toán (change_review+all)
  xuất toàn bộ + `general_note` đúng `direct_entries.general_note`; recruiter/PM (có export caps nhưng không
  all scope) bị từ chối `all`; Admin thiếu `pii_export` bị từ chối `all`; recruited/managed + cap + audit
  giữ nguyên.
- Related lanes xanh: `test:pre-w2-p1-worker-export-backend` (26+7), `test:pre-w2-p1-worker-export-ui` (18),
  `test:p2.5-w06` (62), `test:p3-1-hf-change-request-panel` (57).
- `pnpm typecheck` 0 · `pnpm lint` 0 error / 13 warning pre-existing · `next build --webpack` 0 ·
  `pnpm docs:check` 6/6 · `pnpm secrets:check` clean · `pnpm db:migrate -- --offline` **89/89** ·
  `git diff --check` 0. (`pnpm build` Turbopack không chạy được trong worktree do junction — dùng Webpack.)

## Mutation evidence

`node scripts/pre-w2-hf-e-worker-export-mutation.mjs` — **4/4 RED**, khôi phục byte-identical:
1. Bỏ gate audience `all` trong UI (chỉ còn export caps) → UI test đỏ.
2. Bỏ cột `general_note` khỏi row projection → contract test đỏ.
3. Migration biến `general_note` thành null (không lấy từ cột) → DB test đỏ.
4. Migration cho `all` bỏ qua capability conjunction → DB test đỏ.

## Rủi ro / blocker

- Không có blocker. Quyền vẫn do RPC/DB enforce; UI chỉ ẩn/hiện theo projection server.
- `pii_export`/`pii_view`/`payment_view` phải được T0/Admin cấp cho actor Admin/BoD/Kế toán trước UAT
  (migration không cấp quyền). Row audience `all` vẫn giới hạn bởi scope grant + entry_admin/change_review.
- `payment_note` vẫn rỗng (chưa có nguồn authoritative); `general_note` là cột riêng, additive.
- Không merge main; không apply DB/migration; không deploy VPS/Vercel; không tự UAT (Owner chạy).

## Checklist UAT cho Owner

Chuẩn bị: (a) một tài khoản Admin (`entry_admin` + `all` scope + `pii_export,pii_view,payment_view`);
(b) một BoD/Kế toán (`change_review` + `all` scope + export caps); (c) một recruiter/PM (có export caps
nhưng **không** `all` scope).

1. **Admin ở tab "Toàn bộ NLĐ":** thấy nút "Xuất Excel" → nhập lý do → tải file. Kỳ vọng: 19 cột, cột cuối
   "Ghi chú" đúng nội dung đã nhập ở màn hình Nhập liệu (`direct_entries.general_note`), không phải
   `payment_note`; Mã NLĐ/CCCD/SĐT/STK giữ số 0 đầu; ô bắt đầu `=`/`+`/`-`/`@` là text.
2. **BoD/Kế toán ở tab "Toàn bộ NLĐ":** tương tự, xuất được toàn bộ NLĐ, ghi chú đúng.
3. **Recruiter/PM ở tab "Toàn bộ NLĐ":** nút "Xuất Excel" KHÔNG hiển thị (hoặc bị từ chối 403 khi gọi trực
   tiếp) — không được xem PII/payment toàn hệ thống.
4. **Recruiter/PM ở tab "Người tôi tuyển"/"Dự án tôi quản lý":** hành vi P1 giữ nguyên (nút theo quyền cũ).
5. **Quá 10.000 dòng:** nhận thông báo vượt giới hạn, không tải file thiếu dòng.
6. **Audit:** `direct_entry_audit_events` ghi `action=worker_export`, `capability=pii_export`,
   `scope_kind` = `own`/`project`/`all` đúng scope, lý do bắt buộc được lưu; không thấy PII trong logs/UI lỗi.

## Chờ T0

Push branch fast-forward, **không** merge main. Dừng ở trạng thái chờ T0 review; migration #89 chờ T0
review/apply (không tự apply vào DB nào).
