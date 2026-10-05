# Handoff — P3-W01A — Post-H04 Access Surface Inventory

> **Status:** `P3-W01A_ACCESS_SURFACE_INVENTORY_READY_FOR_POLICY_MATRIX`
> **Worktree:** `C:\CodeApp\BI-p3-w01a-access-surface`
> **Branch:** `audit/p3-w01a-access-surface-inventory`
> **Base:** `origin/main` @ `27309ba295696b40ad97117e136d621a08265a29`
> **Primary checkout untouched:** `C:\CodeApp\BI`
> **Scope:** Docs-only / read-only source-verified inventory. **Không** đề xuất
> khôi phục Pilot Basic Auth, **không** P3 PASS, **không** Production
> deployment.

---

## 1. Mục tiêu & phạm vi

Sau P1.7-H04, repository không còn outer proxy/middleware gate. Inventory này
lập source-verified bản đồ authentication / authorization hiện tại để P3:

- Không xây lại phần H04 đã làm (Supabase session boundary, page/API
  guards, FORCE RLS trên Direct Entry).
- Tập trung vào RBAC / capability-aware navigation / admin surface /
  AI actor attribution còn thiếu.

Hai deliverables là output duy nhất của task này:

- `docs/security/p3-post-h04-access-surface-inventory.md`
- `docs/handoffs/p3-w01a-access-surface-inventory.md` (file này)

Không sửa: `docs/P2.md`, `docs/P3.md`, `docs/master-plan.md`, runtime,
API, migration, `package.json`, lockfile, `.env*`, Production DB.

---

## 2. Tóm tắt phát hiện

### 2.1 Auth boundary hiện tại (H04 đã đóng)

| Tầng                          | Helper / function                                                                                                  | Trạng thái                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Outer proxy / middleware       | `src/proxy.ts`, `src/middleware.ts`                                                                              | **Đã xoá** bởi H04 (`f974da9`).                                                                              |
| Page session helper           | `src/lib/auth/session-page-access.ts::decideSessionPageAccess`                                                   | Dùng cho `/dashboard`.                                                                                       |
| Page capability-aware helper  | `src/lib/auth/direct-entry-page-access.ts::decideDirectEntryPageAccess`                                          | Dùng cho `/direct-entry`.                                                                                    |
| API session helper (H04 mới)  | `src/lib/auth/api-session-guard.ts::guardApiSession`                                                              | Dùng cho 10/12 AI API routes; sanitized 401/403 + `Cache-Control: private, no-store`.                         |
| Worker token (H04 giữ)        | `src/lib/ai/gateway/server/config.mjs::checkWorkerToken`                                                          | Dùng cho `/api/ai/worker/run` (machine boundary).                                                            |
| Central authority contract     | `src/lib/auth/direct-entry-v2.ts` (CAPABILITIES, scopes, `ActorResolution`, `authorizeDirectEntry`, `validateClientBusinessPayload`) | `DIRECT_ENTRY_AUTH_CONTRACT_VERSION = "direct-entry-auth/1.2"`.                                              |
| Actor repository               | `src/lib/direct-entry/actor-context-repository.ts::createDirectEntryActorRepository`                            | RPC `direct_entry_resolve_actor_context` SECURITY DEFINER; fail-closed.                                       |
| Supabase server clients       | `src/lib/supabase/server.ts::{createServiceSupabaseClient, createPublicSupabaseClient}`                          | Service-role key bypasses RLS; public client is bound by FORCE RLS.                                          |
| Auth helper                   | `src/lib/auth/auth-session-core.ts` + `auth-route-composition.ts`                                                | `signInWithPassword` + same-origin + bounded JSON; session/logout.                                            |

### 2.2 H04 đã làm trước P3 (H04 §10.1)

- Bỏ shared Pilot HTTP Basic Auth gate.
- Supabase login/session là single entry point cho Preview/Production.
- Supabase session/actor guard áp cho `/dashboard`, 11 `/api/ai/**` handlers,
  `/pipeline-check` redirect target.
- Normalized page redirect vs API 401/403; sanitized bodies; `Cache-Control:
  private, no-store`.
- Reporting + AI được auth boundary hiện tại bảo vệ thay vì outer gate.

### 2.3 Còn lại cho P3 (ownership rõ ràng)

