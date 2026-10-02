# P3 Access Surface Inventory — Mini BI

**Revision:** S01 (snapshot pre-G1).
**Auditor:** T2-A (Access Surface) — read-only.
**Base:** `origin/main @ 45ca016`.
**Inputs verified against three refs:**
- `origin/main @ 45ca016` (current production-shaped runtime)
- `origin/feature/p1.6-integration @ 3d47f82` (P1.6 contracts W01/W02/W03, no new schema yet)
- `origin/feature/app-nav-01a @ 7bd2ba8` (navigation registry; planned entry `direct-entry` already registered, no runtime)

**Hard guardrails (unchanged):** no runtime/schema/RPC edits, no migrations applied, no proxy / auth change. **Tài liệu này chỉ rà — không phải G1 PASS, không phải design decision, không thay thế audit của T1A.** Những phát hiện dạng GAP / PENDING_P1.6 / PENDING_DECISION cần được T0 đưa vào decision matrix riêng cho G1.

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
| page:005 | `/direct-entry` (P1.6) | RW | **CHƯA CÓ TRÊN MAIN**. Trên `app-nav-01a` registry là `status: 'planned'`. Trên `p1.6-integration` chưa có route page. | n/a | `entry_own` / `entry_team` / `entry_admin` per actor + scope theo row | HIGH — đây là entry chính của mutation mới, chưa có gate | T1A | PENDING_P1.6 |

### Page layout / shell

| ID | Component | Current gate | P3 capability dự kiến | Bypass risk | Status |
|---|---|---|---|---|---|
| page:layout:001 | `app/dashboard/layout.tsx` (chỉ trên `app-nav-01a`) | proxy Basic Auth (matcher `/dashboard/:path*`) | kế thừa `report.view` | MED — chỉ là layout wrapper, không cần capability riêng | COVERED |
| page:layout:002 | `app/pipeline-check/layout.tsx` (chỉ trên `app-nav-01a`) | proxy Basic Auth + `PIPELINE_CHECK_ENABLED` | kế thừa `ops.view_pipeline` | MED | COVERED |

> **Note.** `app-nav-01a` chưa được merge vào `main`. Layout wraper không có trên commit `45ca016`. P3 chỉ cần quan tâm đến matcher của `proxy.ts`, không cần quan tâm wrapper của shell.

---

## 2. API routes / methods

App Router `route.ts` trong `src/app/api/**`. Tất cả 12 route dưới đây đều có `src/proxy.ts` matcher bao phủ (trừ `src/proxy.ts` matcher `/api/reporting/:path*` — route này **không tồn tại** trong main, đây là matcher phòng hờ).

| ID | Method + Path | R/W | Current gate | Actor hiện tại | P3 capability / scope | Bypass risk | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| api:001 | `GET /api/ai/reports/capability` | R | proxy + flag `AI_REPORTS_ENABLED` + service-role read provider config | `PILOT_ACTOR_REF` qua proxy | `ai.capability.view` (read-only; không cần scope `team`) | LOW (chỉ bật/tắt flag) | T1A | COVERED (gate) / GAP (P3 capability mapping) |
| api:002 | `POST /api/ai/reports` (enqueue) | W | proxy + flag + `checkSameOriginRequest` (anti-CSRF) + rate-limit + service-role enqueue qua RPC `ai_report_enqueue` | `PILOT_ACTOR_REF` qua `gateway.actor_ref` | `ai.report.create` + scope theo caller (chưa phân biệt staff/leader/admin) | MED — CSRF đã chặn, nhưng 1 credential = full enqueue | T1A | GAP — actor_ref hiện cứng `"pilot-admin"`; P3 phải map sang `actor_ref` thật |
| api:003 | `GET /api/ai/reports/history` | R | proxy + flag + cursor pagination + service-role `ai_report_history` | `PILOT_ACTOR_REF` (hard-coded) | `ai.report.history.view` + scope theo row ownership | MED — ai cũng có credential thì thấy hết history của `pilot-admin` (hiện chỉ có 1 actor) | T1A | GAP — chưa scope theo row |
| api:004 | `GET /api/ai/reports/[jobId]` | R | proxy + flag + service-role getStatus | `PILOT_ACTOR_REF` qua `gateway.actor_ref` | `ai.report.status.view` + scope `own` / `team` / `all` theo row | MED — bất kỳ actor nào có credential đều đọc được jobId bất kỳ | T1A | GAP — chưa scope per-row |
| api:005 | `GET /api/ai/reports/[jobId]/analysis` | R | proxy + flag + service-role getStatus (analysis nằm trong projection) | `PILOT_ACTOR_REF` | `ai.report.analysis.view` + scope theo row ownership | HIGH — analysis có thể chứa executive references, limitation, findings. Hiện không filter theo actor | T1A | GAP |
| api:006 | `POST /api/ai/reports/[jobId]/review` | W | proxy + flag + `checkSameOriginRequest` + service-role review (approve / reject / regenerate) | `PILOT_ACTOR_REF` (hard-coded) | `ai.report.review` + scope `own` / `team` / `all` (riêng `approve` có thể cần capability `change_review` cao hơn) | HIGH — 1 credential duy nhất có thể approve/reject bất kỳ job nào | T1A | GAP — actor cứng `"pilot-admin"`, không phân biệt self-review vs second-party |
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
| db:t:007 | `public.ai_report_revisions` | RW | enabled | revoke + grant select/insert/update to service_role | T1A | COVERED |
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

