# P3 Access Surface Inventory — Mini BI

**Revision:** S04 (refresh after P1.6 W04-S04A + R1, P1.6-I03 production main integration, P1.5 live provider Phase B + report export HTML; production AI provider enabled).
**Auditor:** T1C (Library & Access Auditor) — read-only.
**Base:** `13719069979a717bb0375e3031e92b161dffba8d` (S03-R1 on `feature/p3-w01-access-inventory`).
**Inputs verified against five refs:**
- `origin/main @ 2045472` (current production runtime; prompt 1.1 integrated via `524d0c1`; review/history migration applied to DEV via `9977600` and Production project = cùng Supabase project; report export HTML with embedded charts on main; **AI provider enabled on production Vercel runtime** bởi Phase B env apply tại deployment `dpl_GnSkjrS5FANe73rVooc6enS9K6iQ` — Phase B code/config source vẫn nằm trên `feature/p1.5-live-integration @ 4392a4b` và chưa merge vào `origin/main`).
- `origin/feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` (P1.6-I03 production main integration handoff; I03 chỉ đồng bộ latest main, không thêm migration/RPC, không thay đổi semantics S04A-R1; merge commit `40263bb`; **W04-S04A-R1 commit `d780471` preserved** trên branch history; W04-S04A-R1 authority (DRAFT = `entry_own|entry_team|entry_admin`; SUBMITTED = `payment_edit`) giữ nguyên từ I03; **DB side committed on DEV**, route layer dùng Supabase cookie session + `auth.getUser()`).
- `origin/feature/p1.5-live-integration @ 4392a4b` (P1.5-W04B-S02B Phase B: production live reporting enabled — `AI_PROVIDER_KEY=live`, `AI_REPORTS_ENABLED=true`, `AI_MODEL_KEY=deepseek-flash`, `AI_PROMPT_VERSION=business-analysis-prompt/1.1`; status `WAITING_FOR_OWNER_LIVE_RUN` for Phase C one-report smoke; **code/config source on branch, not yet merged into `origin/main`**).
- `origin/feature/p1.5-g5-dev01 @ 9977600` (P1.5-G5-DEV01 apply review/history migration + DEV acceptance — phase trước đã có schema available trong production project = cùng Supabase instance).
- `origin/feature/app-nav-01a @ 7bd2ba8` (navigation registry; planned entry `direct-entry` already registered, no production route).

**P1.6 W03 + W04-S03A + S03B + S03CD + W04-S04A + R1 + P1.6-I03 (read-only evidence, not re-applied here):**
- `supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql` — applied on Supabase DEV (immutable).
- `supabase/migrations/20261003170000_p1_6_w03_submission_noop_guard.sql` — forward correction, applied on Supabase DEV (immutable).
- `supabase/migrations/20261003180000_p1_6_w04_s03a_actor_context.sql` — applied on Supabase DEV; thêm 1 application RPC `direct_entry_resolve_actor_context`.
- `supabase/migrations/20261003200000_p1_6_w04_s03cd_catalog_drafts.sql` — applied on Supabase DEV; thêm 2 application RPC `direct_entry_input_catalog` + `direct_entry_list_own_drafts`; replace `direct_entry_update_draft_row` forward-only.
- `supabase/migrations/20261003210000_p1_6_w04_s04a_payment_projection.sql` — applied on Supabase DEV; **không thêm table, không thêm RPC** (file head: "S04A extends existing RPC projections; it adds no tables or RPC inventory."); `create or replace` cho `direct_entry_input_catalog` (extend với active bank catalog) + `direct_entry_read_projection` (extend với payment projection). Comment dòng 2: "S04A extends existing RPC projections; it adds no tables or RPC inventory."
- `supabase/migrations/20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql` — forward-only correction applied on Supabase DEV (sau S04A); `create or replace function public.direct_entry_update_payment(...)` để align DRAFT audit capability với effective own/team/all scope; non-DRAFT vẫn retain `payment_edit` qua existing `direct_entry_assert_payment_document_access(..., 'payment_edit')`.
- **Migration count hiện tại (S04 post-apply):** **26 applied, 0 pending, 0 checksum mismatches** (verified tại `73b19a64cb7c587e4973214508ab0bb600201538`: 20 P0/P1/P1.5 base + 6 P1.6 migration; P1.6-I03 §Quality gates confirms dry-run 26/0/0).
- **Direct Entry application RPC count hiện tại:** **20 service-role EXECUTE-only** (17 W03 + 1 S03A + 2 S03CD; S04A + R1 chỉ `create or replace` 3 RPC đã có, không thêm mới; verified distinct names bằng `git ls-tree -r 73b19a64cb7c587e4973214508ab0bb600201538 supabase/migrations` + `grep "grant execute on function public.direct_entry_"` cho 20 distinct function names).
- **W04-S04A-R1 acceptance:** S04A synthetic DEV acceptance 19/19 PASS (active-bank catalog, all 4 payment states `omitted|unknown|intentionally_blank|provided`, version 0→1, updates, identical replay, changed-payload + stale-version conflicts, inactive bank rejection, out-of-scope denial, restricted projection masking); R1 PGlite SQL test (synthetic submission to `SUBMITTED`, no-`payment_edit` write denied) PASS; **W04-S04A/R1 = 40 tests pass** (P1.6-I03 §Quality gates). DEV acceptance actor + fixture grants no longer include `payment_edit`; draft payment updates vẫn pass + audit capability = `entry_own`.
- **W04-S04A-R1 authority (locked by `20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql`):**
  - **DRAFT** payment writes: `direct_entry_update_payment` authorize qua `direct_entry_assert_payment_document_access(p_auth_subject, p_app_user_id, v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date, v_entry.submission_id, 'payment_edit')` để lấy `v_scope` (`own|team|all`); `v_audit_capability = case when v_submission_state = 'DRAFT' then case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end else 'payment_edit' end`. UI enables payment editing cho `entry_own`; `payment_view` independently controls full vs masked projection.
  - **Non-DRAFT** (SUBMITTED) payment writes: vẫn qua existing `payment_edit` check, retain audit capability `'payment_edit'`.
  - **Masked projection:** khi actor không có `payment_view` thì route trả masked account number + version only; copy/cut/context-menu bị block trên masked-entry inputs; UI không persist payment values trong browser storage.
