# P3.1-HF-R1 — cảnh báo CCCD trùng khi chuyển bản nháp sang chờ duyệt

- Base: `feature/p3-1-hf-duplicate-cccd-report@b3bde22dd7d88c4be5ff69b670d9982d86177765` (hotfix T1B `P3_1_HF_DUPLICATE_CCCD_REPORT_LOCAL_PASS_AWAITING_T0_REVIEW`, đã push; `main` không chứa migration #74).
- Migration rule: #74 (`20261009100000_p3_1_hf_duplicate_cccd_reporting.sql`) chưa vào `main` và chưa apply Production, nên contract T1C được bổ sung vào **chính #74 trong commit mới** (không amend, không sửa #1–#73). Ledger giữ 74 migration.
- Mục tiêu: lưu hồ sơ/bản nháp **không bao giờ** báo lỗi hay hỏi gì vì CCCD trùng. Chỉ đúng một đường — `DRAFT → REVIEW` — mới kiểm tra và có thể yêu cầu xác nhận.

## DB status truth và mapping hiển thị

- Nguồn sự thật: `public.direct_entry_employment_status_events.status` với đúng ba giá trị `ON`, `UNCONFIRMED`, `OFF` (không thêm giá trị mới, không so sánh chuỗi tiếng Việt trong SQL).
- Predicate canonical (giống #74 report và worker directory): trạng thái mới nhất theo `order by st.version desc limit 1`.
- Fallback khi **không có event**: `coalesce(..., 'UNCONFIRMED')` — canonical DB default, nên hồ sơ chưa có event được xử lý như `UNCONFIRMED`.
- Predicate cảnh báo: `latest_status in ('ON', 'UNCONFIRMED')`. **Không** dùng `= 'ON'`, **không** cho `OFF` vào tập cảnh báo.
- Mapping nhãn cho modal nằm ở tầng TS (`EMPLOYMENT_STATUS_LABELS` trong `submission-duplicate-cccd-contract.ts`), SQL chỉ phát ra enum:
  - `ON` → `Đang làm việc`
  - `UNCONFIRMED` (kể cả thiếu event) → `Không xác định`
  - `OFF` → không bao giờ xuất hiện trong projection.
- Câu modal (`duplicateCccdModalMessage`): với `ON` là “…trùng với một NLĐ đang làm việc tại dự án {Tên dự án}.”, với `UNCONFIRMED`/thiếu event là “…trùng với một hồ sơ tại dự án {Tên dự án}.”; dòng trạng thái luôn kèm `Trạng thái hiện tại: …`. Tiêu đề `Phát hiện CCCD đã tồn tại`, câu hỏi `Bạn chắc chắn vẫn muốn trình duyệt hồ sơ này?`, hai nút `Quay lại kiểm tra` / `Vẫn trình duyệt`.

## Phạm vi match và invariant

- Một conflict hợp lệ ⇔ hai record có **cùng canonical national id** (`direct_entry_canonical_national_id`, 9/12 chữ số ASCII, giữ số 0 đầu, chuẩn hóa định dạng cũ), record đối chiếu **khác `entry_id`** hiện tại, **chưa soft-delete** (`deleted_at is null`), national id **có state/value hợp lệ** theo canonical helper, và status mới nhất là `ON`/`UNCONFIRMED`.
- **Không** loại trừ vì: cùng project, cùng recruiter, cùng team, cùng submission, cùng ngày bắt đầu. Same-project vẫn cảnh báo (test B11), khác project vẫn cảnh báo (B12); hai dòng khác nhau trong cùng submission vẫn cảnh báo lẫn nhau (B18).
- Loại self-match theo **immutable `entry_id`** (B14); soft-deleted (B15); national id null/empty/không canonical (B16); biến thể định dạng canonicalize về cùng CCCD vẫn cảnh báo (B17).
- Nhiều episode cùng một CCCD: chỉ record `ON`/`UNCONFIRMED` xuất hiện, mọi `OFF` bị bỏ (A8/A9); nếu **tất cả** episode trùng đều `OFF` thì transition chạy bình thường, không modal (A10/C24).
- Lịch sử: latest version quyết định — `ON → OFF` (A5) và `OFF → ON` bằng correction supersede (A6) đều theo version cao nhất; `ON → UNCONFIRMED` correction (A7) cũng vậy.

## Save vs review boundary

- Không đặt duplicate warning lên: create row, update row, paste/import, full-profile import, autosave, save draft, rehire. (C19/C20 chứng minh writer v1, import v2 và legacy batch đều lưu CCCD trùng thành công, submission vẫn `DRAFT`, và **không** còn raiser duplicate nào ở tầng nghiệp vụ.)
- Chỉ `DRAFT → REVIEW` chạy preflight + acknowledgement. `REVIEW → DRAFT` và `REVIEW → SUBMITTED` **không** chạy lại cảnh bao (C30); `DRAFT → REVIEW` lần sau (sau khi bị trả về) vẫn kiểm tra lại.
- Preflight chỉ phục vụ submission đang `DRAFT` (state khác → `22023`, C27).

## Server là nguồn sự thật: preflight + confirm

- `direct_entry_submission_duplicate_cccd_state(uuid)` (internal, revoked mọi role): nguồn sự thật duy nhất cho tập conflict + fingerprint (sha256 64 hex, chỉ sinh từ **entry_id + status**, không chứa CCCD/tên/project/UUID nào).
- `direct_entry_submission_duplicate_cccd_preflight(auth, app, submission)` (STABLE, `service_role`-only): cùng authority với transition (actor mapping + capability `submission_create` + own scope + đúng chủ submission), trả `submission_id`, `version` authoritative, `fingerprint`, `conflict_count` và `conflicts` (tối đa 20 item, thứ tự deterministic). Không mutation, không lock, không audit, không idempotency.
- `direct_entry_transition_submission_apply(...)` (internal, revoked mọi role): thân transition duy nhất, giữ nguyên actor/creator/ownership, OCC, no-op guard, non-empty guard, revision, audit APPLIED và idempotency của body cũ, thêm đúng một luật: khi `DRAFT → REVIEW` và `conflict_count > 0` thì acknowledgement (`fingerprint` + `count`) phải khớp tập conflict **được dò lại bên trong transaction** (sau `for update` trên submission), nếu không raise `22023 'duplicate cccd acknowledgement required'`.
- `direct_entry_transition_submission(...)` (6 tham số, **giữ nguyên chữ ký**): chỉ delegate sang thân dùng chung với acknowledgement `null` ⇒ không caller/overload nào bypass được; mọi code cũ không phải đổi.
- `direct_entry_transition_submission_duplicate_cccd_confirmed(...)` (8 tham số, `service_role`-only): chỉ nhận target `REVIEW`, fingerprint phải là 64 hex thường, count trong `1..1000`, rồi delegate với acknowledgement; trả `{status:"applied", submission_id, state, version}`.
- Client không bao giờ là nguồn sự thật: danh sách conflict, status, project, recruiter, tên hay một boolean `confirmed` đơn lẻ đều không được tin; server luôn dò lại.

## Zero residue, confirmation và idempotency

- Preflight và lựa chọn "Quay lại kiểm tra" để lại **zero residue**: submission vẫn `DRAFT`, version không tăng, không audit APPLIED, không revision, không idempotency row (C21/C22, `assertZeroResidue`).
- Xác nhận hợp lệ chạy đúng một lần: OCC vẫn bắt buộc, idempotency key vẫn bắt buộc, retry cùng key trả **exact replay**, double-click không tạo transition/audit thứ hai (C23/C28/C29).
- Verify sai (fingerprint giả, count sai, fingerprint uppercase, count = 0, fingerprint stale) → raise trước mọi write; transaction rollback nên không idempotency row, không audit, không revision, version không đổi (C24/C25). Client nhận 409 `DUPLICATE_CCCD_CONFIRMATION_REQUIRED` rồi preflight lại và xác nhận lại.
- Acknowledgement không bypass authority (NO_SCOPE/OUTSIDER/UNMAPPED fail-closed, C26/C27), không bypass state/version (no-op guard, OCC), không bypass chủ submission hay các validation khác của transition.
- Audit: khi DRAFT → REVIEW thành công **có** acknowledgement thì `changed_fields` vẫn là `['state','version']` và reason text ghi short code + count + 12 ký tự fingerprint; **không** ghi CCCD, tên NLĐ, tên dự án hay full conflict projection. Khi tập conflict rỗng, reason text giữ nguyên `Submission state transition` — chứng minh không dùng lại cảnh báo cũ (C24). "Quay lại" và preflight không ghi audit nào.

## Projection và biên PII

- Mỗi conflict item đúng 5 key: `conflict_ref` (12 hex opaque), `draft_display_name`, `project_display`, `employment_status` (`ON`/`UNCONFIRMED`), `cccd_last4`; `employment_status_label` do tầng TS sinh.
- Preflight trả đúng 5 key: `submission_id` (mã tham chiếu của chính yêu cầu, dùng làm key), `version`, `fingerprint`, `conflict_count`, `conflicts`.
- Không trả: CCCD đầy đủ, `employee_code`, tên/định danh của hồ sơ **đã tồn tại**, `entry_id` hay worker UUID, auth subject, email, capability/scope, raw audit reason, raw DB message. `submission_id` không phải dữ liệu hiển thị và không nằm trong conflict item.
- Bounded + deterministic: tối đa 20 item mỗi lần (`conflict_count <= 1000`), thứ tự theo `draft.first_work_date`, `draft.entry_id`, `other.first_work_date`, `other.entry_id`, de-duplicate theo cặp entry, client không N+1 query.

## API và UI

- `GET /api/direct-entry/submissions/[submissionId]/duplicate-cccd-preflight`: gate `DIRECT_ENTRY_API_ENABLED` chạy trước params/session/repository, UUID check, session server-side, actor mapping fail-closed, `Cache-Control: private, no-store`, taxonomy `UNAUTHENTICATED`, `ACTOR_NOT_AVAILABLE`, `SUBMISSION_ID_INVALID`, `SUBMISSION_DENIED`, `SUBMISSION_NOT_FOUND`, `SUBMISSION_TRANSITION_INVALID`, `SUBMISSION_UNAVAILABLE`; không lộ raw DB error. GET là đường đọc nên không có CSRF (đúng pattern read hiện có của Direct Entry); CSRF/same-origin vẫn nằm trên `POST .../transition` — nơi duy nhất mutation.
- `POST .../transition` nhận thêm đúng cặp key `duplicate_cccd_fingerprint` + `duplicate_cccd_count` khi target `REVIEW` (exact-key: 3 key cho đường cũ, 5 key cho đường xác nhận; cặp key bị từ chối với target khác). Repository định tuyến sang RPC confirmed; `22023` của tập conflict được map thành 409 `DUPLICATE_CCCD_CONFIRMATION_REQUIRED`.
- UI: `DirectEntryDuplicateCccdDialog` (Radix AlertDialog, tái dùng, không thêm framework) + nhánh preflight trong `DirectEntrySubmissionList`: bấm "Gửi duyệt" → preflight → `conflict_count = 0` mở confirm dialog cũ, `> 0` mở modal cảnh báo; "Vẫn trình duyệt" gửi acknowledgement; gặp 409 thì tự preflight lại và hiện lại modal với danh sách mới. Escape = quay lại, modal không tự submit khi đóng, nút có loading/disabled, double-click safe, responsive theo CSS hiện có, thông báo tiếng Việt, không raw SQLSTATE.

## Test và bằng chứng mutation

- Lane focused `test:p3-1-hf-r1-duplicate-cccd-submit-confirmation` — 25 test (17 DB + 5 contract + 3 repository) phủ A1–A10, B11–B18, C19–C30, D31–D37, đã đăng ký vào chain `pnpm test`.
- Bằng chứng mutation: `scripts/p3-1-hf-r1-duplicate-cccd-submit-confirmation-mutation.mjs` sửa từng đoạn trong #74 theo đúng 13 mutation yêu cầu, chạy lại lane focused ở mỗi lần và **bắt buộc lane đỏ**, sau đó khôi phục migration byte-for-byte (script tự so hash).
- Kết quả mutation: **13/13 RED**. Mutation 1 (`predicate chỉ nhận ON`) đỏ ở lần chạy đầu; 12 mutation còn lại đỏ ở lần chạy thứ hai (`MUTATION_START=1`) với tổng kết `mutation checks red: 12/12` và `migration restored byte-for-byte: true`, script exit 0. Không mutation nào để lane xanh.
- Rebaseline bắt buộc: #74 thêm 4 function (2 internal + 2 service-role) nên 2 lane inventory đổi `179/82/97` → `183/84/99` (`scripts/p1.6-i04c3-s01-db.test.mjs`, `scripts/p1.6-s04c-document-scope-lock-db.test.mjs`); lane #74 của T1B đổi assertion đếm tên `%duplicate%` thành đúng danh sách 5 hàm; test source-scan route transition nhận 2 RPC.

## Gates

- Gates: `pnpm exec next typegen` (exit 0), `pnpm typecheck` (exit 0 — 0 lỗi TS), `pnpm lint` (exit 0 — 0 error, 15 warning kế thừa từ các cohort trước), `pnpm docs:check` (6/6 ví dụ), `pnpm secrets:check` (sạch), `pnpm db:migrate -- --offline` (74 migration hợp lệ, `20261009100000_p3_1_hf_duplicate_cccd_reporting.sql` là migration cuối), `git diff --check` (exit 0), full `pnpm test` (exit 0 — 63 lane, **63/63** banner có trong log, 0 fail, bao gồm lane focused mới và mọi lane bị ảnh hưởng) và `next build --webpack` (exit 0, "Compiled successfully in 27.7s"). Như T1B, `pnpm build` trần (Turbopack) không chạy được trong worktree codex vì `node_modules` là junction trỏ ra ngoài project root; tuỳ chọn Webpack đã được tài liệu hoá trong `node_modules/next/dist/docs` là thứ được dùng thay thế.