> **Migrate P1.6 chưa apply.** `p1.6-integration` chưa có migration mới so với `main`. Tất cả surface P1.6 hiện là `PENDING_P1.6`.

### 3.5 P1.6 dự kiến (chưa có migration)

| ID | Surface | Status | Owner |
|---|---|---|---|
| db:t:P1.6-001 | `public.direct_entry` (planned) | PENDING_P1.6 | T1A |
| db:t:P1.6-002 | `public.direct_entry_documents` (planned) | PENDING_P1.6 | T1A |
| db:t:P1.6-003 | `public.direct_entry_employment_status_events` (planned) | PENDING_P1.6 | T1A |
| db:t:P1.6-004 | `public.app_user_recruiter_links` (planned W02) | PENDING_P1.6 | T1A |
| db:t:P1.6-005 | `public.team_scopes` (planned W02) | PENDING_P1.6 | T1A |
| db:t:P1.6-006 | `public.change_requests` (planned W05) | PENDING_P1.6 | T1A |
| db:f:P1.6-001 | `public.approve_change_request` RPC | PENDING_P1.6 | T1A |
| db:f:P1.6-002 | `public.reject_change_request` RPC | PENDING_P1.6 | T1A |
| db:f:P1.6-003 | `public.withdraw_change_request` RPC | PENDING_P1.6 | T1A |

> **P3 boundary.** Tất cả tables/RPC mới của P1.6 phải có **explicit policies** (không chỉ deny-by-default) theo auth contract `p1.6-auth-capabilities-v1.md` section "Capability vocabulary and scope". Policy: deny-by-default + revoke + **CAPABILITY_MATRIX** mapping `actor.capability → action → scope` tại RPC.

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

Trên `p1.6-integration` chưa có route handler / server repo trên module level; chỉ có contract:
- `docs/contracts/p1.6-direct-entry-v1.md` — business contract.
- `docs/contracts/p1.6-auth-capabilities-v1.md` — auth + capability vocab.