- **P1.6 route surface (S04):** 6 route files / 7 methods committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` — `GET /api/direct-entry/session`, `POST /api/direct-entry/batches`, `GET /api/direct-entry/entries/[entryId]`, `PATCH /api/direct-entry/entries/[entryId]`, `GET /api/direct-entry/catalog`, `GET /api/direct-entry/drafts`, `PATCH /api/direct-entry/entries/[entryId]/payment` (mới ở S04A). Tất cả gated by `DIRECT_ENTRY_API_ENABLED=true`; sanitized `404 NOT_FOUND` when off. **Chưa merge main, chưa production enabled.**
- **P1.6-I03 integration evidence:** `docs/handoffs/p1.6-i03.md` (commit `73b19a64cb7c587e4973214508ab0bb600201538`) confirms integration với `origin/main @ 2045472` qua merge commit `40263bb`; conflict resolution ở `package.json` + `pnpm-lock.yaml` (giữ P1.6 client stack + grid pin + main AI/export scripts); 459 main/report tests + 82 AI server + 4 HTML report export + 30 App Shell/navigation tests pass; `pnpm typecheck` / `lint` / `build` / `docs:check` / `secrets:check` / `git diff --check` all PASS. **Direct Entry vẫn chỉ trên `feature/p1.6-integration`; `origin/main` vẫn ở `2045472`.**
- **Tất cả Direct Entry table DML** vẫn revoked từ `public, anon, authenticated, service_role` (W03 foundation). Application chỉ gọi application RPC qua server role.

**P1.5-G5-DEV01 evidence (read-only, schema already in production project = cùng Supabase):**
- `feature/p1.5-g5-dev01 @ 9977600` — apply `supabase/migrations/20261001180000_p1_5_ai_report_review_history.sql` lên Supabase DEV (1 áp dụng mới; post-apply dry-run: 22 applied, 0 pending, 0 checksum mismatch).
- DEV acceptance harness `scripts/g5-dev01-acceptance.mjs`: 14/14 pass (grants EXECUTE-only, search_path='', RLS / append-only, capability, approve / reject, OCC, idempotent, conflict, actor / cursor isolation, keyset pagination, audit rollback, history projection an toàn).
- Cleanup namespace `g5dev01-*`: 0 leftover, append-only trigger phục hồi, reporting baseline không đổi, không đụng W03 direct-entry.
- Handoff `docs/handoffs/p1.5-g5-dev01.md` (migration result + live checks + cleanup/baseline + deferred + checkpoint cho provider-live).
- **Production project = cùng Supabase project với DEV** (theo `p1.5-w04b-s02b.md` §Sanitized config: "Production dùng CÙNG Supabase project với DEV — đã so khớp") → review/history schema có sẵn ở production project ngay từ DEV apply. Không cần migration bổ sung.

**P1.5-I02 + I03 + W04B-S02B + report export (evidence refreshed in S04):**
- `origin/feature/p1.5-live-integration @ 524d0c1` (P1.5-I03, **ancestor của `origin/main @ 2045472`**) — port prompt 1.1 (team comparison + anomaly + monitoring limitations): `PROMPT_RULES_V1_1` (R14/R15/R16), `SYSTEM/DEVELOPER_INSTRUCTION_V1_1`, `PROMPT_MANIFEST_V1_1`, `DEFAULT_PROMPT_VERSION=1.1`, `MANIFESTS={1.0,1.1}`. 126/126 gateway tests pass. Không bịa anomaly khi thiếu baseline/comparable; team mapping thiếu ⇒ limitation; không PII/kỷ luật/sa thải; output contract `business-analysis/0.1`. Frozen job lưu đúng prompt version (DEFAULT 1.1); mismatch fail-closed. Handoff `docs/handoffs/p1.5-i03.md`.
- `origin/feature/p1.5-live-integration @ f7e41dd` (P1.5-I02) — live provider adapter integrated với conditional env gate: `AI_PROVIDER_KEY=live` + `AI_PROVIDER_ALLOWED_HOSTS` hợp lệ không rỗng ⇒ live; thiếu ⇒ `AI_CONFIG_REQUIRED` fail-closed. Scripted vẫn cấm production/preview. Handoff `docs/handoffs/p1.5-i02.md` (provenance + env matrix + migration status + deferred + checkpoint: **Owner** nhập `URL` / `model` / `API key` qua UI; **Operator** cấu hình `AI_PROVIDER_ALLOWED_HOSTS` ở server env).
- **Report export HTML on main (no new endpoint, projection thêm aggregate).** `origin/main @ 2045472` (`feat(ai): export reports with embedded charts`) thêm `src/lib/ai-report/report-export-server.ts` (server-side projection từ analysis packet — top-10 dimensions across 5 keys, 104 LOC), `src/lib/ai-report/report-export.ts` (HTML report building, 191 LOC), `report-export.test.mjs` (4 tests pass), update `ai-report-panel.tsx` UI (53 LOC thêm download HTML) + `report-contract.ts` (8 LOC thêm) + `analysis/route.ts` (8 LOC, thêm `export_data: exportData` vào projection). Route `GET /api/ai/reports/[jobId]/analysis` (`api:005`) **đã có từ trước**; **không tạo route mới**; chỉ thêm aggregate `export_data` vào analysis projection để client dựng HTML report. Verify: `git show 2045472 -- src/app/api/ai/reports/[jobId]/analysis/route.ts` chỉ diff `+import` + `+const exportData = await loadReportExportData(jobId, gateway.actor_ref);` + `+export_data: exportData,` — projection extension, không phải endpoint mới.
- **AI provider production đã LIVE (Phase B).** `feature/p1.5-live-integration @ 4392a4b` (`P1.5-W04B-S02B Phase B: enable Production live reporting`) apply `AI_PROVIDER_KEY=live`, `AI_MODEL_KEY=deepseek-flash`, `AI_REPORTS_ENABLED=true`, `AI_PROMPT_VERSION=business-analysis-prompt/1.1`, `AI_INLINE_WORKER_ENABLED=false`, `AI_WORKER_TOKEN` (Secret, random base64url 32 byte), `AI_POLICY_*` bảo thủ lên Vercel Production environment. Deployment mới `dpl_GnSkjrS5FANe73rVooc6enS9K6iQ`, alias `bi.hrpartner.vn` (giữ nguyên), source base `origin/main @ 837d84a` (clean; **KHÔNG** deploy feature branch). Production dùng **CÙNG Supabase project** với DEV. Sanitized config xác minh server-side: `config_id=pilot-provider`, `version=1`, `profile=openai-compatible`, `model=deepseek-flash`, `host=api.deepseek.com`, `status=active`, `verified=yes`. Status: **`WAITING_FOR_OWNER_LIVE_RUN`** (Phase C = Owner bấm "Tạo báo cáo" đúng một lần). Source/runtime tension: `origin/main @ 2045472` `src/lib/ai/gateway/server/config.mjs` vẫn comment cũ "Live provider luôn bị chặn cho tới G4A ⇒ AI_PROVIDER_DISABLED" từ `f05991f` (`P1.5-W04-R1`); comment này lỗi thời vs runtime Phase B, sẽ update khi merge `feature/p1.5-live-integration` → main (T1A scope, không thuộc task này).
- **Phân vai Owner / Operator (S03 errata #3 fixed, vẫn đúng trong S04):** **Owner** nhập `URL` / `model` / `API key` qua UI (`api:007` `POST /api/ai/settings`, hiện đang dùng `pilot-admin` Basic Auth để Save/Test/Activate trên production preview); **Operator** cấu hình `AI_PROVIDER_ALLOWED_HOSTS=api.deepseek.com` ở server env (outbound guard). Phase B đã hoàn tất cả env, nhưng Phase C one-report smoke vẫn pending Owner click.
- **P1.5 vẫn chờ formal J01 closure** — J01 sẽ đóng sau khi Phase C PASS + J01 acceptance matrix pass (T1A + T0).
- `decision:ai-self-approval` (`api:006`) vẫn `PENDING_DECISION`; không tự quyết ở task docs-only này. `ai.report.review` vẫn capability riêng, không map sang `change_review` (xem §7.1 + §11.5).

**Owner map (per task brief):**
- **P1.5 = T1A.** (AI gateway, settings, review/history.)
- **P1.6 = T1B.** (Direct-entry, grid/typeahead, route/UI/worker/cutover.)
- **P3 inventory / audit = T1C.** (task này.)

**Errata fixed trong S03, vẫn đúng trong S04 (xem `docs/handoffs/p3-w01-s03.md` + `docs/handoffs/p3-w01-s04.md`):**
1. **Zod** đã có sẵn trong `package.json` (`zod ^4.6.5`, P0 era) và đang dùng ở `src/lib/env.ts`, `src/lib/contracts/daily-recruitment-breakdown.ts`, `src/lib/analytics/contracts/business-analysis.ts`, `src/lib/analytics/contracts/analysis-packet.ts`. Direct Entry W01/W02 dùng custom validators (`validateClientBusinessPayload`, `validateEmployeeCode`, `validateWorkerDetails`); không đề xuất rewrite chỉ để đồng nhất. Inventory **không** nói Zod "được P1.6-W02 đưa vào".
2. `direct_entry_resolve_actor_context` hiện **không tự ghi audit event**. Nếu plan cần login/session audit, giữ là future P3 slice (slice 5 trong cutover plan) — không mô tả như evidence đã có.
3. `PILOT_ACTOR_REF = "pilot-admin"` hard-coded áp dụng cho **P1.5 AI report path** (`api:002`–`api:012` + `repo:004`–`repo:009`). Direct Entry S03A+ dùng Supabase cookie session + `auth.getUser()` + `direct_entry_resolve_actor_context`. **Không gộp** hai boundary này thành một lỗi chung.

**Hard guardrails (unchanged từ S01):** no runtime / schema / RPC edits, no migrations applied, no proxy / auth change. **Tài liệu này chỉ rà — không phải G1 PASS, không phải design decision, không thay thế audit của T1A / T1B.** Những phát hiện dạng GAP / PENDING_P1.6 / PENDING_DECISION cần được T0 đưa vào decision matrix riêng cho G1.

---

## How to read this document

Mỗi surface có một row với 9 cột:

| Column | Meaning |
|---|---|
| **ID** | Stable identifier `DOMAIN.NUMBER` (vd `sortable:001`). Dùng để tham chiếu trong code review, audit, G1 acceptance. |
| **Path / Table / RPC** | URL (Server Component hoặc API), tên bảng, hoặc signature RPC. |
| **R / W** | Read hay write (R / W / RW). |
| **Current gate** | Cách cổng hiện tại bảo vệ surface này (Basic Auth, token, same-origin, flag env, RLS, …). |
| **Actor hiện tại** | Actor mặc định đang ghi/đọc (vd. `PILOT_ACTOR_REF = "pilot-admin"`, `service_role`, …). |
| **P3 capability / scope dự kiến** | Capability vocabulary từ `docs/contracts/p1.6-auth-capabilities-v1.md` + scope `own / team / all`. P3 sẽ quyết định final mapping. |
| **Direct-URL / API bypass risk** | Mức rủi ro nếu attacker bypass UI (đánh trực tiếp URL / API). Đánh giá theo 3 mức: HIGH (bypass = full R/W), MED (bypass = partial / scoped), LOW (bypass = same surface as before). |
| **Owner** | Phase / agent chịu trách nhiệm current gate (T0, T1A, T1B, T2, …). |
| **Status** | `COVERED` (gate current đủ cho pilot, P3 chỉ refine) / `GAP` (gate current không đủ, P3 phải thiết kế) / `PENDING_P1.6` (chưa có code, contract đã có) / `PENDING_DECISION` (cần T0 quyết trước khi P3 thiết kế). |

---

## 1. Page routes và direct URLs

Server Components trong `src/app/**`. Không có middleware (Next 16) thêm ngoài `src/proxy.ts`.

| ID | Path | R/W | Current gate | Actor hiện tại | P3 capability / scope dự kiến | Direct-URL bypass risk | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| page:001 | `/` | R | **không gate** (là landing public — không vào DB, không cấu hình) | n/a | n/a — landing không cần capability | LOW (landing không có dữ liệu nhạy cảm) | T0 | COVERED |
| page:002 | `/dashboard` | R | proxy Basic Auth + dashboard server fetch qua `service_role` | `PILOT_ACTOR_REF` (via basic-auth proxy → service-role server client) | `report.view` + scope `all` (boD) hoặc `own`/`team` (staff/leader) | MED — bypass UI có thể đánh URL trực tiếp; chỉ chặn bởi Basic Auth | T0 / T1A | COVERED (current gate) / GAP (P3 cần mapping capability) |
| page:003 | `/pipeline-check` | R | proxy Basic Auth + env flag `PIPELINE_CHECK_ENABLED=true` (production) + `notFound()` khi tắt + `service_role` đọc | `PILOT_ACTOR_REF` qua proxy | `ops.view_pipeline` + scope `all` | MED — bypass UI bị chặn bởi Basic Auth nhưng **không có row-level filter**; ai cũng thấy hết nguồn | T0 / T1B | COVERED (gate) / GAP (P3 cần scoping per-source) |
| page:004 | `/dashboard/loading` | R | spinner fragment, không data | n/a | n/a | LOW | T0 | COVERED |
| page:005 | `/direct-entry` (P1.6) | RW | **CHƯA CÓ TRÊN MAIN** / `app-nav-01a` registry = `planned`. Trên `p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` đã có W04-S02 fixture UI shell page (`src/app/direct-entry/page.tsx`, mode `demo`/`live`); W04-S03A/S03B/S03CD commit session/create-batch/entry-read/catalog/own-drafts/draft-update route (xem §7.2); **W04-S04A-R1** commit payment PATCH route/projection/UI. Toàn bộ Direct Entry vẫn **chưa merge `main`**, chưa production enabled; S04A-R1 payment authority locked theo `20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql` (DRAFT = `entry_own|entry_team|entry_admin`; SUBMITTED = `payment_edit`). Document upload, submit/review/change/status vẫn pending. | resolved cookie session (live) / n/a (demo) | `entry_own` / `entry_team` / `entry_admin` per actor + scope theo row; `payment_edit` cho SUBMITTED payment; `change_review` cho change-request approve/reject (second-party enforced) | HIGH — đây là entry chính của mutation mới, chưa có gate production | T1B | PENDING_P1.6 (route/UI vẫn trên feature branch; W04-S04A-R1 committed on `feature/p1.6-integration`) |

### Page layout / shell

| ID | Component | Current gate | P3 capability dự kiến | Bypass risk | Status |
|---|---|---|---|---|---|
| page:layout:001 | `app/dashboard/layout.tsx` (chỉ trên `app-nav-01a`) | proxy Basic Auth (matcher `/dashboard/:path*`) | kế thừa `report.view` | MED — chỉ là layout wrapper, không cần capability riêng | COVERED |
| page:layout:002 | `app/pipeline-check/layout.tsx` (chỉ trên `app-nav-01a`) | proxy Basic Auth + `PIPELINE_CHECK_ENABLED` | kế thừa `ops.view_pipeline` | MED | COVERED |

> **Note.** `app-nav-01a` chưa được merge vào `main`. Layout wraper không có trên commit `45ca016`. P3 chỉ cần quan tâm đến matcher của `proxy.ts`, không cần quan tâm wrapper của shell.

---

## 2. API routes / methods

App Router `route.ts` trong `src/app/api/**`. Tất cả 12 AI route dưới đây đều có `src/proxy.ts` matcher bao phủ (trừ `src/proxy.ts` matcher `/api/reporting/:path*` — route này **không tồn tại** trong main, đây là matcher phòng hờ). Direct Entry routes liệt kê ở §7.2 (7 route files / 7 methods đã commit trên `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` bao gồm PATCH payment của S04A; **chưa merge `main`**, **chưa production enabled**).

**P1.5 report export HTML evidence on main:** `GET /api/ai/reports/[jobId]/analysis` (`api:005`) đã có từ trước; `origin/main @ 2045472` chỉ thêm aggregate `export_data` vào analysis projection (`+import` + `+const exportData = await loadReportExportData(...)` + `+export_data: exportData`), **không tạo route mới**.

| ID | Method + Path | R/W | Current gate | Actor hiện tại | P3 capability / scope | Bypass risk | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| api:001 | `GET /api/ai/reports/capability` | R | proxy + flag `AI_REPORTS_ENABLED` + service-role read provider config | `PILOT_ACTOR_REF` qua proxy | `ai.capability.view` (read-only; không cần scope `team`) | LOW (chỉ bật/tắt flag) | T1A | COVERED (gate) / GAP (P3 capability mapping) |
| api:002 | `POST /api/ai/reports` (enqueue) | W | proxy + flag + `checkSameOriginRequest` (anti-CSRF) + rate-limit + service-role enqueue qua RPC `ai_report_enqueue` | `PILOT_ACTOR_REF` qua `gateway.actor_ref` | `ai.report.create` + scope theo caller (chưa phân biệt staff/leader/admin) | MED — CSRF đã chặn, nhưng 1 credential = full enqueue | T1A | GAP — actor_ref hiện cứng `"pilot-admin"`; P3 phải map sang `actor_ref` thật |
| api:003 | `GET /api/ai/reports/history` | R | proxy + flag + cursor pagination + service-role `ai_report_history` | `PILOT_ACTOR_REF` (hard-coded) | `ai.report.history.view` + scope theo row ownership | MED — ai cũng có credential thì thấy hết history của `pilot-admin` (hiện chỉ có 1 actor) | T1A | GAP — chưa scope theo row |
| api:004 | `GET /api/ai/reports/[jobId]` | R | proxy + flag + service-role getStatus | `PILOT_ACTOR_REF` qua `gateway.actor_ref` | `ai.report.status.view` + scope `own` / `team` / `all` theo row | MED — bất kỳ actor nào có credential đều đọc được jobId bất kỳ | T1A | GAP — chưa scope per-row |
| api:005 | `GET /api/ai/reports/[jobId]/analysis` | R | proxy + flag + service-role getStatus (analysis nằm trong projection) | `PILOT_ACTOR_REF` | `ai.report.analysis.view` + scope theo row ownership | HIGH — analysis có thể chứa executive references, limitation, findings. Hiện không filter theo actor | T1A | GAP |
| api:006 | `POST /api/ai/reports/[jobId]/review` | W | proxy + flag + `checkSameOriginRequest` + service-role review (approve / reject / regenerate) | `PILOT_ACTOR_REF` (hard-coded) | `ai.report.review` + scope `own` / `team` / `all` (riêng `approve` là sub-action của `ai.report.review`, **không** map sang `change_review` — `ai.report.review` là capability riêng, độc lập với direct-entry vocab; xem errata + `decision:ai-self-approval` §11.5) | HIGH — 1 credential duy nhất có thể approve/reject bất kỳ job nào | T1A | GAP — actor cứng `"pilot-admin"`, không phân biệt self-review vs second-party |
| api:007 | `POST /api/ai/settings` | W | proxy + flag `AI_SETTINGS_ENABLED` + rate-limit + CSRF + service-role save config | `PILOT_ACTOR_REF` (hard-coded) | `ai.settings.write` (chỉ owner role) | HIGH — single session ghi được config, xoay API key, v.v. | T1A | GAP — P3 phải gate bằng capability `ai.settings.write` |
| api:008 | `GET /api/ai/settings` | R | proxy + flag + service-role read projection (đã sanitize, không lộ secret) | `PILOT_ACTOR_REF` | `ai.settings.view` | MED — đã sanitize nhưng metadata (provider profile, model) có thể nhạy | T1A | COVERED (sanitize) / GAP (capability mapping) |
| api:009 | `POST /api/ai/settings/test` | W | proxy + flag + CSRF + outbound guard (SSRF) + service-role test connection | `PILOT_ACTOR_REF` | `ai.settings.write` (test trước khi lưu — capability phải bằng write) | HIGH — có thể bật outbound call ra provider; vẫn nằm sau SSRF guard | T1A | COVERED (SSRF) / GAP (capability mapping) |
| api:010 | `POST /api/ai/settings/rotate` | W | proxy + flag + rate-limit + CSRF + service-role rotate (tạo version mới, không giải mã key cũ) | `PILOT_ACTOR_REF` | `ai.settings.write` | HIGH — đổi API key mới | T1A | GAP |
| api:011 | `POST /api/ai/settings/activate` | W | proxy + flag + rate-limit + CSRF + service-role activate | `PILOT_ACTOR_REF` | `ai.settings.write` | HIGH — kích hoạt config (ghi đè active cũ) | T1A | GAP |
| api:012 | `POST /api/ai/settings/disable` | W | proxy + flag + rate-limit + CSRF + service-role disable | `PILOT_ACTOR_REF` | `ai.settings.write` | HIGH — tắt toàn bộ AI provider | T1A | GAP |
| api:013 | `POST /api/ai/worker/run` | W | proxy + header `x-ai-worker-token` (constant-time compare) + service-role claim | service token (`AI_WORKER_TOKEN`), không phải human user | n/a — worker token là system identity, không thuộc RBAC | MED — token leak = full control của queue | T1A | COVERED (token compare) / GAP (P3 cần rotate policy + audit) |

> **Lưu ý về API không tồn tại.** Matcher của `proxy.ts` có `/api/reporting/:path*` nhưng trên `origin/main` không có route `/api/reporting/*`. Đây là **dead rule** — proxy đang gate một path không có handler. **GAP** vì nếu sau này thêm `/api/reporting` mà không kiểm tra proxy, có thể tưởng là gated trong khi thực tế route tự quyết định auth.

---

## 3. Tables / views / RPC / functions và grants

Đọc từ 20 migration trong `supabase/migrations/202610*.sql`. Tất cả revoke `public, anon, authenticated`; grant `service_role` (RLS bypass). **Không có policy nào** trong migrations — chỉ enable RLS + revoke grant (deny-by-default).

### 3.1 Foundation tables (P0)

| ID | Table | R/W | RLS | Policies | Public/anon/auth grant | service_role grant | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| db:t:001 | `public.data_sources` | RW | enabled | none (deny-by-default) | revoke all | all | T1B | COVERED (RLS + revoke) |
| db:t:002 | `public.sync_runs` | RW | enabled | none | revoke all | all | T1B | COVERED |
| db:t:003 | `public.daily_recruitment_counts` | RW | enabled | none | revoke all | all | T1B | COVERED |
| db:t:004 | `public.sync_errors` | RW | enabled | none | revoke all | all | T1B | COVERED |
| db:t:005 | `public.daily_recruitment_breakdown` | RW | enabled | none | revoke all | all | T1B | COVERED |

### 3.2 Reporting views (P1)

| ID | View | R | RLS | Grants | Owner | Status |
|---|---|---|---|---|---|---|
| db:v:001 | `public.reporting_latest_sync_runs_v01` | R | inherits base tables (deny by default) | revoke all + grant select to service_role | T1B | COVERED |
| db:v:002 | `public.reporting_sources_with_current_facts_v01` | R | inherits | revoke all + grant select to service_role | T1B | COVERED |
| db:v:003 | `public.reporting_dimension_options_v01` | R | inherits | revoke all + grant select to service_role | T1B | COVERED |

### 3.3 RPC / functions (P0)

| ID | RPC | R/W | Grant | Owner | Status |
|---|---|---|---|---|---|
| db:f:001 | `public.set_updated_at()` trigger helper | RW | revoke all, grant execute to service_role | T1B | COVERED |
| db:f:002 | `public.upsert_daily_recruitment_run_v01(...)` | W | service_role | T2 (n8n) | COVERED |
| db:f:003 | `public.reject_daily_recruitment_snapshot_v01(...)` | W | service_role | T2 | COVERED |
| db:f:004 | `public.replace_daily_recruitment_snapshot_v01(jsonb)` | W | service_role | T2 | COVERED |
| db:f:005 | `public.replace_daily_recruitment_breakdown_snapshot_v02(jsonb)` | W | service_role | T2 | COVERED |
| db:f:006 | `public.expand_daily_recruitment_breakdown_v02(jsonb)` | RW | service_role | T2 | COVERED |
| db:f:007 | `public.reject_daily_recruitment_breakdown_snapshot_v02(...)` | W | service_role | T2 | COVERED |
| db:f:008 | `public.record_recruitment_source_failure_v01(jsonb)` | W | service_role | T2 | COVERED |
| db:f:009 | `public.upsert_daily_recruitment_run_v02(...)` | W | service_role | T2 | COVERED |
| db:f:010 | `public.recruitment_dimension_display/key(text)` | R | service_role | T2 | COVERED |
| db:f:011 | `public.recruitment_provider_type_key/display/text` | R | service_role | T2 | COVERED |
| db:f:012 | `public.recruitment_employment_type_key/display/text` | R | service_role | T2 | COVERED |

### 3.4 AI gateway tables + RPC (P1.5)

| ID | Table | R/W | RLS | Grants | Owner | Status |
|---|---|---|---|---|---|---|
| db:t:006 | `public.ai_report_jobs` | RW (insert, update, no delete) | enabled | revoke + grant select/insert/update to service_role | T1A | COVERED |
| db:t:007 | `public.ai_report_revisions` | R (insert only via RPC) — **append-only since G5-DEV01** | enabled | revoke + grant select/insert to service_role; **`revoke update on table public.ai_report_revisions from service_role`** per `20261001180000_p1_5_ai_report_review_history.sql` | T1A | COVERED_DEV (migration applied on Supabase DEV by G5-DEV01, không phải provider-live / production enabled) |
| db:t:008 | `public.ai_report_usage` | R (insert) | enabled | revoke + grant select/insert to service_role | T1A | COVERED |
| db:t:009 | `public.ai_report_audit_events` | R (insert, no UPDATE by human) | enabled + `ai_report_audit_immutable()` trigger | revoke + grant select/insert to service_role | T1A | COVERED |
| db:t:010 | `public.ai_provider_configs` | RW | enabled | revoke + grant select/insert/update to service_role | T1A | COVERED |
| db:t:011 | `public.ai_provider_config_audit_events` | R (insert) | enabled + `ai_provider_config_audit_immutable()` trigger | revoke + grant select/insert to service_role | T1A | COVERED |

| ID | RPC | R/W | Grant | Owner | Status |
|---|---|---|---|---|---|
| db:f:013 | `public.ai_report_enqueue(text, jsonb, ..., integer)` | W | service_role | T1A | COVERED |
| db:f:014 | `public.ai_report_claim(text, integer, integer)` | RW | service_role | T1A | COVERED |
| db:f:015 | `public.ai_report_mark_stage(uuid, uuid, text)` | W | service_role | T1A | COVERED |
| db:f:016 | `public.ai_report_complete(uuid, uuid, jsonb, jsonb)` | W | service_role | T1A | COVERED |
| db:f:017 | `public.ai_report_fail(uuid, uuid, text, text, timestamptz, text)` | W | service_role | T1A | COVERED |
| db:f:018 | `public.ai_report_record_usage(jsonb)` | W | service_role | T1A | COVERED |
| db:f:019 | `public.ai_report_status(uuid)` | R | service_role | T1A | COVERED |
| db:f:020 | `public.ai_report_regenerate(uuid, text, text)` | W | service_role | T1A | COVERED |
| db:f:021 | `public.ai_report_recover_stale(integer)` | W | service_role | T1A | COVERED |
| db:f:022 | `public.ai_report_policy_context(text, integer)` | R | service_role | T1A | COVERED |
| db:f:023 | `public.ai_report_audit_immutable()` trigger | RW | service_role | T1A | COVERED |
| db:f:024 | `public.ai_provider_config_audit_immutable()` trigger | RW | service_role | T1A | COVERED |

#### 3.4.1 P1.5-G5-DEV01 — review / history RPCs (NEW in S02-R1)

`feature/p1.5-g5-dev01 @ 287514f` apply `supabase/migrations/20261001180000_p1_5_ai_report_review_history.sql` lên Supabase DEV (1 áp dụng mới; post-apply dry-run: 22 applied, 0 pending, 0 checksum mismatch). DEV acceptance harness `scripts/g5-dev01-acceptance.mjs` 14/14 pass (grants EXECUTE-only, search_path='', RLS / append-only, capability, approve / reject, OCC, idempotent, conflict, actor / cursor isolation, keyset pagination, audit rollback, history projection an toàn). Cleanup namespace `g5dev01-*`: 0 leftover, append-only trigger phục hồi, reporting baseline không đổi, không đụng W03 direct-entry. **Quan trọng:** G5-DEV01 = DEV acceptance cho review/history migration. **Chưa phải provider-live / production enabled.**

4 RPC mới (service-role EXECUTE-only; revoke PUBLIC / anon / authenticated):

| ID | RPC | R/W | Capability scope (per migration) | Status |
|---|---|---|---|---|
| db:f:p1.5-G5:001 | `public.ai_report_review_capability()` | R | returns capability required to approve / reject a draft revision | COVERED_DEV (G5-DEV01, không provider-live) |
| db:f:p1.5-G5:002 | `public.ai_report_approve_revision(uuid, integer, text)` | W | capability check + OCC on `(job_id, expected_revision_number)` + actor / cursor isolation; idempotent | COVERED_DEV |
| db:f:p1.5-G5:003 | `public.ai_report_reject_revision(uuid, integer, text, text)` | W | capability check + OCC + reject reason (non-empty) + audit rollback on conflict | COVERED_DEV |
| db:f:p1.5-G5:004 | `public.ai_report_history(text, text, integer)` | R | keyset pagination (`actor_ref` cursor + `before` timestamp) + sanitized history projection | COVERED_DEV |

> **Append-only change for `ai_report_revisions`.** Migration revoke `update on table public.ai_report_revisions from service_role`. Trước G5-DEV01, table được grant `select, insert, update` to `service_role`. Sau G5-DEV01, table chỉ còn `select, insert` to `service_role`; `update` phải đi qua `ai_report_approve_revision` / `ai_report_reject_revision` (đã OCC + idempotent + actor / cursor isolation). Đây là **append-only trigger phục hồi**, không phải provider-live change.
>
> **P3 G1 implication.** Khi P3 thiết kế `ai.report.review` capability matrix, route `POST /api/ai/reports/[jobId]/review` (api:006) sẽ gọi `ai_report_approve_revision` / `ai_report_reject_revision` thay vì mutate trực tiếp `ai_report_revisions`. Nếu T0 cấm AI self-approval, route cần check `actor_ref(job.actor_ref) ≠ actor_ref(reviewer)` — decision `decision:ai-self-approval` (§11.5) vẫn `PENDING_DECISION`.

> **Migrate P1.6 đã apply DEV.** Trên `p1.6-integration @ 27c6845` chỉ thêm W04-S01 smoke (compile grid + typeahead); không migration mới. Tất cả DB-side P1.6 đã chuyển sang `COVERED_DEV_FAST_TRACK` (xem §3.5). Route/UI production vẫn `PENDING_P1.6`.

### 3.5 P1.6 foundation (W03 + forward correction) — applied DEV only

**Migration files (immutable, applied on Supabase DEV, see `docs/handoffs/p1.6-w03.md`):**
- `supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql` — foundation.
- `supabase/migrations/20261003170000_p1_6_w03_submission_noop_guard.sql` — forward correction.

**Registry state (DEV, post-apply):** 21 applied migrations, 0 pending, 0 checksum mismatches.
**DEV acceptance:** `pnpm run test:p1.6-w03-g3-dev` → 95 checks pass (`scripts/p1.6-w03-g3-dev-manifest.json`); `cleanupVerified=true`, `baselineUnchanged=true`. **Local PGlite tests only** (`pnpm run test:p1.6-w03`, 19/19) — they do not substitute for full Supabase DEV acceptance.

**Boundary contract (locked by T0):** RPC-only writes. Browser roles receive no table DML. All new tables enable + **force** RLS; table privileges are revoked from `PUBLIC, anon, authenticated, service_role`. Runtime writes and restricted reads go through `SECURITY DEFINER` RPCs. The only role granted `EXECUTE` on the application RPCs is `service_role`. Internal helpers and trigger functions are not executable by application roles. `service_role` has no direct table privileges.

**Self-review denial (W03):** `direct_entry_approve_change_request` and `direct_entry_reject_change_request` enforce `change_review` capability + each item scope + **proposer cannot review own request** (separate check inside `direct_entry_decide_change_request`).

**Current-document view (W03):** `public.direct_entry_current_documents` is `security_invoker=true`. It resolves the latest append-only upload event, filters to `READY+CLEAN`, then chooses the highest valid version per `(candidate, document_type)`. A pending or rejected replacement therefore leaves the previous ready/clean version current.

#### 3.5.1 P1.6 W03 foundation / core tables (25) — RLS forced, table DML revoked

All 25 tables in the `v_table` array (per `20261002170000_p1_6_direct_entry_foundation.sql`): `direct_entry_app_users`, `recruiters`, `teams`, `recruiter_aliases`, `recruiter_provider_memberships`, `recruiter_team_memberships`, `direct_entry_app_user_recruiter_links`, `direct_entry_capability_grants`, `direct_entry_scope_grants`, `direct_entry_projects`, `direct_entry_banks`, `direct_entry_submissions`, `direct_entry_candidates`, `direct_entries`, `direct_entry_payments`, `direct_entry_employment_status_events`, `direct_entry_document_versions`, `direct_entry_document_events`, `direct_entry_restricted_reasons`, `direct_entry_revisions`, `direct_entry_submission_revisions`, `direct_entry_change_request_revisions`, `direct_entry_change_requests`, `direct_entry_change_request_items`, `direct_entry_audit_events`. (`direct_entry_rpc_idempotency` is the 26th table — see 3.5.2 — and is part of the same revocation/force-RLS block.)

| ID | Table | Group | R/W | RLS | Policies | service_role | Status |
|---|---|---|---|---|---|---|---|
| db:t:p1.6:001 | `public.recruiters` | shared identity (P1.5-W02) | RW | enabled + forced | none (deny by default; only RPC writes) | revoke all + EXECUTE only via `direct_entry_*` | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:002 | `public.teams` | shared identity (P1.5-W02) | RW | enabled + forced | none | revoke all + EXECUTE only via `direct_entry_*` | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:003 | `public.recruiter_aliases` | shared identity | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:004 | `public.recruiter_provider_memberships` | shared identity | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:005 | `public.recruiter_team_memberships` | shared identity | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:006 | `public.direct_entry_app_users` | app-user / actor | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:007 | `public.direct_entry_app_user_recruiter_links` | app-user / recruiter link | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:008 | `public.direct_entry_capability_grants` | auth (capability) | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:009 | `public.direct_entry_scope_grants` | auth (scope) | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:010 | `public.direct_entry_projects` | master (project) | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:011 | `public.direct_entry_banks` | master (bank) | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:012 | `public.direct_entry_submissions` | submission | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:013 | `public.direct_entry_candidates` | candidate | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:014 | `public.direct_entries` | entry (row) | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:015 | `public.direct_entry_payments` | payment | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:016 | `public.direct_entry_employment_status_events` | status (append-only) | RW (insert only via RPC) | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:017 | `public.direct_entry_document_versions` | document | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:018 | `public.direct_entry_document_events` | document (append-only) | RW (insert only via RPC) | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:019 | `public.direct_entry_restricted_reasons` | restricted reason (audit envelope) | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:020 | `public.direct_entry_revisions` | entry revision (immutable) | R (insert only via RPC) | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:021 | `public.direct_entry_submission_revisions` | submission revision (immutable) | R (insert only via RPC) | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:022 | `public.direct_entry_change_request_revisions` | change-request revision (immutable) | R (insert only via RPC) | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:023 | `public.direct_entry_change_requests` | change request | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:024 | `public.direct_entry_change_request_items` | change-request item | RW | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |
| db:t:p1.6:025 | `public.direct_entry_audit_events` | sanitized audit | R (insert only via RPC) | enabled + forced | none | revoke all + EXECUTE only | COVERED_DEV_FAST_TRACK |

#### 3.5.2 P1.6 W03 supporting table + view

| ID | Surface | R/W | RLS | Notes | Status |
|---|---|---|---|---|---|
| db:t:p1.6:026 | `public.direct_entry_rpc_idempotency` | RW (write/read via `direct_entry_idempotency_begin`/`finish`) | enabled + forced | holds canonical payload hash + result for each `(actor, action, key)`; rejection on key reuse with different input | COVERED_DEV_FAST_TRACK |
| db:v:p1.6:001 | `public.direct_entry_current_documents` (`security_invoker=true`) | R | inherits | latest READY+CLEAN per `(candidate, document_type)`; pending/rejected replacement leaves prior version current | COVERED_DEV_FAST_TRACK |

#### 3.5.3 P1.6 W03 + S03A + S03CD RPC — 20 application RPCs granted EXECUTE to `service_role`

All 20 are `SECURITY DEFINER`, pin `search_path`, validate capability/scope + actor + expected version, and run mutations + revisions + audit + idempotency in a single transaction. Internal helpers and trigger functions are not executable by any application role. The set grew: W03 = 17, +S03A = 1 (`direct_entry_resolve_actor_context`), +S03CD = 2 (`direct_entry_input_catalog`, `direct_entry_list_own_drafts`). `direct_entry_update_draft_row` (db:f:p1.6:003) was replaced forward-only by S03CD; signature unchanged, no count delta.

| ID | RPC | Capability / scope (W03) | Self-review? | Status |
|---|---|---|---|---|
| db:f:p1.6:001 | `direct_entry_create_batch` | `entry_create` + `submission_create`, own scope | n/a | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:002 | `direct_entry_create_draft_row` | `entry_create`, owner and own scope | n/a | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:003 | `direct_entry_update_draft_row` | exact own/team/all `entry_*` capability/scope | n/a | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:004 | `direct_entry_delete_draft_row` | exact own/team/all `entry_*` capability/scope | n/a (soft-delete, last active row protected) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:005 | `direct_entry_transition_submission` | `submission_create`, creator/own scope | n/a | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:006 | `direct_entry_update_payment` | DRAFT: exact `entry_own/team/admin` scope; SUBMITTED: `payment_edit` + effective resource scope | n/a (DRAFT) / second party via change request (SUBMITTED) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:007 | `direct_entry_apply_employment_status` | `employment_status.apply` + effective resource scope | n/a | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:008 | `direct_entry_correct_latest_status` | `employment_status.apply` + effective resource scope | n/a (correction supersedes only the latest event) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:009 | `direct_entry_create_document_metadata` | DRAFT: `document_upload` + exact `entry_*` scope; SUBMITTED: `document_upload` + `entry_privileged_edit` + effective scope | SUBMITTED: single-step (privileged) — not second-party | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:010 | `direct_entry_append_document_event` | `service_role` EXECUTE only (backend uploader / n8n / worker) | n/a (system identity, not human) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:011 | `direct_entry_create_change_request` | `change_request_create` + each entry scope | n/a (proposer; reviewer handled in decide) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:012 | `direct_entry_withdraw_change_request` | proposer with `change_request_create` | n/a (proposer withdraws own) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:013 | `direct_entry_approve_change_request` | `change_review` + each entry scope; **proposer cannot review own request** | **YES, second-party enforced** | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:014 | `direct_entry_reject_change_request` | `change_review` + each entry scope; **proposer cannot review own request** | **YES, second-party enforced** | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:015 | `direct_entry_privileged_edit` | `entry_privileged_edit` + effective resource scope (admin / kế toán direct edit) | **NO second-party required**, but: reason + expected version + revision + audit + idempotency are mandatory | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:016 | `direct_entry_read_projection` | exact `entry_*` scope + optional PII / payment / document capability gates | n/a (read) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:017 | `direct_entry_read_audit` | `audit_view` + effective resource scope | n/a (read) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:W04-S03A:001 | `direct_entry_resolve_actor_context(uuid)` | returns sanitized actor projection (app_user_id, capabilities, scopes, self_recruiter_suggestion); **does not emit audit event** (see errata #2 in `docs/handoffs/p3-w01-s03.md`) | n/a (resolve only) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:W04-S03CD:001 | `direct_entry_input_catalog(uuid, uuid, date)` | `entry_create`/`entry_own` capability; effective-date eligible project/recruiter/provider/team; `p_effective_date required` else `22023`; **does not take client-supplied scope** | n/a (read) | COVERED_DEV_FAST_TRACK |
| db:f:p1.6:W04-S03CD:002 | `direct_entry_list_own_drafts(uuid, uuid)` | exact `entry_own` for actor; own-draft projection only; list ceiling 500 (excess ⇒ `DRAFT_LIMIT_EXCEEDED` 413 ở route layer qua `kind === "too-large"`) | n/a (read) | COVERED_DEV_FAST_TRACK |

> **S03CD replace forward-only.** `direct_entry_update_draft_row` (db:f:p1.6:003) signature `(uuid, uuid, uuid, integer, jsonb, text)` unchanged, body merged: submitted worker display name replaces prior; hidden optional worker fields preserved. RPC count **unchanged** (replace, không tính mới).

> **Read redaction in `direct_entry_read_projection`.** Worker details, payment values, document metadata are redacted unless the caller separately holds `pii_view` / `payment_view` / `document_view`. This is the only read-side leakage surface, and P3 must keep this gate in any future read layer.

#### 3.5.4 P1.6 surface still open at W03 + W04-S01..S03CD (S03 view)

**Covered at DEV (RPC side + session/actor boundary + draft persistence + OCC/idempotency/audit):**
- Session actor resolution (`p1.6:016` + `db:f:p1.6:W04-S03A:001`).
- API fail-closed gate (server flag `DIRECT_ENTRY_API_ENABLED=true` + `DIRECT_ENTRY_UI_ENABLED=true`).
- Actor mapping (`auth_subject` → `app_user_id` + capabilities + scopes + recruiter suggestion) qua `direct_entry_resolve_actor_context`.
- Stable recruiter/team/provider IDs (effective-date eligibility check in `direct_entry_input_catalog`).
- Draft create / read / update (`direct_entry_create_batch` + `direct_entry_read_projection` + `direct_entry_update_draft_row`).
- Effective-date input catalog (`direct_entry_input_catalog`).
- Own-draft listing (`direct_entry_list_own_drafts`).
- OCC / idempotency / audit DB boundaries (W03 foundation; S03CD update RPC chỉ advance version khi payload hash + expected version match; vượt 500 ⇒ `413`; stale version ⇒ `409`).
- Table DML vẫn revoke từ `public, anon, authenticated, service_role`; application chỉ gọi application RPC qua server role.

**Still PENDING_P1.6 (UI / production / cutover / completeness):**
- Production login / logout UX (Supabase cookie session đã có, nhưng login form + callback + recovery chưa có).
- Full P3 RBAC / organization roles (capability matrix đã lock ở `p3-rbac-cutover-plan.md`; route-layer enforcement chưa wired cho non-Direct-Entry).
- Server-side capability-filtered navigation (`App Shell` vẫn dùng metadata `any` / `hrp`; P3 slice 4 chưa chạy).
- Basic Auth retirement (slice 7 cutover plan).
- Submit / review / change request UI + API completion (W04 S03D / W05 / W06 territory).
- Privileged edit UI (`direct_entry_privileged_edit` RPC đã có; route chưa có).
- ON / OFF UI (admin / bootstrap user + lifecycle).
- **Payment PATCH route (`p1.6:route:W04-S04A:001`) + payment projection UI + masked-entry input guards đã commit on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`** (xem §7.2); vẫn `ROUTE_COMMITTED_ON_P1.6_BRANCH`, **chưa merge `main`**, **chưa production enabled**. DB-side payment authority locked forward-only bởi `20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql` (DRAFT = `entry_own|entry_team|entry_admin`; SUBMITTED = `payment_edit`).
- Document routes and UI (`direct_entry_create_document_metadata` RPC đã có; route chưa có).
- Document worker / Drive upload (calls `direct_entry_append_document_event`).
- Production deployment / cutover (DB side đã committed on DEV; route layer chỉ committed on feature branch; chưa provider-live / production enabled).
- Real account bootstrap / admin (chỉ có synthetic accounts; PO chưa cung cấp user list).
- Audit / event viewer UI (`direct_entry_read_audit` RPC đã có; route + UI chưa có).
- Live browser Supabase cookie session acceptance (chỉ có demo + desktop/mobile CSS smoke; chưa test authorized cookie path in real browser).

**Out of scope (S03, refreshed S04):**
- **Submit / review / change / document upload / audit viewer vẫn pending.** T1B có thể tiếp tục W04-S04B (submit/review) → W05 (change request) → W06 (correct / privileged). Status: `MOVING_TARGET_FOLLOWUP` (xem §11.5 và `docs/handoffs/p3-w01-s04.md`).

---

## 4. Server-only repository và service-role callers

`createServiceSupabaseClient` (`src/lib/supabase/server.ts`) dùng `SUPABASE_SECRET_KEY` — bypass RLS + grants. Chỉ gọi từ server.

| ID | Caller file | R/W | Surface dùng | Owner | Status |
|---|---|---|---|---|---|
| repo:001 | `src/lib/reporting/pipeline-check-server.ts` | R | `data_sources`, `sync_runs`, `daily_recruitment_breakdown`, `sync_errors` qua service-role | T1B | COVERED (gate) / GAP (P3 cần read-only role thay service-role) |
| repo:002 | `src/lib/reporting/p1-reporting-server.ts` | R | views `reporting_*_v01` + tables nguồn | T1B | COVERED (gate) / GAP |
| repo:003 | `src/lib/reporting/p1-options-server.ts` | R | view `reporting_dimension_options_v01` + tables | T1B | COVERED (gate) / GAP |
| repo:004 | `src/lib/ai/gateway/server/review.mjs` | RW | `ai_report_*` | T1A | GAP — `PILOT_ACTOR_REF` hard-coded |
| repo:005 | `src/lib/ai/gateway/server/repository.mjs` | RW | `ai_report_jobs`, `ai_report_audit_events` (2 caller) | T1A | GAP |
| repo:006 | `src/lib/ai/gateway/server/packet-source.mjs` | RW | `ai_report_*` | T1A | GAP |
| repo:007 | `src/lib/ai-config/server/store.mjs` | RW | `ai_provider_configs`, `ai_provider_config_audit_events` | T1A | GAP — `PILOT_ACTOR_REF` hard-coded |
| repo:008 | `src/lib/ai-config/server/settings-wiring.ts` | RW | wrapper quanh store | T1A | GAP |
| repo:009 | `src/lib/ai-config/server/settings.mjs` | RW | business logic + service-role call | T1A | GAP |

> **Public client (publishable key).** `createPublicSupabaseClient` được export nhưng **không có caller** trong repo. Mọi truy vấn hiện dùng service-role. Khi P3 tách role reader hạn chế, sẽ dùng `createPublicSupabaseClient` + `auth.getUser()` cookie session per auth contract W02.

---

## 5. Pilot Basic Auth / proxy matcher

| ID | Surface | R/W | Current gate | Actor | P3 capability | Bypass risk | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| gate:001 | `src/proxy.ts` (Next.js middleware) | — | constant-time Basic Auth (`sha256 + timingSafeEqual`) + fail-closed 503 khi thiếu `PILOT_ACCESS_USERNAME/PASSWORD` | `PILOT_ACTOR_REF = "pilot-admin"` (cứng trong `evaluatePilotAccess`) | `pilot.access` (gate đầu tiên) | LOW cho pilot (single credential), HIGH cho scale (cần RBAC) | T0 | COVERED (gate pilot) / GAP (P3 thay bằng cookie session + role) |
| gate:002 | `src/lib/auth/pilot-access.ts` (`isPilotProtectedPath`) | — | matcher hard-coded `PROTECTED_EXACT` + `PROTECTED_PREFIXES` | n/a | n/a (gate path-level) | LOW cho pilot, MED nếu P3 thêm route mới mà quên update matcher | T0 | COVERED / GAP-DEPENDENCY (P3 phải đồng bộ matcher ↔ route) |
| gate:003 | `src/lib/auth/pilot-access.ts` (`evaluatePilotAccess`) | — | `development` mode bypass; production/preview enforce Basic Auth | dev=allow, prod=PILOT_ACTOR | n/a | n/a (đây là gate, không phải surface) | T0 | COVERED |

> **Match with matcher.** Matcher hiện bao: `/dashboard`, `/dashboard/:path*`, `/pipeline-check`, `/pipeline-check/:path*`, `/api/reporting/*`, `/api/ai/reports*`, `/api/ai/worker/*`, `/api/ai/settings*`. **Không match** `/` (landing — đúng). **Không match** bất kỳ static asset, _next, favicon.
>
> **Dead rule.** `/api/reporting/*` không có route handler. Nếu tương lai thêm route dưới `/api/reporting`, nó sẽ tự gate mà không cần thay đổi proxy — nhưng cũng dễ quên grant capability mapping. **GAP-DEPENDENCY**.

---

## 6. AI reports / settings / review / worker boundaries

Nhóm 12 API + 7 server repos. Tóm tắt ở §2 + §4. Thêm 2 cờ môi trường:

| ID | Env var | Default | Effect | Owner | Status |
|---|---|---|---|---|---|
| env:001 | `AI_REPORTS_ENABLED` | (unset) = disabled | fail-closed: route trả `AI_DISABLED` | T1A | COVERED |
| env:002 | `AI_SETTINGS_ENABLED` | (unset) = disabled | fail-closed: route trả `SETTINGS_DISABLED` | T1A | COVERED |
| env:003 | `AI_PROVIDER_KEY` | (unset) | không cho phép `live` ở production; chỉ `scripted` ở dev | T1A | COVERED |
| env:004 | `AI_WORKER_TOKEN` | (unset) | required để `/api/ai/worker/run` không trả `AI_WORKER_TOKEN_REQUIRED` | T1A | COVERED |
| env:005 | `AI_SETTINGS_RATE_LIMIT_*` | per-source defaults | rate-limit mutations | T1A | COVERED |

> **P3 cần xem xét.** P3 RBAC sẽ bổ sung `actor_ref` thật (auth_subject từ session) vào tất cả các RPC `ai_report_*` — contract hiện đã nhận `actor_ref` qua parameter, chỉ là caller đang truyền cứng `"pilot-admin"`. Đây là **GAP khép kín** (thay đổi 1 chỗ ở `src/lib/ai-config/settings-flag.ts` + `src/lib/ai/gateway/server/config.mjs`), không phải thay schema.

---

## 7. P1.6 direct-entry mutation/read/document boundaries

DB boundary (W03 + S03A + S03B + S03CD) → **COVERED_DEV_FAST_TRACK** (see §3.5). Route/UI production side: actor boundary + first draft write API + draft persistence **committed on `feature/p1.6-integration @ 2d5e9fc`** (S03A/S03B/S03CD), nhưng **chưa provider-live / production enabled**. UI/UX production, submit/review/change request, privileged edit, payment/document routes, admin/lifecycle, audit viewer, document worker vẫn `PENDING_P1.6` (W04-S03D / W05 / W06 / J01 territory).

Actor/session boundary cho Direct Entry: **Supabase Auth cookie + server `auth.getUser()` + `direct_entry_resolve_actor_context`**. **Không** dùng `PILOT_ACTOR_REF` cho Direct Entry path. Basic Auth vẫn là outer pilot gate duy nhất.

### 7.1 Capability split (P1.6 W03, locked at the RPC level)

Per `docs/contracts/p1.6-auth-capabilities-v1.md` and the W03 RPC matrix (see §3.5.3):

| Capability | Used by | Self-review required? | Reason/version/audit? | Idempotency? | Semantics |
|---|---|---|---|---|---|
| `change_review` | `direct_entry_approve_change_request` (db:f:p1.6:013) and `direct_entry_reject_change_request` (db:f:p1.6:014) | **YES — second-party enforced.** Proposer cannot review own change request. | YES (mandatory reason, expected request+item versions, request/entry revisions, audit) | YES (payload hash per request) | Staff submits a change, a leader/admin (different actor) reviews. The proposer ≠ reviewer check is a separate constraint inside `direct_entry_decide_change_request`. |
| `entry_privileged_edit` | `direct_entry_privileged_edit` (db:f:p1.6:015), and also the SUBMITTED branch of `direct_entry_update_payment` and `direct_entry_create_document_metadata` (when DRAFT requires `entry_*` scope; when SUBMITTED it requires both `document_upload` + `entry_privileged_edit` and `payment_edit` for payment). | **NO second-party required.** Direct single-step edit by admin / kế toán. | YES (mandatory reason, expected version, revision, audit) | YES (payload hash) | "Trusted actor" path: the privileged actor is the audit anchor. A privileged edit on a SUBMITTED row is logged with actor + reason + version delta. |
| `ai.report.review` | `POST /api/ai/reports/[jobId]/review` (api:006) | **DECISION SEPARATE — see §11 PENDING_DECISION `decision:ai-self-approval`.** | n/a (AI review is not a P1.6 capability) | n/a | AI report approval is its **own capability**, not `change_review`. It is also **not** `entry_privileged_edit`. Conflating AI review with direct-entry review would over-broaden both vocabularies. |

> **What `change_review` is not.** It is not a generic "approve anything" capability. It is bound to a change-request resource and to the per-item entry scope. The proposer-≠-reviewer check is a hard constraint; an attempt by the proposer to approve their own request returns a self-review denial (verified by 95-check G3 manifest).
>
> **What `entry_privileged_edit` is not.** It is not a substitute for `change_review`. A leader may hold `change_review` but not `entry_privileged_edit`; an admin holds both. P3 must not collapse them when designing the matrix.

### 7.2 P1.6 route / UI / worker / document surfaces

Trạng thái chia 3 nhóm (refreshed for S04, on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` = merge `40263bb` của `origin/main @ 2045472`; **chưa merge vào `main`**, **chưa provider-live / production enabled**):
- **ROUTE_COMMITTED_ON_P1.6_BRANCH**: 7 route files / 7 methods đã commit (session, create batch, entry restricted read, catalog, own drafts, draft update, **payment PATCH (W04-S04A + R1)**). UI shell page `src/app/direct-entry/page.tsx` (W04-S02 fixture, mode `demo`/`live`).
- **DB_ONLY** (RPC đã cover, route chưa có): submit / withdraw / correct / change-request approve+reject / employment-status apply / privileged edit / audit read.
- **NOT_STARTED** (chưa có RPC, chưa có route): document view+upload route, PII view+export route, document worker, admin lifecycle, audit viewer UI.

| ID | Surface | R/W | Current gate | Actor | P3 capability dự kiến | Bypass risk | Status |
|---|---|---|---|---|---|---|---|
| p1.6:016 | `GET /api/direct-entry/session` (S03A, committed on `feature/p1.6-integration`) | R | `DIRECT_ENTRY_API_ENABLED=true` + `auth.getUser()` + `getDirectEntryActor` + RPC `direct_entry_resolve_actor_context`; sanitized 401/403; `Cache-Control: private, no-store`; **RPC không tự ghi audit event** | resolved cookie session | n/a (returns sanitized actor projection only) | MED — không nhận actor/role/capability/scope từ client | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (DB + session boundary) |
| p1.6:route:W04-S03B:001 | `POST /api/direct-entry/batches` (S03B, committed) | W | `DIRECT_ENTRY_API_ENABLED` + `checkSameOriginRequest` + JSON + 1–128 char `Idempotency-Key` + 64 KiB body cap + reject nested authority fields + `auth.getUser()` + capability | resolved cookie session | `entry_create` + `submission_create` + `own` | HIGH | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (route + DB) |
| p1.6:route:W04-S03B:002 | `GET /api/direct-entry/entries/[entryId]` (S03B, committed) | R | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + per-row scope | resolved cookie session | exact `entry_*` scope + optional PII/payment/document capability | HIGH (PII) | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (route + DB) |
| p1.6:route:W04-S03CD:001 | `GET /api/direct-entry/catalog` (S03CD, committed) | R | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability `entry_create`/`entry_own` + `p_effective_date` (required) | resolved cookie session | `entry_create` / `entry_own` | LOW (read-only, effective-date scoped) | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (route + DB) |
| p1.6:route:W04-S03CD:002 | `GET /api/direct-entry/drafts` (S03CD, committed) | R | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + exact `entry_own`; list ceiling 500; vượt ⇒ `413 DRAFT_LIMIT_EXCEEDED` | resolved cookie session | exact `entry_own` + actor ownership | MED | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (route + DB) |
| p1.6:route:W04-S03CD:003 | `PATCH /api/direct-entry/entries/[entryId]` (S03CD, committed; new method) | W | `DIRECT_ENTRY_API_ENABLED` + `checkSameOriginRequest` + JSON + `Idempotency-Key` + `auth.getUser()` + capability + `expected_version`; stale version ⇒ `409 DRAFT_CONFLICT` | resolved cookie session | exact `entry_*` scope + `expected_version` | HIGH — live controller 6-state machine (`clean`/`dirty`/`saving`/`saved`/`conflict`/`error`) + `markDraftConflict` + `applyServerCopy`/`keepLocalCopy` — không silent merge/retry | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (route + DB) |
| p1.6:route:W04-S04A:001 | `PATCH /api/direct-entry/entries/[entryId]/payment` (**W04-S04A + R1**, committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`; new method) | W | `DIRECT_ENTRY_API_ENABLED` + `checkSameOriginRequest` + JSON + `Idempotency-Key` + `auth.getUser()` + `expected_version` + reason_code + bank_code (active-bank catalog) + `payment_version`. Authorize bằng `direct_entry_assert_payment_document_access(p_auth_subject, p_app_user_id, ..., 'payment_edit')` để suy ra `v_scope` (`own|team|all`); `v_audit_capability = case when v_submission_state = 'DRAFT' then case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team' else 'entry_admin' end else 'payment_edit' end`. **DRAFT** payment ⇒ audit capability theo own/team/all scope (từ `20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql`); **SUBMITTED** payment ⇒ retain `payment_edit`. Masked projection: actor thiếu `payment_view` ⇒ masked account number + version only; copy/cut/context-menu bị block trên masked-entry inputs; UI không persist payment values | resolved cookie session | DRAFT: `entry_own` / `entry_team` / `entry_admin` (theo effective resource scope); SUBMITTED: `payment_edit` + scope; projection masking = `payment_view` capability | HIGH — payment values + S04A-R1 audit capability mapping | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (route + DB; payment projection extended forward-only in `20261003210000_p1_6_w04_s04a_payment_projection.sql`; authority locked forward-only by `20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql`) |
| p1.6:017 | `GET /direct-entry` page (W04-S02 fixture shell, committed) | R | `DIRECT_ENTRY_UI_ENABLED=true`; mode = `live` khi `DIRECT_ENTRY_API_ENABLED=true` ngược lại `demo` (synthetic, không gọi API); live mode không fallback fixture | resolved cookie session (live) / n/a (demo) | n/a (UI render) | MED | **ROUTE_COMMITTED_ON_P1.6_BRANCH** (UI shell, chưa submit/review/privileged; S04A payment drawer UI commit cùng W04-S04A-R1) |
| p1.6:001 | `POST /api/direct-entry/batches` (production) | W | như `p1.6:route:W04-S03B:001` | resolved cookie session | như trên | HIGH | DB_ONLY (production merge) / ROUTE_COMMITTED_ON_P1.6_BRANCH |
| p1.6:002 | `GET /api/direct-entry/entries/[entryId]` (production) | R | như `p1.6:route:W04-S03B:002` | resolved cookie session | như trên | HIGH | DB_ONLY (production merge) / ROUTE_COMMITTED_ON_P1.6_BRANCH |
| p1.6:003 | `POST /api/direct-entry/entries/[entryId]/submit` (W04-S03D planned) | W | RPC: `direct_entry_transition_submission` (db:f:p1.6:005) ✅; route chưa có | resolver (W02) | `submission_create` + `own` | HIGH | DB_ONLY (route pending) |
| p1.6:004 | `POST /api/direct-entry/change-requests/[id]/withdraw` (W05 planned) | W | RPC: `direct_entry_withdraw_change_request` (db:f:p1.6:012) ✅; route chưa có | resolver (W02) | proposer `change_request_create` | MED | DB_ONLY (route pending) |
| p1.6:005 | `POST /api/direct-entry/entries/[entryId]/correct` (W06 planned) | W | RPC: `direct_entry_correct_latest_status` (db:f:p1.6:008) ✅; route chưa có | resolver (W02) | `entry_correct` + `own` | HIGH | DB_ONLY (route pending) |
| p1.6:006 | `POST /api/direct-entry/change-requests/[id]/approve` (W05 planned; backed by `direct_entry_approve_change_request` db:f:p1.6:013) | W | DB boundary ✅; route layer n/a; **second-party enforced ở RPC** | resolver (W02) | `change_review` + each item scope; **proposer ≠ reviewer** | HIGH | DB_ONLY (route pending) / COVERED_DEV_FAST_TRACK (DB) |
| p1.6:007 | `POST /api/direct-entry/change-requests/[id]/reject` (W05 planned; backed by `direct_entry_reject_change_request` db:f:p1.6:014) | W | DB boundary ✅; route layer n/a; **second-party enforced ở RPC** | resolver (W02) | `change_review` + each item scope; **proposer ≠ reviewer** | HIGH | DB_ONLY (route pending) / COVERED_DEV_FAST_TRACK (DB) |
| p1.6:008 | `POST /api/direct-entry/employment-status/[id]/apply` (W05 planned; backed by `direct_entry_apply_employment_status` db:f:p1.6:007) | W | DB boundary ✅; route layer n/a | resolver (W02) | `employment_status.apply` + scope + `expected_version` | HIGH | DB_ONLY (route pending) / COVERED_DEV_FAST_TRACK (DB) |
| p1.6:009 | `GET /api/direct-entry/documents/[id]` (planned) | R | RPC: `direct_entry_read_projection` (PII redaction) ✅; route chưa có | resolver (W02) | `document_view` + scope (CCCD/PII) | HIGH — PII / bank account | DB_ONLY (route pending) |
| p1.6:010 | `POST /api/direct-entry/documents/upload` (planned; backed by `direct_entry_create_document_metadata` db:f:p1.6:009 + worker calls `direct_entry_append_document_event` db:f:p1.6:010) | W | DB boundary ✅; route + worker chưa có | resolver (W02) | `document_upload` + scope + idempotency | HIGH | DB_ONLY (route + worker pending) / COVERED_DEV_FAST_TRACK (DB) |
| p1.6:011 | `GET /api/direct-entry/pii/[candidateId]` (planned) | R | RPC: `direct_entry_read_projection` (PII redaction) ✅; route chưa có | resolver (W02) | `pii_view` + scope (`own`/`team`/`all`) | HIGH — PII | DB_ONLY (route pending) |
| p1.6:012 | `GET /api/direct-entry/pii/export` (planned) | R | RPC: scoped read ✅; route chưa có | resolver (W02) | `pii_export` (admin only) + `all` | HIGH | DB_ONLY (route pending) |
| p1.6:013 | `GET /api/direct-entry/audit` (planned; backed by `direct_entry_read_audit` db:f:p1.6:017) | R | DB boundary ✅; route n/a | resolver (W02) | `audit_view` + scope | MED | DB_ONLY (route pending) / COVERED_DEV_FAST_TRACK (DB) |
| p1.6:014 | `POST /api/direct-entry/payments/[id]/edit` (W05 planned; backed by `direct_entry_update_payment` db:f:p1.6:006) | W | DB boundary ✅; route layer n/a | resolver (W02) | `payment_edit` (SUBMITTED) or `entry_*` (DRAFT) + scope + `expected_version` + `reason_ref` | HIGH | DB_ONLY (route pending) / COVERED_DEV_FAST_TRACK (DB) |
| p1.6:015 | `POST /api/direct-entry/admin/privileged-edit` (planned; backed by `direct_entry_privileged_edit` db:f:p1.6:015) | W | DB boundary ✅; route layer n/a | resolver (W02) | `entry_privileged_edit` + effective resource scope; **single-step, no second party**; mandatory reason + expected version + revision + audit | HIGH | DB_ONLY (route pending) / COVERED_DEV_FAST_TRACK (DB) |

> **Owner.** Tất cả P1.6: T1B (DB + route + UI + worker + cutover). **DB side** for W03 / S03A / S03CD: committed on Supabase DEV, evidence ở `p1.6-w03-g3-dev-manifest.json` + `p1.6-w04-s03a` + `p1.6-w04-s03cd` handoffs. **Route/UI production side**: chưa merged vào `main`, chưa provider-live / production enabled. **W04-S01** pin dependency + smoke (compile grid + typeahead). **W04-S02** fixture UI shell. **W04-S03A** session boundary. **W04-S03B** first write API. **W04-S03CD** draft persistence + catalog + own-drafts.
> **P3 implication.** P3 capability enforcement ở route handler là nơi actor resolve (`auth.getUser()` → `direct_entry_resolve_actor_context`) + capability check. Direct Entry RPC expects `p_actor` parameter — không gọi `auth.getUser()` ở DB. **Demo mode guard:** khi `DIRECT_ENTRY_API_ENABLED !== "true"`, page render ở `mode: "demo"`; demo component không gọi `/api/direct-entry/*`. Live mode (`DIRECT_ENTRY_API_ENABLED === "true"`) render grid + drawer, gọi 6 route đã liệt kê; không fallback fixture nếu API lỗi.

---

## 8. Pipeline-check, operational / raw / audit surfaces

| ID | Surface | R/W | Current gate | Actor | P3 capability | Bypass risk | Status |
|---|---|---|---|---|---|---|---|
| op:001 | `/pipeline-check` page | R | proxy + env flag + notFound() | `PILOT_ACTOR_REF` | `ops.view_pipeline` | MED — không row-level filter (mọi nguồn đều hiện) | GAP |
| op:002 | `src/lib/reporting/pipeline-check-server.ts` | R | service-role đọc nhiều tables; **`PIPELINE_QUERY_FAILED`** sanitize | n/a | n/a (chỉ là server) | LOW — sanitize chống raw error leak | COVERED (sanitize) / GAP (capability) |
| op:003 | `src/lib/reporting/pipeline-check-safety.ts` | — | `PIPELINE_CHECK_ENABLED` flag + `notFound()` khi tắt | n/a | n/a | MED — env flag tĩnh, không phân biệt role | COVERED (gate) / GAP (per-role) |
| op:004 | `scripts/check-w05-reconciliation.mjs` (read-only) | R | script chạy thủ công | human reviewer | n/a — read-only script | LOW (không connect DB thật) | COVERED |
| op:005 | `scripts/apply-migrations.mjs` | W | script chạy với credentials `SUPABASE_SECRET_KEY` | service-role | n/a — operator-only | LOW (chỉ người chạy mới có quyền) | COVERED |
| op:006 | `scripts/check-secrets.mjs` | R | scan source cho secret patterns | human reviewer | n/a | LOW | COVERED |
| op:007 | `scripts/check-doc-examples.mjs` | R | validate doc code examples | human reviewer | n/a | LOW | COVERED |
| op:008 | `scripts/check-daily-recruitment-fixtures.mjs` | R | validate fixtures | human reviewer | n/a | LOW | COVERED |

> **Audit surfaces.** `ai_report_audit_events` và `ai_provider_config_audit_events` chỉ có grant `select, insert` to `service_role`. **Không có UI** để xem audit hiện tại (chỉ hiện trong DB). Khi P3 thêm UI audit, cần gate bằng `audit_view`.

---

## 9. n8n system identity và workflow callers

Workflow JSON **không lưu Git** (`automation/n8n/README.md`). Service identity: **Supabase DEV service role** (`automation/n8n/docs/p0-t2-wf01-runbook.md` §2).

| ID | Workflow | R/W | Identity | Boundary | Owner | Status |
|---|---|---|---|---|---|---|
| n8n:001 | `P0-T2-WF01 - Daily recruitment breakdown ingestion` (ID `rnjvFA81uOBrVRQJ`) | W | DEV service role (Google Drive + Sheets + Supabase) | gọi `replace_daily_recruitment_breakdown_snapshot_v02` + `record_recruitment_source_failure_v01` | T2 | COVERED (chỉ DEV; PROD chưa gắn) |
| n8n:002 | `P0-T2-WF01` credential | n/a | Supabase DEV service role credential | RPC grant boundary | T2 | COVERED — credential tên, không ghi ID/value |
| n8n:003 | `report_folder_id = 1GGi9XTF-0JTI1MSzHJDYI6a6VEReCDX4` | R | Google Drive folder | read-only listing | T2 | COVERED |
| n8n:004 | `test_drive_file_id = 1wTCdDrMRAcZ0JRy30oH4FYCxSjFmsE9wF_g6_XH1otY` | RW (test only) | Google Drive file | write_test_only=true gate | T2 | COVERED |

> **Không có n8n workflow khác.** WF01 là workflow duy nhất (`README.md` §1).
>
> **Không có caller khác ngoài Google Drive/Sheets.** Workflow chỉ connect tới 3 hệ: Drive (list file), Sheets (read row), Supabase (RPC). Không có Slack/Email/Webhook outgoing.
>
> **P3 boundary.** n8n workflow identity **không thuộc human user RBAC**. Khi P3 thêm capability-aware audit suppression (vd. mask CCCD nếu actor thiếu `pii_view`), n8n workflow vẫn được service role và có full visibility — đây là **chủ ý**, không phải bypass. Nhưng P3 cần thấy rằng n8n credential **không thuộc RBAC matrix** và phải được document riêng trong ops runbook.

---

## 10. App navigation registry ↔ backend enforcement mapping

Lấy từ `origin/feature/app-nav-01a:src/lib/navigation/registry.ts`. Hiện 2 `current` + 1 `planned`.

| Nav ID | Path | Registry status | Registry capability | Page §1 ID | Backend gate ID | P3 capability (từ auth contract) | Mapping status |
|---|---|---|---|---|---|---|---|
| `dashboard` | `/dashboard` | current | `any` | page:002 | gate:001 + gate:002 (matcher) + repo:002 | `report.view` + scope `all` (boD) hoặc `own`/`team` (staff/leader) | GAP — capability `any` chưa map sang capability matrix thật |
| `pipeline-check` | `/pipeline-check` | current | `any` | page:003 | gate:001 + op:003 (flag) + repo:001 | `ops.view_pipeline` + scope `all` | GAP — capability `any` chưa phân biệt per-source viewer |
| `direct-entry` | `/direct-entry` | planned | `hrp` | page:005 | n/a (chưa có route production) | `entry_own` / `entry_team` / `entry_admin` per scope; `payment_edit` cho SUBMITTED payment (theo S04A-R1 authority); `change_review` cho change-request approve/reject (second-party enforced) | PENDING_P1.6 — capability vocab đã lock trong auth contract; route layer chỉ committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`, **chưa merge `main`** |

> **Registry không phải authorization.** `capability` field chỉ là **metadata**. Hiện App Shell không filter theo capability — cả 2 entry `current` đều hiển thị với mọi actor. Đây là chủ ý của APP-NAV-01A (P3 sẽ filter thật). **GAP cho P3.**

---

## 11. GAP / PENDING tổng hợp (P3 decision input)

### 11.1 Status transitions from S01 → S02 → S02-R1

| S01 status | Affected IDs | S02 → S02-R1 status | Why |
|---|---|---|---|
| `PENDING_P1.6` (db:t:P1.6-001..006, db:f:P1.6-001..003 — §3.5 of S01) | db:t:p1.6:001..025, db:t:p1.6:026, db:v:p1.6:001, db:f:p1.6:001..017 | `COVERED_DEV_FAST_TRACK` (unchanged through S02-R1) | W03 foundation + forward correction applied on Supabase DEV; 95-check G3 acceptance passed; 17 RPCs granted `service_role`; 26 tables force RLS + table DML revoked (25 foundation / core + 1 supporting idempotency); 1 security-invoker view. |
| `PENDING_P1.6` (route/UI p1.6:001..014) | p1.6:001..015 | split per row: DB side `COVERED_DEV_FAST_TRACK`, route/UI/worker side `PENDING_P1.6` (unchanged through S02-R1) | W03 acceptance is DB-only. W04-S01 (`27c6845`) đã pin React 19 grid + smoke compile + typeahead (DB / auth boundary unchanged) — production page / API / persistence vẫn pending. W04-S02 = fixture UI route. W04-S03 = nối server / RPC. |
| `decision:004` (`change_review` self-approve policy) | — | **closed by W03**: `direct_entry_approve_change_request` and `direct_entry_reject_change_request` enforce proposer ≠ reviewer (unchanged through S02-R1) | W03 RPC matrix locks second-party enforcement for direct-entry. |
| `decision:005` (audit retention window) | — | still `PENDING_DECISION` | not in scope of W03 / W04-S01 / G5-DEV01; W05+/J01 territory. |
| `decision:001` (pilot Basic Auth vs cookie session) | — | still `PENDING_DECISION` | gate remains the same; W03 / W04-S01 / G5-DEV01 don't touch it. |
| `decision:002` (cookie provider) | — | still `PENDING_DECISION`; auth contract W02 still locks `@supabase/ssr` | — |
| `decision:006` (Direct-URL enforcement layer) | — | still `PENDING_DECISION` | W03 RPC layer is in; middleware is still on the table. |
| `decision:003` (n8n system identity in capability matrix) | — | still `PENDING_DECISION` | see §9: n8n remains `service_role` only. |
| `decision:ai-self-approval` | — | still `PENDING_DECISION` (unchanged through S04; P1.5-I02 fail-closed env gate integrated; P1.5-I03 prompt 1.1 integrated; P1.5-W04B-S02B Phase B env apply lên Vercel Production deployment `dpl_GnSkjrS5FANe73rVooc6enS9K6iQ` với `AI_PROVIDER_KEY=live`; status `WAITING_FOR_OWNER_LIVE_RUN` cho Phase C one-report smoke; nhưng T0 decision vẫn chưa chốt) | W03 chỉ đóng self-approval cho direct-entry `change_review`. AI self-approval là capability riêng `ai.report.review`; không infer từ direct-entry. **P1.5-I02** integrated live provider adapter với fail-closed env gate (`AI_PROVIDER_KEY=live` + `AI_PROVIDER_ALLOWED_HOSTS` không rỗng → live; ngược lại `AI_CONFIG_REQUIRED`). **P1.5-I03** integrated prompt 1.1 (team comparison + anomaly + monitoring limitations) 126/126 tests pass. **P1.5-W04B-S02B Phase B**: production runtime env đã live (`AI_PROVIDER_KEY=live`, `AI_MODEL_KEY=deepseek-flash`, `AI_REPORTS_ENABLED=true`, `AI_PROMPT_VERSION=business-analysis-prompt/1.1`), nhưng config source vẫn nằm trên `feature/p1.5-live-integration @ 4392a4b` (chưa merge `main`); Phase C = Owner bấm "Tạo báo cáo" đúng một lần ⇒ `WAITING_FOR_OWNER_LIVE_RUN`. Phân vai: **Owner** nhập `URL` / `model` / `API key` qua UI (xem `api:007`); **Operator** cấu hình `AI_PROVIDER_ALLOWED_HOSTS=api.deepseek.com` ở server env (outbound guard). |

### 11.1.1 S03 → S04 transition summary

- `pending:p1.6:007` (Payment PATCH route + projection + authority) **closed by W04-S04A + R1**; surface moved from `MOVING_TARGET_FOLLOWUP` → `ROUTE_COMMITTED_ON_P1.6_BRANCH` (still on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`, chưa merge `main`).
- 6 route surface → 7 route surface (thêm `PATCH /api/direct-entry/entries/[entryId]/payment`).
- `pending:p1.6:route:001` / `pending:p1.6:route:002` / `pending:p1.6:ui:001` / `pending:p1.6:ops:001` refreshed cho 7 đếm.
- **AI provider production**: not disabled / fail-closed như S03 nói; đã LIVE trên Vercel Production runtime (`dpl_GnSkjrS5FANe73rVooc6enS9K6iQ`), nhưng config source vẫn nằm trên `feature/p1.5-live-integration`. Source/runtime tension: `origin/main @ 2045472` `src/lib/ai/gateway/server/config.mjs` vẫn comment cũ về AI_PROVIDER_DISABLED; sẽ update khi merge feature branch → main (T1A scope, không thuộc task docs-only này).
- **Report export HTML** (no new endpoint, analysis projection thêm `export_data` aggregate) đã merge `origin/main @ 2045472`.

### 11.2 GAP — gate hiện tại chưa đủ cho production RBAC

| ID | Mô tả | Resolution path |
|---|---|---|
| gap:001 | Tất cả `PILOT_ACTOR_REF = "pilot-admin"` hard-coded trong AI APIs (`api:002`–`api:012`) | Thay bằng `actor_ref` từ session/SSR cookie. Centralize trong `src/lib/auth/actor.ts`. |
| gap:002 | `/pipeline-check` không có per-source/per-team filter (`op:001`/`op:003`) | Thêm capability `ops.view_pipeline` + filter theo scope `all`/`team`. |
| gap:003 | `api:005` analysis projection không scope per-row (của actor) | `ai.report.analysis.view` + scope check `own`/`team`/`all` |
| gap:004 | `api:006` review (approve/reject) cho phép self-review (cùng `pilot-admin`) | `ai.report.review` capability + actor ≠ proposer enforcement. **Note:** W03 already enforces proposer ≠ reviewer for direct-entry change requests (`db:f:p1.6:013/014`). The AI review path is a separate decision; do not reuse `change_review` and do not infer self-review from direct-entry. See `decision:ai-self-approval` in §11.5. |
| gap:005 | Dead rule `/api/reporting/*` trong matcher (`gate:002`) | Sau khi P3 định route plan, xác nhận matcher hoặc loại bỏ |
| gap:006 | Server repos dùng `service_role` cho read (không cần) | Tách `read-only` role (`createPublicSupabaseClient` + `auth.getUser()`) cho page reads; service_role chỉ cho writes |
| gap:007 | App Nav registry `capability = "any"` không filter thật (`page:layout:001/002`) | P3 lọc `CURRENT_NAV_ENTRIES` theo `actor.capability` trước khi render |

### 11.3 PENDING_P1.6 — đã đóng bởi W03 / S03A / S03CD / S04A + R1

| ID | Mô tả | S04 |
|---|---|---|
| pending:p1.6:001 | 14 P1.6 API routes implementation | **S04 partial:** 7 route files / 7 methods committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` (session, create batch, entry restricted read, catalog, own drafts, draft update, **payment PATCH (W04-S04A + R1)**). **Chưa merged vào `main`, chưa provider-live / production enabled.** 8 route (submit, withdraw, correct, change-request approve+reject, employment-status apply, privileged edit, audit read, document view+upload, PII view+export) vẫn `DB_ONLY`. Demo mode (W04-S02 UI shell) render fixture, không gọi API. |
| pending:p1.6:002 | 5 P1.6 tables + 3 RPC migration | **closed by W03**: 25 tables + 1 view + 17 RPC now `COVERED_DEV_FAST_TRACK` |
| pending:p1.6:003 | Restricted reason store (audit envelope) chưa có | **closed by W03**: `direct_entry_restricted_reasons` (db:t:p1.6:019) is part of the 25-table block, with RLS forced and table DML revoked; accessed only via `direct_entry_reason` (internal) and indirectly through the 17 RPCs. |
| pending:p1.6:004 | Direct-Entry actor/session boundary (`auth.getUser()` + `direct_entry_resolve_actor_context`) | **closed by S03A** (commit `68cf028`): `src/app/api/direct-entry/session/route.ts` + `src/lib/direct-entry/actor-context-repository.ts` + `src/lib/auth/direct-entry-session.ts` + `src/lib/direct-entry/session-api.ts`. RPC does **not** emit audit event (see errata #2 trong `docs/handoffs/p3-w01-s03.md`). |
| pending:p1.6:005 | Effective-date input catalog (project/recruiter/provider/team eligibility) | **closed by S03CD** (commit `2d5e9fc`): `direct_entry_input_catalog` returns only active projects + active recruiters + single-membership providers + active teams at `p_effective_date`. |
| pending:p1.6:006 | Own-draft projection + 500-row ceiling + OCC stale-version 409 | **closed by S03CD**: `direct_entry_list_own_drafts` + `direct_entry_update_draft_row` (replace forward-only). Route layer 6-state machine (`clean`/`dirty`/`saving`/`saved`/`conflict`/`error`) + `markDraftConflict` + `applyServerCopy`/`keepLocalCopy` — không silent merge/retry. |
| pending:p1.6:007 | Payment PATCH route + projection extension + active-bank catalog | **closed by W04-S04A + R1** (committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`): `PATCH /api/direct-entry/entries/[entryId]/payment` route (`p1.6:route:W04-S04A:001`), payment projection extension forward-only qua `20261003210000_p1_6_w04_s04a_payment_projection.sql`, authority locked forward-only qua `20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql` (DRAFT = `entry_own|entry_team|entry_admin`; SUBMITTED = `payment_edit`). **Vẫn chỉ trên feature branch; chưa merge `main`, chưa production enabled.** |

### 11.4 PENDING_P1.6 — route/UI/document worker/cutover thực sự chưa làm

| ID | Mô tả | Owner | Resolution path |
|---|---|---|---|
| pending:p1.6:route:001 | 8 surface route handlers còn lại (submit, withdraw, correct, change-request approve+reject, employment-status apply, privileged edit, audit read; document view+upload + PII view+export). Payment PATCH route đã commit ở W04-S04A-R1 (xem `pending:p1.6:007`) | T1B | W04-S03D (submit) → W05 → W06. RPC side ready since W03. |
| pending:p1.6:route:002 | 7 surface route handlers committed on `feature/p1.6-integration` chưa merged vào `main` (session, create batch, entry restricted read, catalog, own drafts, draft update, payment PATCH) | T1B | Merge sau khi review; production enablement đi với `decision:001` (cutover). |
| pending:p1.6:ui:001 | Direct-entry UI (production page, grid, drawer, submit/review/privileged UI) | T1B | W04-S02 = fixture UI shell (committed on `p1.6-integration`); W04-S03 = nối server / RPC (S03A/S03B/S03CD/S04A done); production-grade submit/review/privileged UI = W04-S03D → W05. The page is registered as `planned` in `app-nav-01a:src/lib/navigation/registry.ts` but is not yet routed in production. S04A payment drawer UI commit cùng W04-S04A-R1 (UI render ở `mode: "live"`). |
| pending:p1.6:worker:001 | Document uploader worker (calls `direct_entry_append_document_event` db:f:p1.6:010) | T1B | W04 (after route); must be a server-only / n8n / worker boundary; never a client call. |
| pending:p1.6:cutover:001 | Cookie session per W02 (`@supabase/ssr` + `auth.getUser()`) replacing the actor-resolution path that P1.6 RPC currently relies on (caller passes `p_actor`) | T1B + T1C (P3) | T0 must decide on the cutover order vs the pilot Basic Auth gate (`decision:001`). |
| pending:p1.6:cutover:002 | S04A payment surface — T1B đã commit W04-S04A + R1 (route + payment authority + masked projection) trên `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`; vẫn `MOVING_TARGET_FOLLOWUP` cho tới khi merge `main` | T1B | DB side committed on DEV; route layer committed on feature branch; production enablement đi với merge cutover (`decision:001` + `decision:008`). |
| pending:p1.6:ops:001 | Demo mode hiện render fixture khi `DIRECT_ENTRY_API_ENABLED !== "true"`; live mode không fallback fixture (đúng spec S03CD + S04A). Chưa có live browser Supabase cookie session acceptance (chỉ CSS smoke + synthetic IDs). | T1B | Cần 1 test credential + thực thi 7 route ở browser thật với authorized cookie; chưa có. |

### PENDING_DECISION — cần T0 quyết trước khi P3 bắt đầu

| ID | Câu hỏi | Tại sao cần T0 | Impact |
|---|---|---|---|
| decision:001 | Có giữ `pilot-access` Basic Auth song song với cookie session P3 không? Hay thay hoàn toàn? | Pilot đang chạy; cần kế hoạch cutover để không break prod | gate:001 có còn `COVERED` không? |
| decision:002 | Cookie session P3 dùng `@supabase/ssr` (per auth contract W02) hay provider khác (Auth0/Clerk)? | Implementation khác nhau tùy provider; contract W02 đã lock `@supabase/ssr` | P3 implementation timeline |
| decision:003 | n8n system identity có cần gate riêng (vd. capability `system.workflow`) không? | Audit log đang ghi `service_role`; nếu thêm capability-aware audit, n8n sẽ fail | n8n identity trong capability matrix |
| decision:ai-self-approval | AI report approval (api:006) có cho phép self-approval (actor enqueues + same actor approves) không? | W03 đã đóng self-approval cho direct-entry `change_review` (proposer ≠ reviewer ở `direct_entry_approve_change_request` / `direct_entry_reject_change_request`). AI review là capability **riêng** `ai.report.review`; nó không dùng `change_review` và không có ràng buộc proposer ≠ reviewer ngầm. Nếu T0 muốn cùng semantic, P3 phải enforce ở route layer (`POST /api/ai/reports/[jobId]/review`) — không dùng `direct_entry_approve_change_request` và không bị suy diễn từ direct-entry rule. | api:006 behavior; nếu self-approval bị cấm, route cần check `actor_ref(job.actor_ref) ≠ actor_ref(reviewer)`. |
| decision:005 | Audit retention window (bao lâu)? | Hiện không định; P3 RBAC cần để hiển thị "audit_view" | UI audit |
| decision:006 | Direct-URL enforcement ở layer nào: middleware hay RPC policy? | W03 RPC đã có policy. Middleware hiện chỉ Basic Auth. P3 có thể thêm capability check ở middleware | gate:001 + new layer |
| decision:007 | Session/login audit ở Direct Entry: Có cần thêm audit event ở `direct_entry_resolve_actor_context` (S03A) không? Hiện RPC **không tự ghi audit**; nếu cần, phải thêm 1 dòng insert ở RPC + 1 RPC `direct_entry_session_audit_*` (future P3 slice) — không map sang `direct_entry_read_audit` (db:f:p1.6:017) vì session audit = auth/identity, không phải direct-entry change event. | `direct_entry_resolve_actor_context` chỉ resolve actor projection; login/logout audit là P3 slice 5 trong cutover plan, không phải evidence đã có. | schema + capability `audit.session.view` |
| decision:008 | Cutover P1.6 6-route đã commit trên `p1.6-integration` → `main`: sequence và production enablement timing | Route layer ở feature branch, DB side đã DEV. T0 cần chốt thứ tự merge + cách thức toggle `DIRECT_ENTRY_API_ENABLED` + actor data bootstrap trước khi production. | merge order + cutover slice 7 |

### 11.6 Backlog reconciliation (từ W03/I02 evidence)

Tổng kết số liệu G3 acceptance từ `scripts/p1.6-w03-g3-dev-manifest.json` (sanitized baseline) — phải được P2-W01 phân loại, không phải xem là regression W03:

| Metric | Pre-test | Post-cleanup | Note |
|---|---|---|---|
| `data_sources` count | 26 | 26 | 2 fixture sources (`is_test=true`), 24 real sources. |
| `recruited_total` (read-model `sum(recruited_count)`) | 30 | 30 | Fixture 2 sources bị loại khỏi read-model. |
| `daily_recruitment_breakdown` rows | 30 | 30 | Khớp `recruited_total`. |
| W03 user/entry count (post-cleanup) | 0 | 0 | W03 fixture namespace dùng synthetic IDs. |
| W03 document versions / change requests (post-cleanup) | 0 | 0 | Same. |

**Implication for P2-W01 / J01 backlog:**
- 26 `data_sources` phải được phân loại `active / inactive / legacy` — đây là backlog của P2-W01, không phải regression do W03.
- 2 fixture sources (theo hợp đồng `is_test=true`) vẫn còn trong `data_sources` nhưng bị loại khỏi read-model. P2-W01 phải quyết định: giữ để test fixture, hay archive / soft-delete.
- `recruited_total = 30` không thay đổi qua W03. **Nó không chứng minh được** số liệu trước W03 — evidence chỉ chứng minh `post-apply pre-test = post-cleanup`. Đây là tuyên bố trung thực của W03 handoff và P2-W01 phải tôn trọng nó khi xây dashboard.
- Tất cả 95 G3 check, baseline `cleanupVerified=true`, `baselineUnchanged=true`. Manifest file `scripts/p1.6-w03-g3-dev-manifest.json` đã được sanitize — không chứa connection data / credentials / tokens / PII / document payload.

### 11.7 P1.5 AI review self-approval — non-conflation note

`api:006` (`POST /api/ai/reports/[jobId]/review`) currently has the same actor enqueue + actor review path (`PILOT_ACTOR_REF = "pilot-admin"`). W03 closes the analogous question for direct-entry but does NOT close it for AI review — those are different capabilities (`change_review` vs `ai.report.review`).

**G5-DEV01 evidence (`287514f`):** migration `20261001180000_p1_5_ai_report_review_history.sql` applied on Supabase DEV. 14/14 acceptance checks pass (`scripts/g5-dev01-acceptance.mjs`). Service-role EXECUTE-only on 4 RPCs (`ai_report_review_capability`, `ai_report_approve_revision`, `ai_report_reject_revision`, `ai_report_history`). `ai_report_revisions` chuyển sang append-only (revoke UPDATE from service_role). **`PILOT_ACTOR_REF` vẫn chưa được thay bằng actor_ref từ session.** **G5-DEV01 không mở / không đóng `decision:ai-self-approval` — nó chỉ apply migration đã có từ trước.**

The S01 GAP `gap:004` ("self-review allowed because single `pilot-admin`") is still open for AI. P3 must:
1. Pick a separate `ai.report.review` capability (not `change_review`).
2. If T0 decides self-approval is forbidden for AI, add an `actor_ref(job.actor_ref) ≠ actor_ref(reviewer)` check at the route layer (using the new G5 `ai_report_approve_revision` / `ai_report_reject_revision` OCC + actor / cursor isolation, NOT a direct `UPDATE` on `ai_report_revisions`).
3. Not extend the direct-entry self-review denial to AI — they are different vocabularies.

Status of this: `PENDING_DECISION` (`decision:ai-self-approval` above).

---

## 12. Stop-condition check

- ✅ Inventory bao phủ mọi surface hiện có trên `origin/main @ 2045472`.
- ✅ Cross-reference với `origin/feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` (P1.6-I03 production main integration; W03 + S03A + S03CD + S04A + R1 commits; 26 migrations / 20 RPCs applied on DEV; 7 route files / 7 methods committed on feature branch; **DB / auth boundary unchanged**; route layer chỉ trên `feature/p1.6-integration`, **chưa merge `main`**).
- ✅ Cross-reference với `origin/feature/p1.5-live-integration @ 4392a4b` (W04B-S02B Phase B production live env apply; **AI provider đã LIVE trên Vercel Production runtime** deployment `dpl_GnSkjrS5FANe73rVooc6enS9K6iQ`; status `WAITING_FOR_OWNER_LIVE_RUN`; config source vẫn trên feature branch, chưa merge `main`).
- ✅ Cross-reference với `origin/feature/p1.5-live-integration @ 524d0c1` (P1.5-I03 prompt 1.1 integration; ancestor của `origin/main @ 2045472`).
- ✅ Cross-reference với `origin/feature/p1.5-g5-dev01 @ 9977600` (P1.5-G5-DEV01 apply review/history migration + 14/14 acceptance; **production project = cùng Supabase instance với DEV** → schema có sẵn ở production project ngay từ DEV apply).
- ✅ Cross-reference với `origin/feature/app-nav-01a @ 7bd2ba8` (registry đã liệt kê).
- ✅ Migrations, RPC, grants, n8n workflows, server repos, API routes, page gates, env flags, App Nav entries đều có ID.
- ✅ §11 GAP / PENDING_P1.6 / PENDING_DECISION có danh sách đầy đủ, bao gồm cả §11.3 (PENDING_P1.6 đã đóng — 7 ID, thêm `pending:p1.6:007` cho W04-S04A-R1) + §11.4 (route/UI/worker/cutover thực sự chưa làm — 7 ID, refreshed cho 7 route) + §11.5 (PENDING_DECISION 8 ID + `decision:ai-self-approval`) + §11.6 (backlog reconciliation) + §11.7 (AI non-conflation note + G5-DEV01 cross-ref).
- ✅ P1.6 capability split: `change_review` ≠ `entry_privileged_edit` ≠ `ai.report.review` (mỗi cái có semantic riêng, self-approval rules riêng). **G5-DEV01 không tự quyết AI self-approval.**
- ✅ P1.6 summary chuẩn hóa: 26 tables (25 foundation/core + 1 supporting idempotency), 1 security-invoker view, 20 application RPCs (W03 + S03A + S03CD; S04A + R1 replace forward-only, không tính mới), 7 route files / 7 methods committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` (bao gồm W04-S04A-R1 payment PATCH), applied + accepted trên DEV, **chưa PROD**.
- ✅ P1.5 append-only: `ai_report_revisions` không còn UPDATE từ service_role; mutations phải đi qua `ai_report_approve_revision` / `ai_report_reject_revision`.
- ✅ Owner map: P1.5 = T1A, P1.6 = T1B, P3 inventory/audit = T1C (this task).
- ✅ DB side P1.6 chuyển sang `COVERED_DEV_FAST_TRACK` (26 tables + 1 view + 20 RPC).
- ✅ DB side KHÔNG đồng nghĩa với "P1.6 PASS" — production page/API/persistence vẫn `PENDING_P1.6` (W04-S03D → W05 → W06 territory). W04-S04A + R1 đóng payment route/projection/authority trên feature branch; **chưa merge `main`**, **chưa provider-live / production enabled**.

---

## Appendix A — Source-of-truth refs

- `origin/main @ 2045472` — current production runtime; AI provider enabled trên Vercel Production runtime bởi Phase B env apply tại deployment `dpl_GnSkjrS5FANe73rVooc6enS9K6iQ` (config source vẫn trên `feature/p1.5-live-integration`); prompt 1.1 integrated (ancestor `524d0c1`); review/history migration applied to DEV (`9977600`); report export HTML attached to analysis projection (no new endpoint). Production project = cùng Supabase instance với DEV.
- `origin/feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` — P1.6-I03 production main integration handoff; branch HEAD advanced từ `d780471` (W04-S04A-R1) trong khi task chạy; merge commit `40263bb`. 26 migrations applied on DEV; 20 service-role EXECUTE-only RPCs; 7 route files / 7 methods committed on feature branch (session, create batch, entries GET, catalog, drafts, entries PATCH, **payment PATCH (W04-S04A-R1)**); UI shell page (`/direct-entry`); W04-S04A-R1 payment authority locked forward-only (DRAFT = `entry_own|entry_team|entry_admin`; SUBMITTED = `payment_edit`). **Chưa merge `main`, chưa provider-live / production enabled.**
- `origin/feature/p1.5-live-integration @ 4392a4b` — P1.5-W04B-S02B Phase B: production live reporting enabled (`AI_PROVIDER_KEY=live`, `AI_REPORTS_ENABLED=true`, `AI_MODEL_KEY=deepseek-flash`, `AI_PROMPT_VERSION=business-analysis-prompt/1.1`); status `WAITING_FOR_OWNER_LIVE_RUN` for Phase C one-report smoke. **Chưa merge vào `origin/main`.**
- `origin/feature/p1.5-live-integration @ 524d0c1` — P1.5-I03 prompt 1.1 integration (ancestor của `origin/main @ 2045472`).
- `origin/feature/p1.5-live-integration @ f7e41dd` — P1.5-I02 live adapter fail-closed env gate.
- `origin/feature/p1.5-g5-dev01 @ 9977600` — P1.5-G5-DEV01 apply review/history migration + DEV acceptance. **Production project = cùng Supabase instance với DEV** → review/history schema có sẵn ở production project ngay từ DEV apply.
- `origin/feature/app-nav-01a @ 7bd2ba8` — navigation registry.
- `src/proxy.ts` — pilot Basic Auth gate.
- `src/lib/auth/pilot-access.ts` — gate logic thuần.
- `src/lib/supabase/server.ts` — service-role + public client.
- `supabase/migrations/*.sql` (26 files on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`: 20 base + 6 P1.6 = `20261002170000_p1_6_direct_entry_foundation.sql` + `20261003170000_p1_6_w03_submission_noop_guard.sql` + `20261003180000_p1_6_w04_s03a_actor_context.sql` + `20261003200000_p1_6_w04_s03cd_catalog_drafts.sql` + `20261003210000_p1_6_w04_s04a_payment_projection.sql` + `20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql`).
- `docs/contracts/p1.6-auth-capabilities-v1.md` — capability vocab (P1.6 W02).
- `docs/contracts/p1.6-direct-entry-v1.md` — direct-entry business contract (P1.6 W01).
- `docs/handoffs/p1.6-w03.md` — W03 DB boundary + 95-check G3 acceptance manifest ref.
- `docs/handoffs/p1.6-w04-s01.md` — W04-S01 dependency + smoke (compile grid + typeahead).
- `docs/handoffs/p1.6-w04-s03a.md` — S03A session boundary commit `68cf028`.
- `docs/handoffs/p1.6-w04-s03cd.md` — S03CD draft persistence + catalog + own-drafts commit `2d5e9fc`.
- `docs/handoffs/p1.6-w04-s04a.md` — W04-S04A payment projection extension + active-bank catalog + 19/19 synthetic DEV acceptance.
- `docs/handoffs/p1.6-w04-s04a-r1.md` — W04-S04A-R1 payment draft authority (DRAFT = `entry_own|entry_team|entry_admin`; SUBMITTED retain `payment_edit`).
- `docs/handoffs/p1.6-i03.md` — P1.6-I03 production main integration; merge commit `40263bb`; 459 main/report + 82 AI server + 4 HTML report export + 30 App Shell/navigation tests pass; `pnpm typecheck`/`lint`/`build`/`docs:check`/`secrets:check`/`git diff --check` all PASS.
- `docs/handoffs/p1.5-w04b-s02b.md` — W04B-S02B Phase B: production live env apply; sanitized config (`config_id=pilot-provider`, `version=1`, `profile=openai-compatible`, `model=deepseek-flash`, `host=api.deepseek.com`, `status=active`, `verified=yes`).
- `docs/handoffs/p1.5-i02.md` — I02 integration checkpoint.
- `docs/handoffs/p1.5-i03.md` — I03 prompt 1.1 integration checkpoint.
- `docs/handoffs/p1.5-g5-dev01.md` — G5-DEV01 apply review/history migration + DEV acceptance.
- `scripts/p1.6-w03-g3-dev-acceptance.mjs` + `scripts/p1.6-w03-g3-dev-manifest.json` — DEV harness + sanitized manifest.
- `scripts/g5-dev01-acceptance.mjs` — G5-DEV01 acceptance harness.
- `automation/n8n/README.md` + `automation/n8n/docs/p0-t2-wf01-runbook.md` — n8n boundaries.
- `docs/spikes/p1.5-w04a-security.md` — AI outbound SSRF hardening.

## Appendix B — Owner map (per phase)

| Phase | Owner | Access surfaces |
|---|---|---|
| P0 (foundation) | T1B | db:t:001–005, db:v:001–003, db:f:001–012, repo:001–003 |
| P1 (reporting) | T1B | page:002, page:003, op:001–003 |
| P1.5 (AI gateway) | T1A | db:t:006–011, db:f:013–024, db:f:p1.5-G5:001–004 (NEW in S02-R1), api:001–012, api:013 (worker), repo:004–009; **`api:005` analysis projection extended với `export_data` aggregate (no new endpoint) — `origin/main @ 2045472`** |
| P1.6 (direct entry) | T1B | **DB side COVERED_DEV_FAST_TRACK**: 26 tables (25 foundation/core + 1 supporting idempotency), 1 view, 20 application RPCs (W03 + S03A + S03CD; S04A + R1 replace forward-only). **Route/UI/worker side**: 7 surface route files / 7 methods committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538` (p1.6:016, p1.6:017, p1.6:route:W04-S03B:001/002, p1.6:route:W04-S03CD:001/002/003, **p1.6:route:W04-S04A:001**) — **chưa merge `main`**, **chưa provider-live**. 8 surface route + document worker vẫn `DB_ONLY` (p1.6:003..015). |
| P2 (finance/payment) | TBD | planned (P3 sẽ inventory khi phase design) |
| P3 (RBAC) | T1C (this task) | gate:001–003, gap:001–007, decision:001–008, decision:ai-self-approval |
| Ops (n8n) | T1B (T2 in earlier docs) | n8n:001–004 |

> **Note.** Phase-owner assignments are recorded here for traceability only. P3 G1 may revise them; this is not an authority decision.

---

## 13. Delta S03 → S04

| Surface dimension | S03 | S04 | Evidence path |
|---|---|---|---|
| Migration count (DEV applied) | 24 (S03A + S03CD forward-only) | **26** (S04A + R1 forward-only, **không** thêm table/RPC; chỉ `create or replace` 3 RPC đã có) | `p1.6-w04-s04a.md` handoff; `p1.6-w04-s04a-r1.md` handoff (post-apply dry-run 26/0/0, P1.6-I03 §Quality gates confirms 26/0/0) |
| Direct Entry application RPC | 20 | **20** (S04A + R1 chỉ replace forward-only, **không thêm mới**) | `supabase/migrations/20261003210000_p1_6_w04_s04a_payment_projection.sql` (extends `direct_entry_input_catalog` + `direct_entry_read_projection`); `supabase/migrations/20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql` (replaces `direct_entry_update_payment` forward-only); grep distinct names = 20 |
| Direct Entry route handler | 6 surface route trên `p1.6-integration` (session, create batch, entries GET, catalog, drafts, PATCH entries) + 1 UI shell | **7 surface route trên `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`** (thêm `PATCH /api/direct-entry/entries/[entryId]/payment`) | `src/app/api/direct-entry/entries/[entryId]/payment/route.ts` (mới ở S04A-R1); existing 6 routes unchanged |
| Payment authority (DRAFT) | `direct_entry_update_payment` ⇒ audit capability `'payment_edit'` (cứng) | **`direct_entry_update_payment` (replaced forward-only ở R1) ⇒ audit capability = `entry_own|entry_team|entry_admin` theo effective own/team/all scope; SUBMITTED retain `'payment_edit'`** | `supabase/migrations/20261003220000_p1_6_w04_s04a_r1_payment_draft_authority.sql` (`v_audit_capability = case ...`) |
| Payment projection (S04A) | n/a (route chưa có) | `direct_entry_read_projection` extended với payment fields; masked projection khi actor thiếu `payment_view`; copy/cut/context-menu block trên masked-entry inputs | `supabase/migrations/20261003210000_p1_6_w04_s04a_payment_projection.sql` |
| W04-S04A synthetic DEV acceptance | n/a | **19/19 PASS** (active-bank catalog, all 4 payment states `omitted|unknown|intentionally_blank|provided`, version 0→1, updates, identical replay, changed-payload + stale-version conflicts, inactive bank rejection, out-of-scope denial, restricted projection masking); **R1 PGlite SQL test** (synthetic submission to `SUBMITTED`, no-`payment_edit` write denied) PASS; **W04-S04A + R1 = 40 tests pass** | `p1.6-w04-s04a.md` §Quality gates; `p1.6-w04-s04a-r1.md` §Quality gates; P1.6-I03 §Quality gates |
| P1.6-I03 integration | n/a | `origin/main @ 2045472` integrated into `feature/p1.6-integration` via merge `40263bb` at `73b19a64cb7c587e4973214508ab0bb600201538`; 459 main/report tests + 82 AI server + 4 HTML report export + 30 App Shell/navigation tests pass; `pnpm typecheck`/`lint`/`build`/`docs:check`/`secrets:check`/`git diff --check` all PASS; **Direct Entry vẫn chỉ trên `feature/p1.6-integration`; `origin/main` vẫn ở `2045472`** | `docs/handoffs/p1.6-i03.md`; merge commit `40263bb` |
| AI provider production | `live` adapter integrated nhưng env gate fail-closed ⇒ **disabled/fail-closed cho tới khi Owner nhập config + Operator set ALLOWED_HOSTS** | **LIVE trên Vercel Production runtime** deployment `dpl_GnSkjrS5FANe73rVooc6enS9K6iQ` (`AI_PROVIDER_KEY=live`, `AI_MODEL_KEY=deepseek-flash`, `AI_REPORTS_ENABLED=true`, `AI_PROMPT_VERSION=business-analysis-prompt/1.1`); config source vẫn trên `feature/p1.5-live-integration @ 4392a4b` (chưa merge `main`); status `WAITING_FOR_OWNER_LIVE_RUN` cho Phase C one-report smoke | `p1.5-w04b-s02b.md` handoff §Phase B output + §Sanitized config; `feature/p1.5-live-integration @ 4392a4b` |
| Report export HTML | n/a | `origin/main @ 2045472` thêm `report-export-server.ts` (104 LOC) + `report-export.ts` (191 LOC) + `report-export.test.mjs` (4 pass) + UI download HTML. **Không tạo route mới**; chỉ extend `api:005` analysis projection với `export_data` aggregate | `git show 2045472 -- src/app/api/ai/reports/[jobId]/analysis/route.ts` |
| `§3.5.3` row count | 20 | 20 (unchanged — S04A replace forward-only) | grep on `supabase/migrations/*p1_6*` `grant execute on function public.direct_entry_` |
| `§7.2` (route/UI/worker surface) | 6 route `ROUTE_COMMITTED_ON_P1.6_BRANCH`; 9 route `DB_ONLY`; UI shell `ROUTE_COMMITTED_ON_P1.6_BRANCH` | **7 route `ROUTE_COMMITTED_ON_P1.6_BRANCH`** (thêm payment PATCH); 8 route `DB_ONLY` (giảm payment); UI shell `ROUTE_COMMITTED_ON_P1.6_BRANCH` + S04A payment drawer UI | `git ls-tree -p |xargs git log -1 --format=%H -- | sort -u` cho route files trên `73b19a64cb7c587e4973214508ab0bb600201538` |
| `§11.3` (closed by P1.6) | 6 ID | 7 ID (thêm `pending:p1.6:007` cho W04-S04A-R1) | §11.3 |
| `§11.4` (route/UI/worker pending) | 7 ID | 7 ID refreshed (đếm 7 route thay 6; thêm `pending:p1.6:cutover:002` refreshed cho W04-S04A-R1 committed) | §11.4 |
| `p1.6:route:W04-S04A:001` (new ID) | n/a | added: `PATCH /api/direct-entry/entries/[entryId]/payment` route, current gate = `DIRECT_ENTRY_API_ENABLED` + CSRF + JSON + `Idempotency-Key` + `auth.getUser()` + `expected_version` + active-bank catalog; DRAFT audit capability theo own/team/all; SUBMITTED = `payment_edit` | §7.2 |
| `errata #2` (actor resolve audit) | S03 note `direct_entry_resolve_actor_context` không emit audit | still applies in S04; xem `decision:007` §11.5 | §3.5.3 + §11.5 |
| `errata #3` (`PILOT_ACTOR_REF` scope) | S03 note `PILOT_ACTOR_REF` chỉ P1.5 AI report path | still applies in S04; Direct Entry S04A-R1 cũng dùng Supabase cookie + `auth.getUser()` | §3.5.3 + §11.1.1 |
| `decision:007` (session audit) | S03 added: RPC không emit audit; future P3 slice | still applies in S04; **không thay đổi** | §11.5 |
| `decision:008` (cutover of 6 routes) | S03 added: sequence + production enablement timing cho 6 route đã commit | **refreshed cho 7 routes** trên `73b19a64cb7c587e4973214508ab0bb600201538` (thêm payment PATCH); sequence + production enablement timing vẫn T0-owned | §11.5 |

---

## 14. Library / dependency policy (unchanged)

- **Auth/session:** `@supabase/ssr` + `auth.getUser()` for all cookie session + actor resolution (per `docs/contracts/p1.6-auth-capabilities-v1.md`).
- **UI shell / dialog / navigation:** Radix primitives + shadcn-style + Lucide. Native typeahead; **không** thêm `cmdk`. **Không** thêm auth/admin framework.
- **Direct entry grid:** `react-data-grid` exact pin (`7.0.0-beta.61` per W04-S01).
- **Không** thêm dependency trong task docs-only này. Mọi thay đổi dependency phải đi qua P1.6 / P3 implementation slice riêng.

---

## 15. Errata fix log (cumulative)

| Errata | Where it surfaced | S03 fix | S04 status |
|---|---|---|---|
| #1 Zod provenance | Task brief flagged: "không nói Zod 'được P1.6-W02 đưa vào'" | §1 evidence + §14 + header errata block đã nêu: `zod ^4.6.5` đã có trong `package.json`; Direct Entry dùng custom validators; không đề xuất rewrite | **still valid** (S04 không thay đổi stack). |
| #2 Actor resolve audit | Task brief flagged: "không mô tả như evidence đã có" | §3.5.3 (db:f:p1.6:W04-S03A:001 note) + §11.5 `decision:007` đã tách rõ: RPC không emit audit; future P3 slice | **still valid**; W04-S04A-R1 không thay đổi `direct_entry_resolve_actor_context`. |
| #3 `PILOT_ACTOR_REF` scope | Task brief flagged: "không gộp hai boundary" | Header errata + §9 + §11 đã tách: `PILOT_ACTOR_REF` chỉ P1.5 AI report; Direct Entry dùng Supabase cookie + `auth.getUser()` | **still valid**; W04-S04A-R1 payment route cũng dùng Supabase cookie + `auth.getUser()` (không qua `PILOT_ACTOR_REF`). |
| #4 (S04 new) AI provider status phrasing | S03 inventory claim "live provider disabled/fail-closed cho tới khi config hoàn chỉnh" đã lỗi thời sau Phase B apply | (chưa có S03 fix) | S04 header + §1 P1.5 evidence block + §11.1.1 + Appendix A đã tách rõ: AI provider **đã LIVE trên Vercel Production runtime** (deployment `dpl_GnSkjrS5FANe73rVooc6enS9K6iQ`), config source vẫn trên `feature/p1.5-live-integration @ 4392a4b` (chưa merge `main`); status `WAITING_FOR_OWNER_LIVE_RUN` cho Phase C one-report smoke. **Không** sửa runtime/config; chỉ refresh docs. |
| #5 (S04 new) Migration/RPC count phrasing | S03 inventory có 24 migrations / 20 RPCs; S04 = 26 / 20 | (chưa có S03 fix) | S04 header + §1 P1.6 evidence block + §11.1.1 + §13 delta đã tách rõ: 26 migrations applied DEV (20 base + 6 P1.6; S04A + R1 chỉ replace forward-only, không tính mới); 20 service-role EXECUTE-only RPCs (W03 + S03A + S03CD). |
| #6 (S04 new) Direct Entry route count | S03 inventory liệt kê 6 route `ROUTE_COMMITTED_ON_P1.6_BRANCH`; S04 = 7 (thêm payment PATCH) | (chưa có S03 fix) | S04 §3.5.4 + §7.2 + §11.3 (`pending:p1.6:007`) + §13 delta đã tách rõ: 7 route files / 7 methods committed on `feature/p1.6-integration @ 73b19a64cb7c587e4973214508ab0bb600201538`, bao gồm `p1.6:route:W04-S04A:001` payment PATCH. **Chưa merge `main`**, **chưa production enabled**. |

---

**End of S04 inventory.** Status: `READY_FOR_P3_ACCESS_BASELINE_REFRESH_S04` — docs-only refresh đóng tại đây; **không** tự mở P3 implementation slice.