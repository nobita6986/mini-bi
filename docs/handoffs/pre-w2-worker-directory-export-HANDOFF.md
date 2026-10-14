# PRE-W2 — Export toàn bộ thông tin trong phạm vi NLĐ hiện có

Status: `PRE_W2_WORKER_DIRECTORY_EXPORT_LOCAL_PASS_AWAITING_T0_REVIEW`

Base: `origin/main@148333e939b780656c3e4fe9d5a52bfaebf913fc` (D3-A đã merge, ledger #92).
Branch/worktree: `codex/pre-w2-worker-directory-export` — local only, chưa commit/push.

## Contract

- Ở hai scope `recruited` và `managed`, actor nghiệp vụ hợp lệ có thể xuất toàn bộ 19 cột hiện có, gồm CCCD, ngày sinh, điện thoại, địa chỉ, thông tin ngân hàng và ghi chú nhập liệu.
- Phạm vi dòng không đổi: DB vẫn yêu cầu verified recruiter link cho `recruited` hoặc phân công PM còn hiệu lực cho `managed`; filter, giới hạn 10.000 dòng, lý do bắt buộc và access audit giữ nguyên.
- Scope `all` không mở rộng: vẫn cần `pii_export + pii_view + payment_view`, effective `all` scope, và `entry_admin` hoặc `change_review` (Admin/BoD/Kế toán).
- Không cấp capability hàng loạt; không đổi endpoint/request/XLSX projection; không có client aggregation, schema/table change hay nghiệp vụ-row mutation.
- UI chỉ mở nút theo actor đã resolve. DB RPC là authority cuối; scope không hợp lệ vẫn nhận denial. Dialog cảnh báo file có dữ liệu PII/thanh toán.

## Files and migration

- Migration append-only #93: `20261014190000_pre_w2_hf_g_worker_directory_export.sql`.
- Replaces only `direct_entry_export_workers`; retains `SECURITY DEFINER`, fixed `search_path`, service-role-only ACL, directory audience guard, 19-field projection, audit mapping, row cap, and strict envelopes.
- UI model + button dialog changed; existing contract, API, repository, ExcelJS writer reused.
- Migration pins rebaselined from 92 to 93; older relative migration indices advanced by one.

## Verification

- Focused export DB/API/UI/XLSX lane: 51/51 passed.
- Mutation probes: HF-G 4/4 RED; updated P1 mutation suite 8/8 RED; both restored sources byte-identically.
- `pnpm db:migrate -- --offline`: 93/93 valid, no DB access.
- Typecheck and Webpack production build passed; lint 0 errors (13 existing warnings); docs check 6/6; secrets scan passed.
- Full canonical `pnpm test` not run; Owner UAT not performed.

## Owner UAT checklist (not performed by T0)

1. Recruiter: export `Người tôi tuyển`; verify full CCCD/phone/address/bank/general note and no rows belonging to another recruiter.
2. PM: export `Dự án tôi quản lý`; verify full fields and no rows outside current effective assignments.
3. Verify `all` remains hidden/denied for recruiter/PM; Admin/BoD/Accounting retain prior all-scope rules.
4. Confirm required reason is recorded, XLSX is private/no-store, and the 10,000-row limit fails closed.
5. Run only on the designated Vercel + staging database after migration #93 is explicitly applied there; compare DB migration ledger and test representative role accounts.

No staging/Production/VPS database was queried or changed; migration #93 was not applied. No Vercel or VPS deploy/UAT was performed. Previous staging RPC/503 diagnosis remains unverified until the staging endpoint can be reached and its ledger/function version checked.