| ID | Surface | R/W | Current gate | Actor | P3 capability dự kiến | Bypass risk | Status |
|---|---|---|---|---|---|---|---|
| p1.6:001 | `POST /direct-entry` (planned) | W | chưa có | chưa có | `entry_own` / `entry_team` / `entry_admin` + scope | HIGH (P3 phải thiết kế đầu tiên) | PENDING_P1.6 |
| p1.6:002 | `GET /direct-entry` (planned) | R | chưa có | chưa có | `entry.view` + scope | MED-HIGH | PENDING_P1.6 |
| p1.6:003 | `POST /direct-entry/[id]/submit` (planned) | W | chưa có | chưa có | `entry.submit` + `own` scope | HIGH | PENDING_P1.6 |
| p1.6:004 | `POST /direct-entry/[id]/withdraw` (planned) | W | chưa có | chưa có | `entry.withdraw` + `own` scope (proposer only) | MED | PENDING_P1.6 |
| p1.6:005 | `POST /direct-entry/[id]/correct` (planned W06) | W | chưa có | chưa có | `entry_correct` + scope `own` | HIGH | PENDING_P1.6 |
| p1.6:006 | `POST /change-requests/[id]/approve` (planned W05) | W | chưa có | chưa có | `change_review` + scope `team` hoặc `all` (cần reviewer, không phải proposer) | HIGH — cần second-party enforcement | PENDING_P1.6 |
| p1.6:007 | `POST /change-requests/[id]/reject` (planned W05) | W | chưa có | chưa có | `change_review` + scope `team` hoặc `all` | HIGH | PENDING_P1.6 |
| p1.6:008 | `POST /employment-status/[id]/apply` (planned W05) | W | chưa có | chưa có | `employment_status.apply` + scope + `expected_version` | HIGH | PENDING_P1.6 |
| p1.6:009 | `GET /documents/[id]` (planned) | R | chưa có | chưa có | `document_view` + scope (CCCD/PII) | HIGH — PII / bank account | PENDING_P1.6 |
| p1.6:010 | `POST /documents/upload` (planned) | W | chưa có | chưa có | `document_upload` + scope + idempotency | HIGH | PENDING_P1.6 |
| p1.6:011 | `GET /pii/[candidateId]` (planned) | R | chưa có | chưa có | `pii_view` + scope (`own` only for self, `team`/`all` cho leader/admin) | HIGH — PII | PENDING_P1.6 |
| p1.6:012 | `GET /pii/export` (planned) | R | chưa có | chưa có | `pii_export` + scope (chỉ admin) | HIGH | PENDING_P1.6 |
| p1.6:013 | `GET /audit` (planned) | R | chưa có | chưa có | `audit_view` + scope | MED | PENDING_P1.6 |
| p1.6:014 | `POST /payments/[id]/edit` (planned W05) | W | chưa có | chưa có | `payment_edit` + scope + `expected_version` + `reason_ref` | HIGH | PENDING_P1.6 |

> **Owner.** Tất cả P1.6: T1A. **Capability vocab** đã lock ở `docs/contracts/p1.6-auth-capabilities-v1.md` (staff / leader / admin baseline). P3 chỉ implement, không redefine.

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
| `direct-entry` | `/direct-entry` | planned | `hrp` | page:005 | n/a (chưa có route) | `entry_own` / `entry_team` / `entry_admin` per scope | PENDING_P1.6 — capability vocab đã lock trong auth contract |

> **Registry không phải authorization.** `capability` field chỉ là **metadata**. Hiện App Shell không filter theo capability — cả 2 entry `current` đều hiển thị với mọi actor. Đây là chủ ý của APP-NAV-01A (P3 sẽ filter thật). **GAP cho P3.**

---

## 11. GAP / PENDING tổng hợp (P3 decision input)

### GAP — gate hiện tại chưa đủ cho production RBAC

| ID | Mô tả | Resolution path |
|---|---|---|
| gap:001 | Tất cả `PILOT_ACTOR_REF = "pilot-admin"` hard-coded trong AI APIs (`api:002`–`api:012`) | Thay bằng `actor_ref` từ session/SSR cookie. Centralize trong `src/lib/auth/actor.ts`. |
| gap:002 | `/pipeline-check` không có per-source/per-team filter (`op:001`/`op:003`) | Thêm capability `ops.view_pipeline` + filter theo scope `all`/`team`. |
| gap:003 | `api:005` analysis projection không scope per-row (của actor) | `ai.report.analysis.view` + scope check `own`/`team`/`all` |
| gap:004 | `api:006` review (approve/reject) cho phép self-review (cùng `pilot-admin`) | `change_review` capability + second-party enforcement |
| gap:005 | Dead rule `/api/reporting/*` trong matcher (`gate:002`) | Sau khi P3 định route plan, xác nhận matcher hoặc loại bỏ |
| gap:006 | Server repos dùng `service_role` cho read (không cần) | Tách `read-only` role (`createPublicSupabaseClient` + `auth.getUser()`) cho page reads; service_role chỉ cho writes |
| gap:007 | App Nav registry `capability = "any"` không filter thật (`page:layout:001/002`) | P3 lọc `CURRENT_NAV_ENTRIES` theo `actor.capability` trước khi render |

### PENDING_P1.6 — cần thiết kế trước khi P3 có thể gắn capability

