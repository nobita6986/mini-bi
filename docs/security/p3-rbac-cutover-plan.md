# P3 RBAC & Auth Cutover Plan — Mini BI

| Thuộc tính | Giá trị |
|---|---|
| Phiên bản | 1.0 — 03/10/2026 |
| Branch | `feature/p3-w01-access-inventory` |
| Base | `6cbdc68622d263121f50d46f8a2dac63e2139322` |
| Inputs verified | `origin/feature/p1.6-integration @ 2d5e9fc` (W04-S01..S03CD committed; S03CD = `2d5e9fc`), `origin/feature/p1.5-g5-dev01 @ 287514f` (G5-DEV01), `origin/feature/p1.5-live-integration @ 8d0d074` (P1.5-I03 prompt 1.1) + `@ f7e41dd` (P1.5-I02 live adapter fail-closed env gate), `origin/feature/app-nav-01a @ 7bd2ba8` |
| Tài liệu đi kèm | `docs/security/p3-access-surfaces.md` (S03), `docs/contracts/p1.6-auth-capabilities-v1.md`, `docs/handoffs/p1.6-w04-s03a.md`, `docs/handoffs/p1.6-w04-s03b.md`, `docs/handoffs/p1.6-w04-s03cd.md`, `docs/handoffs/p1.5-i02.md`, `docs/handoffs/p1.5-i03.md` |
| Mode | FT0 — DOCS-ONLY (không runtime, không schema, không migration, không deploy, không bắt đầu P3 implementation) |
| Owner | T1C (Library & Access Auditor) — read-only / design baseline |
| Trạng thái | `READY_FOR_P3_IMPLEMENTATION_SPLIT` |

Tài liệu này **khóa** kiến trúc cutover P3 đủ để ba agent P3 (sau khi P1.5/P1.6 integration ổn định) có thể chia việc mà không đụng contract. Nó không tự mở policy, không sửa inventory, không dự đoán số liệu S03C/S03D. Mọi ma trận dưới đây neo vào ID đã có trong `docs/security/p3-access-surfaces.md` (S02-R1) — không sinh ID mới.

---

## 1. Mục tiêu & Definition of Done (của cutover plan, không phải của P3 triển khai)

Cutover plan này hoàn thành khi:

1. Mỗi page/API/route handler (đã liệt kê trong inventory) có một dòng ma trận xác định `route enforcement` + `RPC enforcement` + `audit event` + `deny HTTP code`.
2. Capability vocab (locked ở `docs/contracts/p1.6-auth-capabilities-v1.md`) gắn với một `id_t:capability` duy nhất, không trùng nghĩa với capability khác — `change_review` ≠ `entry_privileged_edit` ≠ `ai.report.review`.
3. Go-live slice gồm 7 bước có thứ tự: login/logout → actor bootstrap → page/API guard → nav filtering → audit → admin/bootstrap → Basic Auth retirement. Mỗi bước có owner + flag env + reversible check.
4. AI self-approval vẫn `PENDING_DECISION` với 2 option + recommendation; **không tự sửa policy/runtime**.
5. Library policy: chỉ dùng `@supabase/ssr` hiện có + Radix/shadcn-style + Lucide; **không thêm** auth framework, state library, form library, hay tự code focus trap/dialog/menu.
6. Evidence P1.6 W04-S03A (Direct Entry RPC 17→18, route `GET /api/direct-entry/session`) + W04-S03B (route layer dùng 2 RPC có sẵn, không tăng count) + W04-S03CD (Direct Entry RPC 18→20, 2 mới: `direct_entry_input_catalog` + `direct_entry_list_own_drafts`; `direct_entry_update_draft_row` replace forward-only, không tính mới; 3 route mới: `GET catalog`, `GET drafts`, `PATCH entries/[id]`) **đã committed trên `feature/p1.6-integration @ 2d5e9fc`**. Migration count 24/0/0 (post S03CD).
7. W04-S03C / S03D **đã commit** dưới dạng S03CD (`2d5e9fc`) — inventory S03 đã cập nhật. Còn moving target: S04A payment (T1B sau base S03CD), không đưa vào current inventory.

---

## 2. Architecture baseline (khóa)

### 2.1. Defense-in-depth (4 lớp)

| Lớp | Vai trò | Công nghệ | Caller | Lệch cũ → mới |
|---|---|---|---|---|
| **L1 — Network / proxy** | Coarse authentication & feature gate | Next.js 16 middleware `src/proxy.ts` + Basic Auth (`evaluatePilotAccess` + `isPilotProtectedPath`) | Edge runtime, không có DB | Pilot gate. **Cutover cuối** mới thay / bỏ. |
| **L2 — Route handler / Server Component** | Session + capability check exact | `@supabase/ssr` `createServerClient` + `auth.getUser()` + `getDirectEntryActor` (P1.6 W02) + `resolveActor()` | Route Handler / Server Action / RSC | Hiện (P1.6 S03A+): `auth.getUser()` + `direct_entry_resolve_actor_context` cho Direct Entry. **P1.5 AI report path vẫn `PILOT_ACTOR_REF = "pilot-admin"` cứng** — đây là 2 boundary khác nhau, không gộp. **Cutover AI**: thay bằng `auth.getUser()` → `app_user_id` từ resolver. |
| **L3 — Server repository** | Service-role gọi RPC narrow | `createDirectEntryActorRepository` (P1.6 W02) + `createServiceSupabaseClient` (chỉ RPCs đã liệt kê) | Server-only | Hiện: gọi thẳng RPC với `p_actor` từ resolved actor. **Cutover AI**: truyền `p_actor` từ resolved actor thay cho `PILOT_ACTOR_REF`. |
| **L4 — Database (PostgreSQL)** | Authority cuối (scope, version, idempotency, OCC) | RLS forced + table DML revoked (`public, anon, authenticated, service_role`) + `SECURITY DEFINER` RPCs | DB role `service_role` only (EXECUTE) | Hiện: đã khóa cho 17 P1.6 RPC + S03A 1 RPC + S03CD 2 RPC = 20 RPC + 4 G5 RPC. **Cutover**: không mở. |

> **Nguyên tắc vàng.** Client gửi kèm `actor_id`, `role`, `capability`, `scope`, `created_by_user_id`, `owner_user_id` đều bị **reject** ở route handler (theo W02 adapter rule). DB không bao giờ tin client authority fields — audit envelope (actor/app_user/resource/scope/timestamp/outcome/code) đã sanitize sẵn.

### 2.2. Authentication & identity