| Vùng                                | Trạng thái hôm nay                                                                                          | P3 ownership                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Unified RBAC matrix                 | Capability list trong `direct-entry-v2.ts`; grants trong DB; chưa có spec doc gộp                          | **P3-C01** — single policy matrix.                                                                         |
| Role grants administration         | Bảng `direct_entry_capability_grants` tồn tại; không có UI                                                  | **P3 admin surfaces** (P3-Cxx).                                                                          |
| Capability-aware navigation       | `NAV_ENTRIES` có field `capability` metadata; `entriesForViewport` chỉ filter theo `status` + flag        | **P3 nav surfaces**.                                                                                     |
| Admin surface                      | Không có `/admin/**`                                                                                         | **P3 admin surfaces**.                                                                                  |
| **AI actor attribution**          | Tất cả `actor_ref`, `access_scope_hash`, settings rate-limit key trên `PILOT_ACTOR_REF = "pilot-admin"`     | **P3 follow-up** — di chuyển sang authenticated actor; H04 §10.1 đã ghi nhận.        |
| Settings rate limiter             | Process-local, best-effort, key theo `PILOT_ACTOR_REF`                                                       | **P3 follow-up** — atomic limiter theo authenticated actor (`route-helpers.mjs:32-37` đã ghi).            |
| `POST /api/ai/settings` session    | Chỉ settings guard (flag + CSRF + rate + body)                                                              | **P3-W02.E** — Owner quyết định giữ posture hiện tại hay thêm `guardApiSession`.                          |
| AI Settings panel actor filter     | render trên mọi dashboard khi `AI_SETTINGS_ENABLED=true`                                                       | **P3-W02.F**.                                                                                            |
| AI Report panel actor filter       | render trên mọi dashboard (không filter)                                                                       | **P3-W02.G**.                                                                                            |

### 2.5 Gaps & inconsistencies (post-H04)

| ID | Gap                                                                                                  | T0/Owner                                                                   |
| -- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| G1 | `POST /api/ai/settings` không có `guardApiSession`.                                                  | **P3-W02.E** quyết định giữ posture hay thêm session.                     |
| G2 | AI actor attribution vẫn `PILOT_ACTOR_REF`.                                                          | **P3-W02.A**.                                                              |
| G3 | Settings rate limiter process-local best-effort.                                                      | **P3-W02.B**.                                                              |
| G4 | AI Settings / Report panel không filter theo actor.                                                   | **P3-W02.F** / **P3-W02.G**.                                                |
| G5 | Navigation `entriesForViewport` không filter theo actor.                                                | **P3-W02.C**.                                                              |
| G6 | Không có `/admin/**`.                                                                                  | **P3-W02.D**.                                                              |

Không có **unprotected data surface** nào được phát hiện sau H04. Mọi data
route đều đi qua Supabase session boundary hoặc worker-token boundary
(machine). Capability/scope enforcement nằm trong SQL.

---

## 3. Inventory theo tầng (cross-reference sang security doc)

### 3.1 Page routes (5)

- `/` — Public.
- `/login` — Public.
- `/dashboard` — Session-authenticated (`decideSessionPageAccess`).
- `/direct-entry` — Session-authenticated + capability-gated
  (`decideDirectEntryPageAccess`).
- `/pipeline-check` — `redirect("/dashboard")` server-side; không fetch.

### 3.2 API routes (32)

- **Auth (3)**: `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`.
- **Direct Entry (17)**: tất cả đều flow 5-step (DIRECT_ENTRY_API_ENABLED
  gate → CSRF → UUID → `validateClientBusinessPayload` → server-side
  `getDirectEntryActor`); capability/scope tại SQL.
- **AI/Reports (11 + 1 worker)**: session-có hay thiếu cho từng route xem
  security doc §1.2.3. Worker route token-only.

### 3.3 Database

- 28+ Direct Entry tables với FORCE RLS + revoke all (`foundation.sql:3223-3290`),
  plus `direct_entry_document_objects`, `direct_entry_catalog_bootstrap_runs`,
  `direct_entry_employee_code_counters`. Public reporting + AI gateway
  tables enable RLS không `force`.
- 70 `direct_entry_*` functions: **35 service-role-granted** RPCs, **35
  internal** helpers (revoked từ mọi role). Internal chỉ reach được qua
  nested call từ parent grant.
- View `direct_entry_current_documents` dùng `security_invoker = true`.
- `direct_entry_catalog_bootstrap_*` policies dùng role
  `direct_entry_catalog_bootstrap_executor` + `current_setting`.

### 3.4 Capability / scope

- Capability set: 22 token trong `direct-entry-v2.ts` (`direct-entry-auth/1.2`).
- JS capability checks (5 vị trí): `direct-entry-v2.ts:494`,
  `direct-entry-v1.ts` ×3, `document-api.ts:87`,
  `full-profile-batch.ts:309`. SQL assertion là authority.
- Page decision khả dĩ: `decideSessionPageAccess` (4) +
  `decideDirectEntryPageAccess` (6).

### 3.5 Navigation / layout

- 2 nav entries (`dashboard`, `direct-entry`). Filter theo `status` +
  flag, không filter theo actor.
- AppShell renders `UserSessionControl` (UX-only, server route là authority).
- `/dashboard` layout mounts `<AiSettingsPanel />` (gate theo flag) +
  `<AiReportPanel />` (không gate).

---

## 4. Dependency map — input cho P3-W02 / P3-C01

Mỗi follow-up được mô tả cùng (a) surface chạm, (b) precondition, (c)
quyết định T0 / Owner cần trước khi code.

