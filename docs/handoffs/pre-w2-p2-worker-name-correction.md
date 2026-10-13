# PRE-W2-P2 — Đề xuất sửa họ tên NLĐ qua luồng duyệt hiện có

- **Status:** `PRE_W2_P2_WORKER_NAME_CORRECTION_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@dad101701acfcdb3702b6e1b42e73e9e9e230e2f` (ledger 87; P1 export UI đã merge #12).
- **Impl SHA:** `dfa88c811ba581b2d77226a9bef09b72a0bc06d5`
- **Branch / worktree:** `feature/pre-w2-p2-worker-name-correction` trên worktree cô lập
  `C:\CodeApp\BI\.worktrees\pre-w2-p2-name-correction` (`node_modules` là junction về primary).
  **Primary checkout không bị chạm.**
- **Contract đọc trước khi làm:** `docs/handoffs/pre-w2-s0-pii-export-worker-name-survey.md @ 499a212`
  (PRE-W2-S0-R2 §0.E, §3 SURVEY B) + external memory
  `C:\CodeApp\P2-P3-R00_REUSE_CAPABILITY_SURVEY.md` (mục "Pre-W2 hotfix lock",
  "T0 implementation-binding review", "PRE-W2-S0-R2 accepted"). Không tự đổi quyết định trong memo.

## Kết luận preflight (current origin/main)

SURVEY B đúng với source hiện tại: DB/RPC **đã** cho phép đổi `display_name` (HF-R3 gỡ bảo vệ), và cả
hai entry point **đã** có input `Họ tên` dùng chung `buildWorkerDetailsProposal` +
`buildEntryFieldProposal` + create/decide/apply change-request + reviewer before/after + OCC/audit.
Không có sai lệch backend → **không dừng**, chỉ sửa affordance/authority-alignment đúng như §3.2.9.

**Gap duy nhất được sửa:** entry point "Danh sách người lao động" (`worker-operations.tsx`
`ProposeDrawer`), khi actor có `propose_change` nhưng **thiếu `pii_view`** (hoặc thiếu baseline
canonical), phần target `WORKER` render **rỗng** và nút gửi **vẫn bật** → người dùng chỉ thấy lỗi
"sau khi bấm gửi" (form có thể gửi nhưng chắc chắn thất bại). Entry point "Nhập liệu"
(`direct-entry-change-request-proposer.tsx`) đã có denial đúng (`proposer-worker-unavailable` +
`disabled={!canSubmit}`), giữ nguyên.

## Thay đổi (contract reuse, không tạo workflow thứ hai)

- **`worker-operations-model.ts` (mới `workerNameAvailability`)**: quyết định affordance sửa tên từ
  ba tín hiệu **server cấp** — `propose_change` **và** `pii_view` (hai quyền độc lập, không suy từ
  nhau) **và** baseline canonical (`entryForm !== null`). Thiếu bất kỳ điều kiện nào →
  `available:false` + copy giải thích (`WORKER_NAME_DENIED_PII_MESSAGE` /
  `WORKER_NAME_NO_BASELINE_MESSAGE`).
- **`worker-operations.tsx` (`ProposeDrawer`)**:
  - target `WORKER` (và mode correction) chỉ render form khi `workerNameAvailability.available`;
    ngược lại hiện `<p data-testid="propose-worker-unavailable">` với copy giải thích.
  - nút gửi bị vô hiệu hoá thêm khi `workerFieldMode && !nameAvailability.available`.
  - Submitter không đổi: vẫn `buildEntryFieldProposal` → `buildChangeRequestItem` (target_kind
    `ENTRY_FIELD`, `expected_version`) → `POST /api/direct-entry/change-requests`. **Không** name-only,
    **không** direct-write.
- **Không** đổi validator/contract/RPC/migration/schema/capability/quyền. **Không** thêm dependency.
  `pii_view` vẫn bắt buộc; OCC/version, audit và before/after của reviewer dùng nguyên implementation.

## File

- Mới `src/lib/direct-entry/worker-name-correction.test.mjs` (focused lane).
- Mới `scripts/pre-w2-p2-worker-name-correction-mutation.mjs` (mutation evidence).
- Sửa `src/lib/direct-entry/worker-operations-model.ts` (+`workerNameAvailability`).
- Sửa `src/components/direct-entry/worker-operations.tsx` (denial + disable submit).
- Sửa `package.json` (lane `test:pre-w2-p2-worker-name-correction`, đăng ký một lần trong `pnpm test`).
- Mới `docs/handoffs/pre-w2-p2-worker-name-correction.md` (file này).

## Test & gate

- Focused lane `test:pre-w2-p2-worker-name-correction` — **6/6 pass**. Phủ: gate `propose_change` +
  `pii_view` + baseline; payload `worker_details` **đầy đủ**, chỉ `display_name` đổi (cả
  `buildWorkerDetailsProposal` và `buildEntryFieldProposal`); item giữ `target_kind`/`expected_version`
  (OCC); reviewer before/after dùng `workerDetailsRows` hiện có; source assertions cho **cả hai** entry
  point (denial + nút gửi vô hiệu hoá + reuse `change-requests`, không direct-write/không DB khác).
- Regression liên quan: `test:p2.5-w06` (62), `test:p3-1-hf-change-request-panel` (57),
  `test:p1.6-w04-s04c-s03b1` (13), `test:p1.6-w04-s04c-s03b2` (28), `test:p2.5-hf-r3` (10),
  `test:pre-w2-p1-worker-export-ui` (17) — tất cả xanh.
- `pnpm typecheck` 0 · `pnpm lint` 0 error / 13 warning pre-existing · `next build --webpack` 0 ·
  `pnpm docs:check` 6/6 · `pnpm secrets:check` clean · `git diff --check` 0.
  (`pnpm build` Turbopack không chạy được trong worktree do junction `node_modules` — dùng Webpack.)

## Mutation evidence

`node scripts/pre-w2-p2-worker-name-correction-mutation.mjs` — **4/4 RED**, khôi phục byte-identical:
1. **Bỏ gate `pii_view`** (suy quyền xem PII từ quyền đề xuất) → unit test đỏ.
2. **Gửi name-only payload** (bỏ các field worker_details khác) → payload test đỏ.
3. **Bypass change-request** (POST thẳng `privileged-edit`) → source test đỏ.
4. **Bỏ một entry point** (Directory mất denial) → source test đỏ.

## Rủi ro / ngoài phạm vi

- Row authority + capability vẫn do server quyết định; UI chỉ ẩn/hiện theo tín hiệu server. Một actor
  có `propose_change` nhưng thiếu `pii_view` sẽ thấy giai thích thay vì form (đúng contract).
- `propose_change` là tín hiệu của Directory; Direct Entry dùng `change_request_create` (theo §3.2.4).
  Cả hai đều yêu cầu `pii_view` để đọc baseline.
- Không sửa export/P1/HF-C/reporting. Không apply migration/DB, không Production, không deploy VPS,
  không merge main, không browser/UAT.

## Checklist UAT cho Owner (Owner tự chạy)

Chuẩn bị: một tài khoản có **đồng thời** `change_request_create` (mở được proposer ở Nhập liệu) /
`propose_change` (CTA ở Directory) **và** `pii_view`, có assignment hiệu lực; một reviewer có
`change_review` + scope `all`.

1. **Nhập liệu — tạo đề xuất đổi tên:** mở đợt `SUBMITTED` → "Yêu cầu thay đổi" → chọn loại
   "Thông tin cá nhân người lao động" → chọn 1 dòng → sửa **Họ tên** → nhập lý do → gửi. Kỳ vọng:
   tạo change-request `PENDING`, không lỗi.
2. **Directory — tạo đề xuất đổi tên:** tab "Người tôi tuyển"/"Dự án tôi quản lý" → dòng có nút
   "Đề xuất thay đổi" → chọn "Thông tin người lao động" → sửa **Họ và tên** → nhập lý do → gửi.
   Kỳ vọng: tạo `PENDING`; trường không đổi giữ nguyên (payload đầy đủ).
3. **Reviewer before/after:** mở yêu cầu → thấy dòng **Họ tên** before→after → duyệt. Kỳ vọng:
   `worker_details.display_name` đổi; danh sách/báo cáo hiển thị tên mới. Từ chối một yêu cầu khác →
   tên giữ nguyên.
4. **Thiếu `pii_view` (âm):** tài khoản `propose_change` nhưng không `pii_view` → Directory: target
   WORKER hiện thông báo "Cần quyền xem thông tin cá nhân…", **nút gửi bị vô hiệu hoá**. Nhập liệu:
   hiện `proposer-worker-unavailable`, nút gửi vô hiệu hoá.
5. **Thiếu `propose_change` (âm):** Directory: **không** có nút "Đề xuất thay đổi".
6. **OCC/conflict:** mở form đổi tên, trong khi đó dữ liệu đổi ở nơi khác → gửi → phải báo conflict và
   tải lại (không ghi đè im lặng).
7. **Audit:** kiểm tra `direct_entry_audit_events` ghi nhận quyết định duyệt/từ chối như hiện tại
   (không log PII trong app logs/UI lỗi).

## Chờ T0

Push branch fast-forward, **không** merge main. Dừng ở trạng thái chờ T0 review.