| Khía cạnh | Quyết định |
|---|---|
| Auth provider | **Supabase Auth** (đã khóa trong `docs/contracts/p1.6-auth-capabilities-v1.md` §Supabase and Next.js adapter). `@supabase/ssr` đã có trong `package.json`. |
| Session transport | Cookie (`@supabase/ssr` `createServerClient` + `getAll`/`setAll` cookies, dùng `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — **không** `SUPABASE_SECRET_KEY`). |
| Session verification | Server-side `auth.getUser()` chỉ. **Không** dùng `auth.getSession()` ở server. |
| Cookie mutation | Chỉ trong Route Handler / Server Action (nơi có thể ghi response cookies). Caller phải áp `Cache-Control: private, no-store` + Supabase refresh cache headers. |
| Identity mapping | `auth_subject` (UUID từ `getUser()`) → `app_user_id` qua `direct_entry_resolve_actor_context(p_auth_subject)` (W04-S03A, DB-side). Mapping là server-owned, không phải client input. |
| Recruiter / team / candidate | Tách biệt khỏi actor: `recruiter_id`, `team_id`, `candidate_id` là stable P1.5 IDs (P1.6 W02 contract §Identity reconciliation). |
| Basic Auth | Outer pilot gate **không** phải business actor. Sau khi P3 roll out & pilot window đóng, Basic Auth nghỉ hưu (slice 7). |
| n8n system identity | Tách khỏi human RBAC (decision:003 vẫn pending). n8n credential = `service_role`; không bị matrix lọc. |

### 2.3. Capability & scope vocabulary (neo về auth contract)

Source: `docs/contracts/p1.6-auth-capabilities-v1.md` (locked ở W02-R2). Mỗi capability được gắn với một `id_t:capability` (khóa trong inventory §7.1):

| `id_t:capability` | Capability name | Scope kinds | Self-review rule | Reason/version/audit | Dùng cho |
|---|---|---|---|---|---|
| `cap:entry_create` | `entry_create` | `own` | n/a | n/a (draft) | `direct_entry_create_batch`, `direct_entry_create_draft_row` |
| `cap:entry_own` | `entry_own` | `own` (exactly) | n/a | `expected_version` khi SUBMITTED | `direct_entry_update_draft_row` / `direct_entry_delete_draft_row` / `direct_entry_update_payment` (DRAFT) / `direct_entry_create_document_metadata` (DRAFT) / `direct_entry_read_projection` |
| `cap:entry_team` | `entry_team` | `team` (exactly) | n/a | như trên | như `entry_own` nhưng team scope |
| `cap:entry_admin` | `entry_admin` | `all` (exactly) | n/a | như trên | như trên nhưng all scope |
| `cap:submission_create` | `submission_create` | `own` | n/a | n/a | `direct_entry_transition_submission` |
| `cap:change_request_create` | `change_request_create` | per-item entry scope | n/a (proposer) | n/a | `direct_entry_create_change_request`, `direct_entry_withdraw_change_request` |
| `cap:change_review` | `change_review` | per-item entry scope | **YES, second-party enforced at RPC** (`direct_entry_approve_change_request` / `direct_entry_reject_change_request`) | YES (mandatory reason, expected request+item versions, request/entry revisions, audit) | `direct_entry_approve_change_request`, `direct_entry_reject_change_request` |
| `cap:entry_privileged_edit` | `entry_privileged_edit` | effective resource scope | **NO second-party**, single-step | YES (mandatory reason, expected version, revision, audit) | `direct_entry_privileged_edit`, SUBMITTED branch of `direct_entry_update_payment` + `direct_entry_create_document_metadata` |
| `cap:employment_status_request` | `employment_status.request` | effective resource scope | n/a | YES (reason) | planned |
| `cap:employment_status_review` | `employment_status.review` | effective resource scope | YES, second-party | YES | planned |
| `cap:employment_status_apply` | `employment_status.apply` | effective resource scope | n/a | YES (reason + `expected_version`) | `direct_entry_apply_employment_status`, `direct_entry_correct_latest_status` |
| `cap:document_upload` | `document_upload` | effective resource scope | n/a | YES (`expected_version`) | `direct_entry_create_document_metadata` |
| `cap:document_view` | `document_view` | effective resource scope (PII redaction) | n/a | n/a | `direct_entry_read_projection` (PII redaction) |
| `cap:payment_view` | `payment_view` | effective resource scope | n/a | n/a | `direct_entry_read_projection` (payment redaction) |
| `cap:payment_edit` | `payment_edit` | effective resource scope | n/a (DRAFT = `entry_*`; SUBMITTED = single-step privileged) | YES (`expected_version`, `reason_ref`) | `direct_entry_update_payment` (SUBMITTED branch) |
| `cap:recruiter_master_manage` | `recruiter_master_manage` | `all` | n/a | YES (reason + version) | planned (master) |
| `cap:team_master_manage` | `team_master_manage` | `all` | n/a | YES | planned (master) |
| `cap:pii_view` | `pii_view` | effective resource scope | n/a | n/a | read redaction gate |
| `cap:pii_export` | `pii_export` | `all` (admin only) | n/a | YES | planned |
| `cap:audit_view` | `audit_view` | effective resource scope | n/a | n/a | `direct_entry_read_audit` |
| `cap:entry_restore` | `entry_restore` | effective resource scope | n/a | YES (reason + version) | planned |
| `cap:ai_report_capability_view` | `ai.capability.view` | n/a (read-only flag) | n/a | n/a | `GET /api/ai/reports/capability` (`api:001`) |
| `cap:ai_report_create` | `ai.report.create` | effective resource scope | n/a | n/a | `POST /api/ai/reports` (`api:002`) |
| `cap:ai_report_history_view` | `ai.report.history.view` | effective resource scope | n/a | n/a | `GET /api/ai/reports/history` (`api:003`) |
| `cap:ai_report_status_view` | `ai.report.status.view` | effective resource scope | n/a | n/a | `GET /api/ai/reports/[jobId]` (`api:004`) |
| `cap:ai_report_analysis_view` | `ai.report.analysis.view` | effective resource scope | n/a | n/a | `GET /api/ai/reports/[jobId]/analysis` (`api:005`) |
| `cap:ai_report_review` | `ai.report.review` | effective resource scope | **DECISION PENDING** (xem 0 §6) | YES (reason + OCC + actor/cursor isolation đã có trong `ai_report_approve_revision` / `ai_report_reject_revision`) | `POST /api/ai/reports/[jobId]/review` (`api:006`) |
| `cap:ai_settings_view` | `ai.settings.view` | n/a | n/a | n/a | `GET /api/ai/settings` (`api:008`) |
| `cap:ai_settings_write` | `ai.settings.write` | `all` | n/a (single trusted admin) | YES (audit + version) | `POST /api/ai/settings`, `test`, `rotate`, `activate`, `disable` (`api:007`, `api:009`–`api:012`) |
| `cap:ops_view_pipeline` | `ops.view_pipeline` | `all`/`team` (chưa per-source filter) | n/a | n/a | `/pipeline-check` (`page:003`, `op:001`–`op:003`) |
| `cap:pilot_access` | `pilot.access` | n/a | n/a | n/a | `src/proxy.ts` Basic Auth (`gate:001`) — **lớp ngoài, không phải business capability** |

> **ID quy ước.** Mọi row trong ma trận dưới dùng `id_t:capability = <cap>:<NNN>` từ bảng này (neo về auth contract W02). Mọi row trong ma trận cũng neo về `id` từ inventory (vd `api:002`, `page:005`). **Không sinh ID mới** — nếu cần capability mới, phải ghi vào handoff W02-R3 chứ không mở ở đây.

> **Three-way split (không được collapse).**
> - `change_review`: dùng cho direct-entry change request; **second-party** enforced ở RPC.
> - `entry_privileged_edit`: dùng cho admin/kế toán edit; **single-step** không cần second-party, có reason + version + audit.
> - `ai.report.review`: dùng cho AI report review; **second-party rule chưa quyết** (`decision:ai-self-approval` vẫn pending).
> Việc collapse bất kỳ cặp nào trong 3 capability này sẽ phá audit ở cả 3 phía (xem `p3-access-surfaces.md` §7.1 + §11.7).

### 2.4. Three-way split — non-conflation rule (neo §7.1 + §11.7 inventory)

| Capability | Authority | Re-use forbidden in | Self-review | Reason / Version / Audit |
|---|---|---|---|---|
| `change_review` | DB (P1.6 W03 RPC) | **AI review path** (`api:006`); **privileged edit** (`api:007` payment-edit SUBMITTED) | YES (proposer ≠ reviewer) | YES (mandatory) |
| `entry_privileged_edit` | DB (P1.6 W03 RPC) | **change request approve/reject**; **AI review** | NO | YES (mandatory) |
| `ai.report.review` | Route layer (`api:006`) + DB (G5 RPC) | **change_review**; **entry_privileged_edit** | **PENDING_DECISION** (`decision:ai-self-approval`) | YES (OCC + actor/cursor isolation via `ai_report_approve_revision` / `ai_report_reject_revision`) |

> Bất kỳ code review nào muốn "dùng `change_review` cho AI approval" hoặc "dùng `entry_privileged_edit` cho change request review" **phải bị từ chối** trong review. Capability share tên ≠ capability share semantic.

---

## 3. Ma trận surface — per-page, per-API

Mỗi row là **neo về ID trong inventory** (§2 / §4 / §7 inventory). Mỗi column là một phần của defense-in-depth. **Không sinh ID mới.** Nếu cần mở rộng, mở riêng ở `p3-access-surfaces.md` qua mà không liệt vào đây.

### 3.1. Page routes (`page:*` từ inventory §1)

| ID (inventory) | Path | R/W | Public/Authenticated | Capability | Scope | Route enforcement | RPC enforcement | Audit event | Deny HTTP code | Migration / runtime owner |
|---|---|---|---|---|---|---|---|---|---|---|
| `page:001` | `/` | R | Public | n/a (landing) | n/a | none (landing) | n/a | n/a | n/a | T0 |
| `page:002` | `/dashboard` | R | Authenticated | `report.view` (BoD=`all`, Staff=`own`, Leader=`team`) | `own`/`team`/`all` | `auth.getUser()` + `resolveActor()` + capability map in route segment | `service_role` RPC read với scope predicate; **không** direct table | `direct_entry_read_audit` (admin/leader) hoặc scoped read (BoD) | 401 unauth, 403 capability, 404 not-found (không leak existence) | T1B (route) + T1C (P3 guard) |
| `page:003` | `/pipeline-check` | R | Authenticated | `ops.view_pipeline` | `all`/`team` (chưa per-source filter — gap:002) | gate `gate:001` + flag `PIPELINE_CHECK_ENABLED` + `auth.getUser()` + capability check (slice 3) | service-role read + scoped WHERE (slice 3) | `ops_view_pipeline` audit (slice 5) | 401/403/404 + env-404 disabled | T1B |
| `page:004` | `/dashboard/loading` | R | Authenticated (inherit) | inherits from `page:002` | inherits | inherits | inherits | inherits | inherits | T0 |
| `page:005` | `/direct-entry` (P1.6 W04-S02 fixture shell) | RW | Authenticated | `entry_create` / `entry_own` / `entry_team` / `entry_admin` per actor + per row | `own`/`team`/`all` | `auth.getUser()` + `getDirectEntryActor` + capability per RPC call (slice 3); flag `DIRECT_ENTRY_UI_ENABLED` đã có ở S02; demo mode (khi `DIRECT_ENTRY_API_ENABLED !== "true"`) render fixture, không gọi `/api/direct-entry/*`; live mode không fallback fixture | 20 service-role RPC (P1.6 W03 17 + W04-S03A 1 + W04-S03CD 2) — mọi actor argument từ resolved actor, không từ client | `direct_entry_audit_events` + UI `pending` state | 401/403 + RPC deny codes (`CAPABILITY_DENIED`, `ACTION_SCOPE_MISMATCH`, `EXPECTED_VERSION_MISMATCH`, `SELF_REVIEW_DENIED`, `IDEMPOTENCY_KEY_MISMATCH`, `RESTRICTED_REASON_REQUIRED`, `DRAFT_CONFLICT`, `DRAFT_LIMIT_EXCEEDED`) | T1B (route, UI) + T1C (P3 capability check) |

> **Layout wrappers (`page:layout:001`/`002` từ inventory).** Không cần capability riêng — chỉ kế thừa từ matcher của proxy + flag env. P3 chỉ đồng bộ matcher ↔ route khi thêm surface mới.

### 3.2. API routes (`api:*` từ inventory §2)

| ID (inventory) | Method + Path | R/W | Public/Authenticated | Capability | Scope | Route enforcement | RPC enforcement | Audit event | Deny HTTP code | Owner |
|---|---|---|---|---|---|---|---|---|---|---|
| `api:001` | `GET /api/ai/reports/capability` | R | Authenticated | `ai.capability.view` | n/a (read-only flag) | gate + flag `AI_REPORTS_ENABLED` + `auth.getUser()` + capability (slice 3) | service-role read provider config | `direct_entry_audit_events` (slice 5) | 401/403/404 | T1A |
| `api:002` | `POST /api/ai/reports` (enqueue) | W | Authenticated | `ai.report.create` | per caller (own scope chưa tách) | gate + flag + `checkSameOriginRequest` + `auth.getUser()` + capability (slice 3) | `ai_report_enqueue` (db:f:013) với `actor_ref` từ session (gap:001) | `ai_report_audit_events` (immutable trigger) | 401/403/404/`503` rate-limit | T1A |
| `api:003` | `GET /api/ai/reports/history` | R | Authenticated | `ai.report.history.view` | per row ownership (gap:003) | gate + flag + `auth.getUser()` + capability + per-row scope check (slice 3) | `ai_report_history` (db:f:p1.5-G5:004) cursor + actor filter (P3 W05) | `ai_report_audit_events` | 401/403/404 | T1A |
| `api:004` | `GET /api/ai/reports/[jobId]` | R | Authenticated | `ai.report.status.view` | per row ownership | gate + flag + `auth.getUser()` + capability + per-row scope check | `ai_report_status` (db:f:019) | `ai_report_audit_events` | 401/403/404 | T1A |
| `api:005` | `GET /api/ai/reports/[jobId]/analysis` | R | Authenticated | `ai.report.analysis.view` | per row ownership (HIGH risk — gap:003) | gate + flag + `auth.getUser()` + capability + per-row scope check | `ai_report_status` projection (analysis inside) | `ai_report_audit_events` | 401/403/404 | T1A |
| `api:006` | `POST /api/ai/reports/[jobId]/review` | W | Authenticated | `ai.report.review` (DECISION: self-approval vẫn pending — 0 §6) | per row ownership | gate + flag + `checkSameOriginRequest` + `auth.getUser()` + capability + (optional) self-approval check | `ai_report_approve_revision` / `ai_report_reject_revision` (db:f:p1.5-G5:002/003) với OCC + actor/cursor isolation — **không** direct UPDATE | `ai_report_audit_events` + `ai_report_revisions` append-only | 401/403/404 + `SELF_REVIEW_DENIED` (nếu T0 chọn option A — xem §6) | T1A |
| `api:007` | `POST /api/ai/settings` | W | Authenticated | `ai.settings.write` (admin only) | `all` | gate + flag + `checkSameOriginRequest` + `auth.getUser()` + capability + rate-limit + reason (slice 3) | service-role save config | `ai_provider_config_audit_events` (immutable trigger) | 401/403/404/`503` rate-limit | T1A |
| `api:008` | `GET /api/ai/settings` | R | Authenticated | `ai.settings.view` | n/a (sanitized) | gate + flag + `auth.getUser()` + capability | service-role read projection (sanitize) | `direct_entry_audit_events` | 401/403/404 | T1A |
| `api:009` | `POST /api/ai/settings/test` | W | Authenticated | `ai.settings.write` | `all` | gate + flag + CSRF + outbound SSRF guard + `auth.getUser()` + capability | service-role test connection | `ai_provider_config_audit_events` | 401/403/404 + outbound-block | T1A |
| `api:010` | `POST /api/ai/settings/rotate` | W | Authenticated | `ai.settings.write` | `all` | gate + flag + rate-limit + CSRF + `auth.getUser()` + capability + reason | service-role rotate (version mới) | `ai_provider_config_audit_events` | 401/403/404/`503` | T1A |
| `api:011` | `POST /api/ai/settings/activate` | W | Authenticated | `ai.settings.write` | `all` | gate + flag + rate-limit + CSRF + `auth.getUser()` + capability | service-role activate (overwrite active) | `ai_provider_config_audit_events` | 401/403/404/`503` | T1A |
| `api:012` | `POST /api/ai/settings/disable` | W | Authenticated | `ai.settings.write` | `all` | gate + flag + rate-limit + CSRF + `auth.getUser()` + capability | service-role disable | `ai_provider_config_audit_events` | 401/403/404/`503` | T1A |
| `api:013` | `POST /api/ai/worker/run` | W | Service (worker token) | n/a (system identity, **không** thuộc human RBAC) | n/a | `x-ai-worker-token` (constant-time compare) + rotate policy (slice 5 audit) | service-role claim (`ai_report_claim` db:f:014) | `ai_report_audit_events` (immutable) + token rotate event | 401/`503` rate-limit | T1A |
| `p1.6:001` | `POST /api/direct-entry/batches` (W04-S03B) | W | Authenticated | `entry_create` + `submission_create` | `own` | `DIRECT_ENTRY_API_ENABLED` (server flag) + `checkSameOriginRequest` + `auth.getUser()` + `getDirectEntryActor` + capability (slice 3); JSON body + 1–128 char `Idempotency-Key` + 64 KiB body cap + reject nested authority fields | `direct_entry_create_batch` (db:f:p1.6:001) — chỉ RPC, no table DML | `direct_entry_audit_events` + `direct_entry_revisions` | 401/403/404 + RPC deny codes | T1B |
| `p1.6:002` | `GET /api/direct-entry/entries/[entryId]` (W04-S03B) | R | Authenticated | exact `entry_*` scope + optional PII/payment/document capability gates | `own`/`team`/`all` per row | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + `getDirectEntryActor` + capability + per-row scope check | `direct_entry_read_projection` (db:f:p1.6:016) — redaction bằng capability flag | `direct_entry_audit_events` | 401/403/404 | T1B |
| `p1.6:003` | `POST /api/direct-entry/[id]/submit` | W | Authenticated | `submission_create` | `own` | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability | `direct_entry_transition_submission` (db:f:p1.6:005) | `direct_entry_audit_events` | 401/403/404 + RPC deny | T1B |
| `p1.6:004` | `POST /api/direct-entry/[id]/withdraw` | W | Authenticated | proposer `change_request_create` (proposer only) | `own` | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + proposer check | `direct_entry_withdraw_change_request` (db:f:p1.6:012) | `direct_entry_audit_events` | 401/403/404 | T1B |
| `p1.6:005` | `POST /api/direct-entry/[id]/correct` | W | Authenticated | `entry_correct` | `own` | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + `expected_version` | `direct_entry_correct_latest_status` (db:f:p1.6:008) | `direct_entry_audit_events` | 401/403/404 + RPC deny | T1B |
| `p1.6:006` | `POST /api/change-requests/[id]/approve` | W | Authenticated | `change_review` + per-item scope | per-item | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + **second-party check enforced ở RPC** (không cần check ở route) | `direct_entry_approve_change_request` (db:f:p1.6:013) | `direct_entry_audit_events` | 401/403/404 + `SELF_REVIEW_DENIED` | T1B |
| `p1.6:007` | `POST /api/change-requests/[id]/reject` | W | Authenticated | `change_review` + per-item scope | per-item | như approve | `direct_entry_reject_change_request` (db:f:p1.6:014) | `direct_entry_audit_events` | 401/403/404 + `SELF_REVIEW_DENIED` | T1B |
| `p1.6:008` | `POST /api/employment-status/[id]/apply` | W | Authenticated | `employment_status.apply` + scope | effective resource | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + `expected_version` | `direct_entry_apply_employment_status` (db:f:p1.6:007) | `direct_entry_audit_events` | 401/403/404 + RPC deny | T1B |
| `p1.6:009` | `GET /api/documents/[id]` | R | Authenticated | `document_view` + scope | per row | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + redaction gate | `direct_entry_read_projection` (PII redaction) | `direct_entry_audit_events` | 401/403/404 | T1B |
| `p1.6:010` | `POST /api/documents/upload` | W | Authenticated + worker (system) | `document_upload` (DRAFT = exact scope) / `entry_privileged_edit` (SUBMITTED) | effective resource | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + idempotency + CSRF (route) + worker call `direct_entry_append_document_event` (system) | `direct_entry_create_document_metadata` (db:f:p1.6:009) + `direct_entry_append_document_event` (db:f:p1.6:010 — service-role only) | `direct_entry_audit_events` | 401/403/404 + RPC deny | T1B (route) + T1A (worker boundary) |
| `p1.6:011` | `GET /api/pii/[candidateId]` | R | Authenticated | `pii_view` + scope | `own` (self) / `team` / `all` | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability | `direct_entry_read_projection` (PII redaction flag) | `direct_entry_audit_events` | 401/403/404 | T1B |
| `p1.6:012` | `GET /api/pii/export` | R | Authenticated | `pii_export` (admin only) | `all` | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + reason (planned) | service-role scoped read | `direct_entry_audit_events` | 401/403/404 | T1B |
| `p1.6:013` | `GET /api/audit` | R | Authenticated | `audit_view` + scope | per row | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability | `direct_entry_read_audit` (db:f:p1.6:017) | `direct_entry_audit_events` | 401/403/404 | T1B |
| `p1.6:014` | `POST /api/payments/[id]/edit` | W | Authenticated | `payment_edit` (SUBMITTED) / `entry_*` (DRAFT) + scope | per row | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + `expected_version` + `reason_ref` | `direct_entry_update_payment` (db:f:p1.6:006) | `direct_entry_audit_events` | 401/403/404 + RPC deny | T1B |
| `p1.6:015` | `POST /api/admin/privileged-edit` | W | Authenticated | `entry_privileged_edit` + scope | effective resource | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + capability + reason + `expected_version` + CSRF | `direct_entry_privileged_edit` (db:f:p1.6:015) | `direct_entry_audit_events` | 401/403/404 + RPC deny | T1B |
| `p1.6:016` | `GET /api/direct-entry/session` (W04-S03A) | R | Authenticated | n/a (returns actor projection only) | n/a | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + `getDirectEntryActor`; **không** đọc actor/role/capability/scope từ request; **RPC không tự ghi audit event** (xem errata #2 trong `docs/handoffs/p3-w01-s03.md`) | `direct_entry_resolve_actor_context` (db:f:p1.6:W04-S03A:001) — RPC mới của W04-S03A, narrow | n/a (no audit; future P3 slice) | 401/403 (sanitized) + `404` flag off | T1B |
| `p1.6:route:W04-S03B:001` | `POST /api/direct-entry/batches` (W04-S03B committed) | W | Authenticated | `entry_create` + `submission_create` | `own` | `DIRECT_ENTRY_API_ENABLED` + CSRF + body cap + reject authority fields + `auth.getUser()` + `getDirectEntryActor` + capability | `direct_entry_create_batch` (db:f:p1.6:001) | `direct_entry_audit_events` | 401/403/404 + RPC deny | T1B |
| `p1.6:route:W04-S03B:002` | `GET /api/direct-entry/entries/[entryId]` (W04-S03B committed) | R | Authenticated | exact `entry_*` scope + optional PII/payment/document capability | per row | như `p1.6:002` | `direct_entry_read_projection` (db:f:p1.6:016) | `direct_entry_audit_events` | 401/403/404 | T1B |
| `p1.6:route:W04-S03CD:001` | `GET /api/direct-entry/catalog` (W04-S03CD committed) | R | Authenticated | `entry_create` / `entry_own` | n/a | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + `getDirectEntryActor` + capability + `p_effective_date` (required) | `direct_entry_input_catalog` (db:f:p1.6:W04-S03CD:001) | `direct_entry_audit_events` (none — read) | 401/403/404 + `22023` if missing effective date | T1B |
| `p1.6:route:W04-S03CD:002` | `GET /api/direct-entry/drafts` (W04-S03CD committed) | R | Authenticated | exact `entry_own` + actor ownership | own | `DIRECT_ENTRY_API_ENABLED` + `auth.getUser()` + `getDirectEntryActor` + capability; list ceiling 500; vượt ⇒ `413 DRAFT_LIMIT_EXCEEDED` | `direct_entry_list_own_drafts` (db:f:p1.6:W04-S03CD:002) | `direct_entry_audit_events` (none — read) | 401/403/404/413 | T1B |
| `p1.6:route:W04-S03CD:003` | `PATCH /api/direct-entry/entries/[entryId]` (W04-S03CD committed; new method) | W | Authenticated | exact `entry_*` scope + `expected_version` | per row | `DIRECT_ENTRY_API_ENABLED` + CSRF + body cap + `Idempotency-Key` + `auth.getUser()` + `getDirectEntryActor` + capability + `expected_version`; stale ⇒ `409 DRAFT_CONFLICT`; live controller 6-state machine + `markDraftConflict` + `applyServerCopy`/`keepLocalCopy` — không silent merge/retry | `direct_entry_update_draft_row` (db:f:p1.6:003) — replace forward-only | `direct_entry_audit_events` | 401/403/404/409/413 + RPC deny | T1B |

### 3.3. Tables / Views / RPC — không đổi (inventory đã cover)

| Nhóm | Inventory ID | Owner | Cutover rule |
|---|---|---|---|
| Foundation tables (P0) | `db:t:001`–`db:t:005` | T1B | **Không mở.** RLS + revoke đã cover. Cutover: không cần thay đổi schema. |
| Reporting views | `db:v:001`–`db:v:003` | T1B | **Không mở.** P3 chỉ thêm server-side predicate (slice 3) trước khi gọi. |
| P0 RPCs | `db:f:001`–`db:f:012` | T2 (n8n) | **Không mở.** Đã EXECUTE-only cho `service_role`. |
| AI gateway tables | `db:t:006`–`db:t:011` | T1A | **Không mở schema.** Cutover: chỉ thay caller (`PILOT_ACTOR_REF` → `auth_subject`). |
| AI gateway RPCs | `db:f:013`–`db:f:024` | T1A | **Không mở schema.** Cutover: caller truyền `actor_ref` từ resolved session. |
| G5 review/history RPCs | `db:f:p1.5-G5:001`–`db:f:p1.5-G5:004` | T1A | **Không mở.** OCC + actor/cursor isolation đã có. Cutover: route `api:006` resolve session → truyền actor. |
| P1.6 foundation tables | `db:t:p1.6:001`–`db:t:p1.6:026` | T1B | **Không mở schema.** Tất cả 26 tables force RLS + revoke table DML. Cutover: route resolve actor → truyền `p_actor` cho RPC. |
| P1.6 view | `db:v:p1.6:001` (`direct_entry_current_documents`) | T1B | `security_invoker=true`. Cutover: route filter qua capability + per-row scope trước khi trả. |
| P1.6 application RPCs | `db:f:p1.6:001`–`db:f:p1.6:017` (17 W03) | T1B | **Không mở schema.** Cutover: route resolve actor → truyền `p_actor` cho RPC. |
| W04-S03A actor-context RPC | `db:f:p1.6:W04-S03A:001` (`direct_entry_resolve_actor_context`) | T1B | NEW RPC của W04-S03A (route `p1.6:016`). **Direct Entry RPC count: 17 → 18** (xem §7 evidence). |
| W04-S03CD catalog + own-drafts RPC | `db:f:p1.6:W04-S03CD:001` (`direct_entry_input_catalog`) + `db:f:p1.6:W04-S03CD:002` (`direct_entry_list_own_drafts`) | T1B | NEW RPC của W04-S03CD (routes `p1.6:route:W04-S03CD:001/002`). **Direct Entry RPC count: 18 → 20**. `direct_entry_update_draft_row` (db:f:p1.6:003) replaced forward-only, signature `(uuid, uuid, uuid, integer, jsonb, text)` unchanged, **không tính mới**. |
| W04-S03B RPCs | (none new) | T1B | W04-S03B **không thêm migration**. Chỉ dùng 2 RPC có sẵn: `direct_entry_create_batch` + `direct_entry_read_projection`. RPC count giữ 18. |

### 3.4. Server-only repositories (`repo:*` từ inventory §4)

| ID | File | Cutover change | Owner |
|---|---|---|---|
| `repo:001` | `src/lib/reporting/pipeline-check-server.ts` | Slice 3: thay service-role read bằng **scoped WHERE theo `ops.view_pipeline` + actor scope** (gap:002). Service-role vẫn dùng vì RPC đã authorize. | T1B |
| `repo:002` | `src/lib/reporting/p1-reporting-server.ts` | Slice 3: scoped read theo `report.view` + scope (`own`/`team`/`all`). | T1B |
| `repo:003` | `src/lib/reporting/p1-options-server.ts` | Slice 3: scoped options theo scope. | T1B |
| `repo:004` | `src/lib/ai/gateway/server/review.mjs` | Slice 3: thay `PILOT_ACTOR_REF = "pilot-admin"` bằng actor_ref từ session (gap:001). Gọi `ai_report_approve_revision` / `ai_report_reject_revision` (OCC + actor/cursor isolation). | T1A |
| `repo:005` | `src/lib/ai/gateway/server/repository.mjs` | Slice 3: actor_ref từ session. | T1A |
| `repo:006` | `src/lib/ai/gateway/server/packet-source.mjs` | Slice 3: actor_ref từ session. | T1A |
| `repo:007` | `src/lib/ai-config/server/store.mjs` | Slice 3 + slice 6: actor_ref từ session + admin capability check. | T1A |
| `repo:008` | `src/lib/ai-config/server/settings-wiring.ts` | Slice 3: wrapper pass-through actor. | T1A |
| `repo:009` | `src/lib/ai-config/server/settings.mjs` | Slice 3: business logic + actor từ session. | T1A |

> **Note.** `createPublicSupabaseClient` (publishable key) hiện chưa có caller (inventory §4 trailing note). Khi P3 W05 tách read-only role, page reads có thể dùng `createPublicSupabaseClient` + cookie session — **chỉ cho đọc**, vẫn phải qua RPC narrow với scope predicate. **Không** dùng publishable client cho write.

### 3.5. Pilot gate / proxy matcher (`gate:*` từ inventory §5)

| ID | Surface | Cutover change |
|---|---|---|
| `gate:001` | `src/proxy.ts` | Slice 1+3: Basic Auth vẫn còn cho đến slice 7. Khi slice 7 chạy, Basic Auth retirement. Match list thu hẹp dần theo từng slice. |
| `gate:002` | `src/lib/auth/pilot-access.ts` (`isPilotProtectedPath`) | Slice 1+7: đồng bộ matcher ↔ route khi thêm surface mới; trước slice 7, matcher vẫn bảo vệ cùng path. Sau slice 7, matcher vẫn còn (path-level protection) nhưng role check đã chuyển vào route handler. |
| `gate:003` | `evaluatePilotAccess` (dev bypass) | Không mở. `development` mode vẫn cho qua Basic Auth. |

### 3.6. n8n (`n8n:*` từ inventory §9)

| ID | Workflow | Cutover change |
|---|---|---|
| `n8n:001`–`n8n:004` | `P0-T2-WF01` (n8n WF01, DEV service role) | **Không thuộc human RBAC.** Cutover: n8n vẫn dùng `service_role` credential. `decision:003` vẫn pending — P3 chưa thêm capability cho n8n. |

### 3.7. App Nav Registry ↔ backend mapping (inventory §10)

| Nav ID | Path | P3 capability (server-filtered) |
|---|---|---|
| `dashboard` | `/dashboard` | `report.view` + scope (`own`/`team`/`all` per actor) |
| `pipeline-check` | `/pipeline-check` | `ops.view_pipeline` + scope (`all` chỉ BoD / `team` chỉ leader) |
| `direct-entry` (planned) | `/direct-entry` | `entry_create` / `entry_own` / `entry_team` / `entry_admin` per actor |

> **Slice 4:** App Shell filter `CURRENT_NAV_ENTRIES` ở server-side theo `actor.capability`. Direct URL vẫn phải fail ở route handler (`page:002`, `page:003`, `page:005`).

### 3.8. Env flags (inventory §6)

| ID | Flag | Slice | Cutover rule |
|---|---|---|---|
| `env:001` | `AI_REPORTS_ENABLED` | slice 3 | Giữ nguyên. Fail-closed. |
| `env:002` | `AI_SETTINGS_ENABLED` | slice 3 | Giữ nguyên. Fail-closed. |
| `env:003` | `AI_PROVIDER_KEY` | n/a (provider-only) | Giữ nguyên. |
| `env:004` | `AI_WORKER_TOKEN` | slice 1+5 | Giữ nguyên; rotate policy mở ở slice 5 (audit). |
| `env:005` | `AI_SETTINGS_RATE_LIMIT_*` | slice 1 | Giữ nguyên. |
| `env:006` (new in W04-S02) | `DIRECT_ENTRY_UI_ENABLED` | slice 3 | Giữ nguyên (W04-S02 đã khóa). |
| `env:007` (new in W04-S03A) | `DIRECT_ENTRY_API_ENABLED` | slice 3 | Giữ nguyên (W04-S03A đã khóa). |

---

## 4. Go-live slice (7 bước)

Thứ tự nhỏ nhất để có thể cutover mà không break pilot. Mỗi slice có: gate env, owner, reversible check, evidence.

### Slice 1 — Login / Logout / Session

| Field | Value |
|---|---|
| Mục tiêu | `@supabase/ssr` cookie session hoạt động; Basic Auth vẫn song song (pilot gọi qua cùng matcher). |
| Page/API liên quan | (login form + logout form — TBD ở implementation; **không** mở trong task này) |
| Capability liên quan | `pilot.access` (gate ngoài) — gate, không phải business |
| Auth method | Supabase Auth; **`@supabase/ssr` + `auth.getUser()`** (khóa từ W02-R2) |
| Flag env | `AI_REPORTS_ENABLED`, `AI_SETTINGS_ENABLED`, `AI_WORKER_TOKEN` (giữ nguyên) |
| Owner | T1B (route + session) + T1C (P3 policy) |
| Reversible | Rollback: tắt cookie session path → matcher chỉ giữ Basic Auth (gate:001). |
| Evidence | (W04-S02 đã có responsive UI fixture; W04-S03A đã có server actor boundary — không bao gồm login form) |
| Boundary check | Sau slice 1: **cookie session chỉ resolve identity, không** truyền actor/role/capability/scope vào audit/RPC. |

> **Lưu ý.** Slice 1 đã có 1 phần đi trước (W04-S03A) cho actor context; còn lại (login UI + callback + logout) sẽ mở ở implementation. Tài liệu này **không** mở thêm.

### Slice 2 — Actor bootstrap

| Field | Value |
|---|---|
| Mục tiêu | Resolve `auth_subject` → `app_user_id` + capability + scope + recruiter suggestion qua `direct_entry_resolve_actor_context` (W04-S03A). |
| Surface | `p1.6:016` (`GET /api/direct-entry/session`) + internal call từ route handlers. |
| Capability liên quan | n/a (resolve only) |
| Flag env | `DIRECT_ENTRY_API_ENABLED=true` (W04-S03A đã khóa) |
| Owner | T1B |
| Reversible | Disable API flag → trả 404 sanitize trước khi session. |
| Evidence | W04-S03A: 23 applied migration, 18 service-role RPCs (was 17); `pnpm run test:p1.6-w04-s03a` 10/10 + W02 25/25. |
| Boundary check | Client **không** được nhập actor, user, role, capability, scope; route trả về sanitized 401/403. |

### Slice 3 — Page / API guard

| Field | Value |
|---|---|
| Mục tiêu | Mỗi page/API đã liệt kê ở §3.1 + §3.2 kiểm tra capability đúng theo ma trận. Server repos `repo:001`–`repo:009` thay `PILOT_ACTOR_REF` bằng actor từ session. |
| Surface | tất cả `page:*`, `api:*`, P1.6 `DB_ONLY` (`p1.6:003`–`p1.6:015`) + P1.6 route committed on `p1.6-integration` (`p1.6:016`, `p1.6:017`, `p1.6:route:W04-S03B:001/002`, `p1.6:route:W04-S03CD:001/002/003`), `repo:001`–`repo:009`. |
| Capability liên quan | mọi capability trong §2.3 |
| Flag env | `DIRECT_ENTRY_UI_ENABLED`, `DIRECT_ENTRY_API_ENABLED`, `AI_REPORTS_ENABLED`, `AI_SETTINGS_ENABLED`, `PIPELINE_CHECK_ENABLED` (slice 1 đã có) |
| Owner | T1A (AI APIs + repos `repo:004`–`repo:009`) + T1B (Direct Entry APIs + repos `repo:001`–`repo:003`) + T1C (P3 capability map) |
| Reversible | Revert flag → trả 404 sanitize; revert actor wiring → dùng `PILOT_ACTOR_REF` lại (nhưng không khuyến nghị). |
| Evidence | W02: 25/25 auth tests; W03: 95/95 G3; W04-S03A: 10/10; W04-S03B: 10/10 + DEV synthetic 2 rows. (Slice 3 evidence sẽ thêm ở implementation.) |
| Boundary check | Direct URL bypass UI phải fail ở route handler; nav ẩn không thay thế capability check (slice 4). |

### Slice 4 — App Nav filtering

| Field | Value |
|---|---|
| Mục tiêu | `CURRENT_NAV_ENTRIES` filter theo `actor.capability` server-side trước khi render. |
| Surface | App Shell (`src/lib/navigation/registry.ts` — registry từ `app-nav-01a`) |
| Capability liên quan | `report.view`, `ops.view_pipeline`, `entry_*` per actor |
| Flag env | n/a (không cần thêm) |
| Owner | T1B (App Shell) + T1C (filter map) |
| Reversible | Disable filter → render tất cả `current` entries (revert về APP-NAV-01A baseline). |
| Evidence | (Implementation sẽ tạo `test:nav-filter` harness — TBD) |
| Boundary check | Direct URL vẫn phải fail ở slice 3; nav ẩn **không** thay thế capability check. |

### Slice 5 — Audit

| Field | Value |
|---|---|
| Mục tiêu | Mọi capability decision (allow + deny) ghi vào `direct_entry_audit_events` + `ai_report_audit_events` + `ai_provider_config_audit_events` với envelope đã chuẩn (actor/app_user ref opaque, action/capability, resource ref opaque, scope, timestamp, denial code, optional `reason_ref`). Free-text reason, business value, CCCD, bank account, token, email, raw claim **không** xuất hiện trong audit. |
| Surface | (server-side audit hook — implementation TBD) |
| Capability liên quan | n/a |
| Flag env | n/a (audit luôn on) |
| Owner | T1A (AI audit) + T1B (Direct Entry audit) + T1C (audit envelope policy) |
| Reversible | (audit không reversible — chỉ retention window mở ở `decision:005`) |
| Evidence | W03: audit envelope đã có trong `direct_entry_audit_events`; G5-DEV01: OCC + actor/cursor isolation đã verify. |
| Boundary check | `reason_ref` opaque (không lộ restricted reason text ở audit; restricted reason ở store riêng). |

### Slice 6 — Admin / bootstrap user

| Field | Value |
|---|---|
| Mục tiêu | Tạo / link / assign / revoke user; non-admin kể cả BoD thường không được gọi mutation admin. Admin capability tách khỏi business role. |
| Surface | (admin form / server route — implementation TBD; không mở trong task này) |
| Capability liên quan | `ai.settings.write`, `recruiter_master_manage`, `team_master_manage`, `entry_privileged_edit` (admin) |
| Flag env | n/a |
| Owner | T1B (admin route) + PO (chính sách onboarding) |
| Reversible | Disable admin route → không có mutation path. |
| Evidence | (TBD) |
| Boundary check | Mọi admin mutation phải có `reason` + `audit`; `expected_version` nếu applicable; idempotency bắt buộc (RPC đã có sẵn). |

### Slice 7 — Basic Auth retirement (slice cuối)

| Field | Value |
|---|---|
| Mục tiêu | Tắt `gate:001` (Basic Auth). Proxy matcher giữ path-level (gate:002). Toàn bộ authorization chuyển sang route handler + RPC. |
| Surface | `src/proxy.ts`, `src/lib/auth/pilot-access.ts` |
| Capability liên quan | `pilot.access` retired (audit envelope vẫn ghi `pilot.access` historical entries). |
| Flag env | Tắt `PILOT_ACCESS_USERNAME/PASSWORD` env → middleware fail-closed 503 (gate:001 hiện tại). |
| Owner | T1B (proxy) + T0 (go-live decision) |
| Reversible | (slice cuối — sau slice 7 rollback = re-deploy với Basic Auth on; **chỉ** cho incident) |
| Evidence | Pre-cutover smoke: mọi `page:*` + `api:*` đã pass slice 3+4+5+6 với cookie session + capability check. |
| Boundary check | Không giữ một endpoint bypass auth sau slice 7; rollback chỉ mở production incident, không phải "app chạy được" workaround. |

---

## 5. Library policy (khóa)

### 5.1. Bắt buộc dùng (đã có trong repo)

| Thư viện | Vai trò | Pin version |
|---|---|---|
| `@supabase/ssr` | Server-side session + cookie adapter | (đã có trong `package.json` — không đổi) |
| `next` | Routing + middleware | 16.3.8 (đã pin ở W04-S01) |
| `react` / `react-dom` | UI runtime | 19.2.8 (đã pin ở W04-S01) |
| `radix-ui` / `shadcn-style` | Dialog / Drawer / Tabs / Navigation (W04-S02 đã dùng) | (đã có trong `package.json`) |
| `lucide-react` | Icon | (đã có trong `package.json`) |
| `react-data-grid` | Direct Entry grid (W04-S01 pin) | `7.0.0-beta.61` (W04-S01 pin) |
| `zod` | Payload validation (đã có ở W02) | (đã có trong `package.json`) |

### 5.2. Không thêm khi chưa cần

| Không thêm | Lý do |
|---|---|
| Auth framework mới (NextAuth / Clerk / Auth0) | W02-R2 đã khóa `@supabase/ssr` + Supabase Auth. |
| State library (Redux / Zustand / Jotai) | Server-side filter ở slice 3-4 đủ cho UX. Client state chỉ cần React `useState`/`useReducer` + React Hook Form nếu cần (xem dưới). |
| Form library (React Hook Form / Formik) | Trừ khi form > 8 field hoặc cần async validation orchestration; **không** add trước. Nếu cần sau, ưu tiên RHF (lightweight). |
| Capability-aware authorization engine bên thứ ba (CASL / Oso / accesscontrol) | Capability matrix đã được kiểm thủ công qua W02/W04 + per-RPC OCC. Thêm engine = thêm indirection không cần thiết. |
| Custom focus trap / dialog / menu | Radix/shadcn-style đã có. **Không** tự code. |

### 5.3. Reuse constraint Nhóm-3

| Component | Reuse từ |
|---|---|
| Session adapter | `src/lib/auth/direct-entry-session.ts` (W02-R2) — đã có `createServerClient` + `auth.getUser()` + refresh cache headers |
| Actor resolver | `src/lib/direct-entry/actor-context-repository.ts` (W04-S03A) — đã wrap `direct_entry_resolve_actor_context` |
| Capability / scope check | `src/lib/auth/direct-entry-v2.ts` (W02-R2) — đã có `resolveActor()` + `entry_*` scope binding |
| Audit envelope | `src/lib/direct-entry/audit-envelope.ts` (W03) — đã sanitize |
| UI components | `src/components/direct-entry/{grid-smoke,typeahead-picker-smoke}.tsx` (W04-S01/S02) — pin grid + native typeahead |
| Form drawer | Radix `Dialog`/`Drawer` (W04-S02 đã dùng) |

---

## 6. AI self-approval — `PENDING_DECISION` với 2 option

### 6.1. Context (neo về inventory §11.7)

- `api:006` (`POST /api/ai/reports/[jobId]/review`) hiện có actor = `PILOT_ACTOR_REF = "pilot-admin"` cho cả enqueue (`api:002`) và review. Trong pilot, 1 actor duy nhất nên không có second-party check.
- W03 đã đóng self-approval cho **direct-entry** `change_review` (proposer ≠ reviewer enforced ở `direct_entry_approve_change_request` / `direct_entry_reject_change_request` — `db:f:p1.6:013/014`). **Khác capability.**
- G5-DEV01 đã cung cấp `ai_report_approve_revision` / `ai_report_reject_revision` với OCC + actor/cursor isolation — nhưng **không** enforce `actor_ref(job.actor_ref) ≠ actor_ref(reviewer)`. G5-DEV01 **không mở / không đóng** `decision:ai-self-approval` — chỉ apply migration đã có từ trước.
- W03 + W02 auth contract `change_review` chỉ dùng cho direct-entry change request. `ai.report.review` là capability **riêng** — không infer từ `change_review`.

### 6.2. Câu hỏi quyết định

Có cho phép self-approval cho AI report (cùng actor enqueue + approve) không?

### 6.3. Option A — Cấm self-approval cho AI

| Field | Value |
|---|---|
| Rule | `actor_ref(job.actor_ref) ≠ actor_ref(reviewer)` |
| Where | Route layer `POST /api/ai/reports/[jobId]/review` (`api:006`) — check trước khi gọi `ai_report_approve_revision` / `ai_report_reject_revision`. |
| Capability | `ai.report.review` vẫn riêng; **không** thêm `change_review` vào AI path. |
| RPC | Gọi `ai_report_approve_revision(job_id, expected_revision, reason)` / `ai_report_reject_revision(...)` (OCC + actor/cursor isolation đã có). |
| Self-review denial code | `SELF_REVIEW_DENIED` (giống W03 — consistent denial vocabulary). |
| Lợi | Đồng nhất semantic với direct-entry `change_review` (proposer ≠ reviewer). Audit envelope không cần phân biệt AI vs direct-entry ở self-review rule. |
| Mất | Pilot workflow hiện tại (1 actor enqueue + approve) sẽ fail — cần 2 actor (hoặc bootstrap) để demo approve. |
| Effort | Low — thêm 1 check ở route, ~10 dòng. Đã có OCC + actor/cursor isolation ở DB. |

### 6.4. Option B — Cho phép self-approval

| Field | Value |
|---|---|
| Rule | `actor_ref(job.actor_ref) = actor_ref(reviewer)` allowed. |
| Where | Route layer **không** check self-approval; chỉ check capability `ai.report.review`. |
| Capability | `ai.report.review` riêng. |
| RPC | như option A. |
| Lợi | Pilot hiện tại không cần bootstrap 2 actor. |
| Mất | Audit trail không khớp semantic với direct-entry. Nếu sau này muốn đổi rule, cần re-tool audit + reviewer. |
| Effort | Zero ở route layer; chỉ document. |

### 6.5. Khuyến nghị (chưa quyết — chờ T0)

**Recommendation: Option A (cấm self-approval).**

Lý do:
1. Đồng nhất với direct-entry `change_review` ở W03 (single semantic cho "approver ≠ proposer" trong cả hệ thống).
2. OCC + actor/cursor isolation đã có ở G5-DEV01 (DB side) — chỉ thêm check ở route.
3. Audit envelope không cần phân biệt rule theo capability group.
4. Pilot hiện tại dùng `pilot-admin` cho cả enqueue + review sẽ fail — nhưng đây là **đặc tính** của pilot (1 credential), không phải semantic của prod.

> **Quyết định cuối: T0.** Tài liệu này **không** tự quyết. T1C chỉ nêu option + recommendation.

### 6.6. Tại sao không self-decide

| Hạn chế | Ảnh hưởng |
|---|---|
| FT0 docs-only | Không thay đổi runtime. |
| Policy ở `p3-access-surfaces.md` §11.5 vẫn `PENDING_DECISION` | Inventory vẫn ghi decision chưa đóng. |
| G5-DEV01 không quyết | DEV acceptance không chạm semantic. |
| W02-R2 capability vocab lock | Không mở capability vocab. |
| Direct-entry self-approval rule (W03) | Đã đóng — không suy diễn từ đây cho AI. |

---

## 7. Evidence cập nhật (W04-S03A / W04-S03B / W04-S03C / W04-S03D)

### 7.1. W04-S03A — Server actor resolution boundary

Source: `docs/handoffs/p1.6-w04-s03a.md` (commit `68cf028` trên `feature/p1.6-integration`).

| Field | Value |
|---|---|
| Status | `P1.6-W04-S03A_DEV_PASS_FAST_TRACK` |
| Migration | `20261003180000_p1_6_w04_s03a_actor_context.sql` — applied on DEV (post-apply: 23 applied, 0 pending, 0 checksum mismatch). |
| **RPC count delta** | **17 → 18** Direct Entry service-role RPCs. RPC mới: `direct_entry_resolve_actor_context(p_auth_subject uuid)`. |
| Route mới | `GET /api/direct-entry/session` (gated by `DIRECT_ENTRY_API_ENABLED=true`; sanitized 404 when off). |
| Caller pattern | Route dùng `getDirectEntryActor` (đã có ở W02), `@supabase/ssr` cookie session, `auth.getUser()`, W02 `resolveActor()`. Server-only repository gọi narrow RPC với verified `auth_subject`. |
| Deny codes | Sanitized 401 (unauth), sanitized 403 (disabled/malformed/missing mapping). |
| Response projection | Chỉ `app_user_id`, `capabilities`, resolved `scopes`, `self_recruiter_suggestion`. `Cache-Control: private, no-store`. |
| Reject client fields | Route **không** đọc actor/user/role/capability/scope từ request. |
| Tests | W02: 25/25; S03A: 10/10 (PGlite SQL/ACL); DEV live acceptance: PASS. |
| Impact on inventory | DB side thêm 1 RPC → **Direct Entry RPC count 18** (W03 17 + W04-S03A 1). `db:f:p1.6:W04-S03A:001` được inventory S03 chuẩn hóa (xem `docs/security/p3-access-surfaces.md` §3.5.3). |
| Impact on this plan | Slice 2 đã có actor bootstrap qua RPC này. Slice 3 sẽ dùng nó cho mọi page/API guard. |

### 7.2. W04-S03B — First draft write API

Source: `docs/handoffs/p1.6-w04-s03b.md` (commit `38c9b7e` trên `feature/p1.6-integration`).

| Field | Value |
|---|---|
| Status | `P1.6-W04-S03B_FIRST_WRITE_DEV_PASS_FAST_TRACK` |
| Migration | **None.** W04-S03B không thêm migration. |
| **RPC count delta** | **0** — Direct Entry service-role RPC count giữ **18**. |
| Routes mới | `POST /api/direct-entry/batches` + `GET /api/direct-entry/entries/[entryId]`. Cả hai gated by `DIRECT_ENTRY_API_ENABLED=true`; sanitized 404 when off. |
| RPCs dùng | `direct_entry_create_batch` (db:f:p1.6:001) + `direct_entry_read_projection` (db:f:p1.6:016) — **đã có sẵn** từ W03. |
| Caller pattern | `checkSameOriginRequest` + JSON body + 1–128 char `Idempotency-Key` + 64 KiB body cap + reject nested authority fields (actor, capability, scope, provider, team). Server repository chỉ gọi 2 RPC đã liệt kê; không table DML. |
| Tests | W01: 19/19; W02: 25/25; W03: 19/19; S03A: 10/10; S03B: 10/10; S03B synthetic DEV: 2 rows created in transaction, replay reused same IDs, changed payload returned 409, restricted read passed, denied actor returned 403. |
| Audit | 3 audit events, 2 entry revisions, 1 submission revision, 1 idempotency record (DEV transaction). |
| Impact on inventory | **RPC count giữ 18** (không thêm). 2 route mới đã liệt kê ở ma trận §3.2 với ID tạm `p1.6:route:W04-S03B:001/002`. |
| Impact on this plan | Slice 3 đã có guard cho 2 route này theo ma trận §3.2. |

### 7.3. W04-S03C / W04-S03D — committed (S03CD = `2d5e9fc` on `feature/p1.6-integration`)

| Field | Value |
|---|---|
| Status | **COMMITTED.** W04-S03C merged into W04-S03CD = `P1.6-W04-S03CD_DRAFT_PERSISTENCE_DEV_PASS_FAST_TRACK`. |
| Migration | `20261003200000_p1_6_w04_s03cd_catalog_drafts.sql` — applied on DEV (post-apply: 24 applied, 0 pending, 0 checksum mismatch). |
| **RPC count delta** | **18 → 20**. 2 RPC mới: `direct_entry_input_catalog(p_auth_subject uuid, p_app_user_id uuid, p_effective_date date)` + `direct_entry_list_own_drafts(p_auth_subject uuid, p_app_user_id uuid)`. `direct_entry_update_draft_row` (db:f:p1.6:003) replaced forward-only (signature `(uuid, uuid, uuid, integer, jsonb, text)` unchanged, body merge worker display name); **không tính mới**. |
| Routes mới | `GET /api/direct-entry/catalog` + `GET /api/direct-entry/drafts` (mới path) + `PATCH /api/direct-entry/entries/[entryId]` (mới method). Cả 3 gated by `DIRECT_ENTRY_API_ENABLED=true`. |
| Routes tái sử dụng (S03B) | `POST /api/direct-entry/batches` giờ check trusted effective-date project/recruiter catalog trước khi gọi create RPC. Provider/team derived from effective recruiter master data. |
| Catalog semantics | `direct_entry_input_catalog` chỉ trả active projects + active recruiters + single-membership providers + active teams tại `p_effective_date`. `p_effective_date required` else `22023`. |
| Own-draft ceiling | `direct_entry_list_own_drafts` capped 500; vượt ⇒ `413 DRAFT_LIMIT_EXCEEDED` (không silent truncate) — implement ở route layer qua `result.kind === "too-large"`. |
| OCC stale-version | `direct_entry_update_draft_row` chỉ advance version khi payload hash + expected version match; stale ⇒ `409 DRAFT_CONFLICT` (route layer). Live controller 6-state machine (`clean`/`dirty`/`saving`/`saved`/`conflict`/`error`) + `markDraftConflict` + `applyServerCopy`/`keepLocalCopy` — không silent merge/retry. |
| Idempotency | `Idempotency-Key` 1–128 char; reuse chỉ khi payload hash unchanged; vẫn 64 KiB body cap. |
| Demo mode guard | Demo (khi `DIRECT_ENTRY_API_ENABLED !== "true"`) render fixture, không gọi `/api/direct-entry/*`. Live mode không fallback fixture. |
| Tests | W01 19/19; W02 25/25; W03 19/19; S02 5/5; S03A 10/10; S03B 11/11; S03CD 16/16. S03B regression: cập nhật expected inventory 24 migrations / 20 RPCs; replay, changed-payload conflict, restricted read, audit evidence, rollback, baseline checks passed. |
| Audit | 4 audit events, 3 entry revisions, 2 submission revisions, 2 idempotency records (DEV transaction; rolled back to 0). |
| Impact on inventory | **RPC count 20** (W03 17 + S03A 1 + S03CD 2). 3 route mới đã liệt kê ở ma trận §3.2 với ID `p1.6:route:W04-S03CD:001/002/003`. Catalog: `db:f:p1.6:W04-S03CD:001`; Own-drafts: `db:f:p1.6:W04-S03CD:002`. |
| Impact on this plan | Slice 2 (actor resolve) + slice 3 (capability guard) đã cover các route mới. Slice 5 (audit) có thêm 4 event. |

### 7.4. Số liệu summary hợp lệ cho tài liệu này

| Metric | Value (verified) | Source |
|---|---:|---|
| Direct Entry RPC count (W03) | 17 | `docs/security/p3-access-surfaces.md` §3.5.3 |
| Direct Entry RPC count (W04-S03A) | 18 | `docs/handoffs/p1.6-w04-s03a.md` (DEV RPC inventory verified) |
| Direct Entry RPC count (W04-S03B) | 18 (no change) | `docs/handoffs/p1.6-w04-s03b.md` |
| Direct Entry RPC count (W04-S03CD) | **20** (2 mới: `direct_entry_input_catalog` + `direct_entry_list_own_drafts`; `direct_entry_update_draft_row` replace forward-only, không tính mới) | `docs/handoffs/p1.6-w04-s03cd.md` + `supabase/migrations/20261003200000_p1_6_w04_s03cd_catalog_drafts.sql` line 319/321/325 |
| Direct Entry migration count (DEV post-S03CD) | 24 (post-apply dry-run 24/0/0) | `docs/handoffs/p1.6-w04-s03cd.md` §DEV and migration evidence |
| Direct Entry tables | 26 (25 foundation/core + 1 idempotency) | inventory §3.5.1 + §3.5.2 |
| Direct Entry views | 1 (`direct_entry_current_documents`, `security_invoker=true`) | inventory §3.5.2 |
| AI gateway RPC count | 12 + 4 G5 = 16 (`db:f:013`–`db:f:024` + `db:f:p1.5-G5:001`–`004`) | inventory §3.4 + §3.4.1 |
| Foundation tables | 5 (`db:t:001`–`db:t:005`) | inventory §3.1 |
| Reporting views | 3 (`db:v:001`–`db:v:003`) | inventory §3.2 |
| Total page routes in scope | 5 (`page:001`–`page:005`) | inventory §1 |
| Total API routes in scope | 13 (AI/ops) + 6 (P1.6 route committed on `p1.6-integration`) + 9 (P1.6 `DB_ONLY`) = 28 (counting `api:001`–`api:013` + `p1.6:016` + `p1.6:017` + `p1.6:route:W04-S03B:001/002` + `p1.6:route:W04-S03CD:001/002/003` + `p1.6:003`–`p1.6:015` `DB_ONLY`); final count reconciled when cutover merge | inventory §2 + §7.2; inventory S03 §3.2 + §7.2 |
| n8n workflows in scope | 1 (`P0-T2-WF01`) | inventory §9 |
| P1.5 prompt 1.1 evidence (NEW in S03) | `feature/p1.5-live-integration @ 8d0d074` (P1.5-I03): 126/126 gateway tests pass; team comparison + anomaly + monitoring limitations; DEFAULT_PROMPT_VERSION=1.1; frozen job mismatch fail-closed | `docs/handoffs/p1.5-i03.md` |
| P1.5 live adapter evidence (NEW in S03) | `feature/p1.5-live-integration @ f7e41dd` (P1.5-I02): live provider integrated; conditional env gate `AI_PROVIDER_KEY=live` + `AI_PROVIDER_ALLOWED_HOSTS` không rỗng ⇒ live; ngược lại `AI_CONFIG_REQUIRED` fail-closed; scripted vẫn cấm production/preview; **Owner checkpoint** cần nhập API URL/model/key để enable | `docs/handoffs/p1.5-i02.md` |

> **Note.** Inventory (`docs/security/p3-access-surfaces.md` S03) là source-of-truth cho ID và count. Cutover plan tham chiếu theo. `decision:ai-self-approval` (`api:006`) vẫn `PENDING_DECISION`; live adapter fail-closed gate đã integrated nhưng T0 self-approval decision chưa chốt. `ai.report.review` **không** map sang `change_review`.

---

## 8. Migrations / runtime owner (locked)

| Layer | Owner | Boundary | Cutover responsibility |
|---|---|---|---|
| P1.5 schema + RPC | **T1A** | `db:t:006`–`db:t:011`, `db:f:013`–`db:f:024`, `db:f:p1.5-G5:001`–`db:f:p1.5-G5:004` | Slice 3+5+6: caller thay `PILOT_ACTOR_REF`; G5 OCC đã verify. |
| P1.6 schema + RPC | **T1B** | `db:t:p1.6:001`–`db:t:p1.6:026`, `db:v:p1.6:001`, `db:f:p1.6:001`–`db:f:p1.6:017`, `db:f:p1.6:W04-S03A:001`, `db:f:p1.6:W04-S03CD:001`–`db:f:p1.6:W04-S03CD:002` | Slice 2+3: route resolve actor + capability; S03CD added 2 RPCs + 3 route handlers committed on `feature/p1.6-integration @ 2d5e9fc`; OCC + catalog + own-drafts all `COVERED_DEV_FAST_TRACK`. |
| P0 schema + RPC | **T1B** | `db:t:001`–`db:t:005`, `db:v:001`–`db:v:003`, `db:f:001`–`db:f:012` | Slice 3: server repo thêm scope predicate; không mở schema. |
| AI gateway route + server repo | **T1A** | `api:001`–`api:012`, `api:013` (worker), `repo:004`–`repo:009` | Slice 3+5+6: actor từ session + audit + admin capability. |
| Direct Entry route + server repo | **T1B** | `p1.6:003`–`p1.6:015` (`DB_ONLY`); `p1.6:016` (`GET /api/direct-entry/session`), `p1.6:017` (`GET /direct-entry` UI shell), `p1.6:route:W04-S03B:001` (`POST /api/direct-entry/batches`), `p1.6:route:W04-S03B:002` (`GET /api/direct-entry/entries/[entryId]`), `p1.6:route:W04-S03CD:001/002/003` (`GET /api/direct-entry/catalog`, `GET /api/direct-entry/drafts`, `PATCH /api/direct-entry/entries/[entryId]`); `repo:001`–`repo:003` | Slice 3: actor + capability + per-row scope. Routes committed on `feature/p1.6-integration @ 2d5e9fc` chưa merge `main`. |
| App Shell / nav | **T1B** + T1C | `src/lib/navigation/registry.ts` | Slice 4: filter server-side theo `actor.capability`. |
| Proxy / Basic Auth | **T1B** | `src/proxy.ts`, `src/lib/auth/pilot-access.ts` | Slice 1+7: giữ Basic Auth đến slice 7. |
| n8n system identity | **T1B** (T2 in older docs) | `n8n:001`–`n8n:004`, `automation/n8n/docs/p0-t2-wf01-runbook.md` | **Không thuộc human RBAC.** `decision:003` vẫn pending. |
| Inventory / audit | **T1C** (this task) | `docs/security/p3-access-surfaces.md`, `docs/security/p3-rbac-cutover-plan.md`, `docs/handoffs/p3-w01-*`, `docs/handoffs/p3-w02-*` | Doc-only; cutover plan + handoff. |

---

## 9. PENDING_DECISION (chưa đóng, không tự quyết)

| ID | Câu hỏi | Owner | Ảnh hưởng |
|---|---|---|---|
| `decision:001` | Có giữ Basic Auth song song với cookie session P3 không? Hay thay hoàn toàn? Cutover thứ tự? | T0 | Slice 7 timing + rollback plan. |
| `decision:002` | Cookie session dùng `@supabase/ssr` (đã khóa ở W02) hay provider khác? | T0 | Implementation timing. |
| `decision:003` | n8n system identity có cần capability gate riêng (`system.workflow`)? | T0 + N8N | n8n identity trong capability matrix. |
| `decision:005` | Audit retention window bao lâu? | T0 | Slice 5 retention. |
| `decision:006` | Direct-URL enforcement ở middleware hay RPC policy? | T0 | Slice 3 + slice 4 boundary. |
| `decision:ai-self-approval` | Self-approval cho AI report có được phép không? | T0 | §6 — 2 option + recommendation. |
| `decision:W04-S03C-D` | RPC count + route count cuối khi W04-S03C/S03D commit. | T1C (refresh task) | §7.3 — moving target. |

---

## 10. Status & handoff

| Field | Value |
|---|---|
| Status | `READY_FOR_P3_IMPLEMENTATION_SPLIT` |
| Branch | `feature/p3-w01-access-inventory` |
| Base | `6cbdc68622d263121f50d46f8a2dac63e2139322` |
| Companion doc | `docs/handoffs/p3-w02-s01.md` |
| Companion inventory | `docs/security/p3-access-surfaces.md` (S02-R1) |
| Companion contracts | `docs/contracts/p1.6-auth-capabilities-v1.md`, `docs/contracts/p1.6-direct-entry-v1.md` |
| Companion W04-S03 evidence | `docs/handoffs/p1.6-w04-s03a.md`, `docs/handoffs/p1.6-w04-s03b.md` |
| Forbidden | No runtime / schema / migration / deploy / merge / P3 implementation start. |

### 10.1. Boundary cho 3 agent P3 sau cutover

Sau khi P1.5/P1.6 integration ổn định, có thể chia 3 agent:

| Agent | Slice | Boundary |
|---|---|---|
| **P3A — Auth + Session** | 1+2 | Login / logout / callback / cookie refresh; actor bootstrap (W04-S03A `direct_entry_resolve_actor_context` integration). Không đụng route handlers khác. |
| **P3B — Capability + Guard** | 3+4 | Page / API guard theo ma trận §3.1 + §3.2; App Nav filter server-side; thay `PILOT_ACTOR_REF` ở server repos. Phụ thuộc P3A cung cấp resolved actor. |
| **P3C — Audit + Admin + Cutover** | 5+6+7 | Audit envelope enforcement; admin/bootstrap user; Basic Auth retirement. Phụ thuộc P3B cung cấp capability decision. |

### 10.2. Checkpoint tại task này

- [x] §1 mục tiêu + DoD của cutover plan (không phải của P3 implementation).
- [x] §2 architecture baseline (4 lớp + identity + capability vocab).
- [x] §3 ma trận surface (page + API + RPC + repo + gate + nav + env), neo về ID inventory, không sinh ID mới.
- [x] §4 go-live slice 7 bước (login → actor → guard → nav → audit → admin → Basic Auth retirement).
- [x] §5 library policy (chỉ dùng `@supabase/ssr` + Radix/shadcn-style + Lucide; không thêm framework).
- [x] §6 AI self-approval: 2 option + recommendation, **không tự quyết**.
- [x] §7 evidence: W04-S03A 17→18 RPC + W04-S03B 18 RPC + W04-S03CD 18→20 RPC (2 mới: `direct_entry_input_catalog` + `direct_entry_list_own_drafts`; `direct_entry_update_draft_row` replace forward-only, không tính mới). Migration count 24/0/0 (post S03CD). 6 surface route committed on `feature/p1.6-integration @ 2d5e9fc`. P1.5 prompt 1.1 (I03) + live adapter fail-closed env gate (I02) integrated, live provider disabled cho tới khi Owner config hoàn chỉnh. **Errata cố định:** Zod đã có sẵn (`zod ^4.6.5`, P0 era) — Direct Entry dùng custom validators, không đề xuất rewrite; `direct_entry_resolve_actor_context` không tự ghi audit — session audit là future P3 slice; `PILOT_ACTOR_REF = "pilot-admin"` chỉ áp dụng P1.5 AI report path, không gộp với Direct Entry S03A+ (Supabase cookie + `auth.getUser()`).
- [x] §8 migrations / runtime owner.
- [x] §9 PENDING_DECISION list (không tự đóng).
- [x] §10 status `READY_FOR_P3_IMPLEMENTATION_SPLIT`.

### 10.3. Quality gates

- `pnpm docs:check` — PASS (no JSON examples added).
- `pnpm secrets:check` — PASS (no secret-shaped patterns).
- `git diff --check` — clean (no whitespace error).