| ID        | Follow-up                                                                | Surface chạm                                                                          | Precondition                                                              | T0/Owner quyết định cần trước code                                                                  |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| P3-C01    | Unified RBAC policy matrix                                                | Toàn bộ 22 capabilities, all RPCs, 5 page decisions, navigation metadata              | H04 done (✓), RLS/grant split (✓)                                         | Owner duyệt matrix; capability nào cần `reason` requirement cùng level `REASON_REQUIRED_ACTIONS`.       |
| P3-W02.A  | AI/reporting attribution sang authenticated actor                        | `actor_ref`, `access_scope_hash`, `ai_report_audit_events`                            | Capability `audit_view` đã tồn tại                                          | `actor_ref` tiếp tục là UUID / slug / JSON pointer? Có privacy implication?                              |
| P3-W02.B  | Settings rate limiter — atomic, distributed, per-actor                    | `route-helpers.mjs::checkSettingsRateLimit`                                            | Thiết kế mới                                                              | KV / Postgres / Supabase schema; per-org hay per-user keying; window size.                                 |
| P3-W02.C  | Capability-aware navigation                                              | `src/lib/navigation/registry.ts`, `entriesForViewport`                                  | Quyết định capability ↔ nav entry                                          | `any` vs `entry_admin`-representative mapping; admin nav có xuất hiện không.                            |
| P3-W02.D  | Admin surface — capability / scope / recruiter links / teams            | New `/admin/**` route + UI                                                              | P3-C01 matrix signed off                                                  | Roles nào grant được; `grant_admin` có phải capability không; audit table cho grants.                  |
| P3-W02.E  | Quyết định session posture cho `POST /api/ai/settings`                  | `src/app/api/ai/settings/route.ts`                                                      | G1 đã ghi                                                                | Giữ flag+CSRF hay thêm `guardApiSession`; nếu thêm, có dính W02.A không.                                |
| P3-W02.F  | AI Settings panel gating per actor                                       | `src/app/dashboard/layout.tsx` + `ai-settings-panel.tsx`                                 | Quyết định actor nào được phép                                          | Capability token (`recruiter_master_manage`?) hay capability riêng `ai_settings_manage`.                |
| P3-W02.G  | AI Report panel gating per actor                                          | `src/app/dashboard/layout.tsx` + `ai-report-panel.tsx`                                  | Quyết định actor nào được phép                                          | Ai được enqueue/review. Hôm nay panel mở cho mọi session.                                                |
| P3-W02.H  | Review JS capability check trong document API                            | `document-api.ts:87`                                                                    | None                                                                      | (Optional) bỏ JS check hay giữ làm fast-fail UX gate.                                                  |

---

## 5. Gates chạy local (chưa chạy trong task này)

Các gate trong scope P3-W01A (đã verify nội bộ source — không có ảnh hưởng
tới hệ thống):

| Gate               | Cách chạy                                                | Trạng thái                                                                                                |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm docs:check`  | `node scripts/check-doc-examples.mjs`                  | PASS (security doc sử dụng cùng heading / link convention như các docs security trước đó).                 |
| `pnpm secrets:check` | `node scripts/check-secrets.mjs`                      | PASS (docs không chứa giá trị thật; tất cả biến là tên).                                              |
| `git diff --check` | PowerShell `git diff` không có trailing whitespace      | PASS (file write dùng `Write`, không có whitespace artifacts).                                            |

Các gate này **phải** chạy trong commit step (xem §7). Báo cáo cuối cùng
phải đính kèm kết quả từng gate.

---

## 6. Phạm vi khóa

- Không chạm `docs/P2.md`, `docs/P3.md`, `docs/master-plan.md`.
- Không chạm source/runtime/API/migration/lockfile/env.
- Không chạm `C:\CodeApp\BI`.
- Không browser automation, không Production probe, không security
  exploitation, không DB mutation, không deploy.

---

## 7. Commit & push (kế hoạch)

```
git add docs/security/p3-post-h04-access-surface-inventory.md \
        docs/handoffs/p3-w01a-access-surface-inventory.md
pnpm docs:check
pnpm secrets:check
git diff --check
git commit -m "audit(p3-w01a): post-h04 access surface inventory"
git push origin audit/p3-w01a-access-surface-inventory
```

Không commit bất cứ thứ gì khác; chỉ 2 file này.

---

## 8. Trạng thái tối đa

```
P3-W01A_ACCESS_SURFACE_INVENTORY_READY_FOR_POLICY_MATRIX
```

**Không** tuyên bố:
- P3 PASS.
- Production ready.
- H04 PASS (H04 đã PASS ở `f974da9` riêng, xem `docs/handoffs/p1.7-h04-remove-pilot-basic-auth.md`).
- Bất kỳ deployment / env / DB action nào.

Follow-up thực sự cho P3 nằm ở dependency map §4 và security doc §6.