| ID | Mô tả | Owner | Resolution path |
|---|---|---|---|
| pending:p1.6:001 | 14 P1.6 route API chưa code | T1A | Code theo capability vocab trong `p1.6-auth-capabilities-v1.md` |
| pending:p1.6:002 | 5 P1.6 tables + 3 RPC chưa migration | T1A | Migration phải có explicit policies (không chỉ deny-by-default) |
| pending:p1.6:003 | Restricted reason store (audit envelope) chưa có | T1A | W03 phải cung cấp storage + audit persistence |

### PENDING_DECISION — cần T0 quyết trước khi P3 bắt đầu

| ID | Câu hỏi | Tại sao cần T0 | Impact |
|---|---|---|---|
| decision:001 | Có giữ `pilot-access` Basic Auth song song với cookie session P3 không? Hay thay hoàn toàn? | Pilot đang chạy; cần kế hoạch cutover để không break prod | gate:001 có còn `COVERED` không? |
| decision:002 | Cookie session P3 dùng `@supabase/ssr` (per auth contract W02) hay provider khác (Auth0/Clerk)? | Implementation khác nhau tùy provider; contract W02 đã lock `@supabase/ssr` | P3 implementation timeline |
| decision:003 | n8n system identity có cần gate riêng (vd. capability `system.workflow`) không? | Audit log đang ghi `service_role`; nếu thêm capability-aware audit, n8n sẽ fail | n8n identity trong capability matrix |
| decision:004 | `review` capability `change_review` cho phép self-approve hay cấm? | Auth contract không định rõ (chỉ nói second-party); nếu cấm tuyệt đối, P3 cần proposer ≠ reviewer check | api:006 behavior |
| decision:005 | Audit retention window (bao lâu)? | Hiện không định; P3 RBAC cần để hiển thị "audit_view" | UI audit |
| decision:006 | Direct-URL enforcement ở layer nào: middleware hay RPC policy? | Auth contract nói RPC + RLS; middleware hiện chỉ Basic Auth. P3 có thể thêm capability check ở middleware | gate:001 + new layer |

---

## 12. Stop-condition check

- ✅ Inventory bao phủ mọi surface hiện có trên `origin/main`.
- ✅ Cross-reference với `origin/feature/p1.6-integration` (no new tables/RPC yet, chỉ contracts).
- ✅ Cross-reference với `origin/feature/app-nav-01a` (registry đã liệt kê).
- ✅ Migrations, RPC, grants, n8n workflows, server repos, API routes, page gates, env flags, App Nav entries đều có ID.
- ✅ §11 GAP / PENDING_P1.6 / PENDING_DECISION có danh sách đầy đủ.

---

## Appendix A — Source-of-truth refs

- `origin/main @ 45ca016` — current runtime.
- `origin/feature/p1.6-integration @ 3d47f82` — P1.6 W01/W02/W03 contracts.
- `origin/feature/app-nav-01a @ 7bd2ba8` — navigation registry.
- `src/proxy.ts` — pilot Basic Auth gate.
- `src/lib/auth/pilot-access.ts` — gate logic thuần.
- `src/lib/supabase/server.ts` — service-role + public client.
- `supabase/migrations/*.sql` (20 files) — RLS + grants + RPC.
- `docs/contracts/p1.6-auth-capabilities-v1.md` — capability vocab (P1.6 W02).
- `docs/contracts/p1.6-direct-entry-v1.md` — direct-entry business contract (P1.6 W01).
- `automation/n8n/README.md` + `automation/n8n/docs/p0-t2-wf01-runbook.md` — n8n boundaries.
- `docs/spikes/p1.5-w04a-security.md` — AI outbound SSRF hardening.

## Appendix B — Owner map (per phase)

| Phase | Owner | Access surfaces |
|---|---|---|
| P0 (foundation) | T1B | db:t:001–005, db:v:001–003, db:f:001–012, repo:001–003 |
| P1 (reporting) | T1B | page:002, page:003, op:001–003 |
| P1.5 (AI gateway) | T1A | db:t:006–011, db:f:013–024, api:001–012, api:013 (worker), repo:004–009 |
| P1.6 (direct entry) | T1A | pending:p1.6:001–003 |
| P2 (finance/payment) | TBD | planned (P3 sẽ inventory khi phase design) |
| P3 (RBAC) | T2 (this task) | gate:001–003, gap:001–007, decision:001–006 |
| Ops (n8n) | T2 | n8n:001–004 |