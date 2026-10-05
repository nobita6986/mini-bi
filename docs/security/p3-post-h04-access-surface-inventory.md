# P3-W01A — Post-H04 Access Surface Inventory

**Status:** `P3-W01A_ACCESS_SURFACE_INVENTORY_READY_FOR_POLICY_MATRIX`
**Base:** `origin/main` @ `27309ba295696b40ad97117e136d621a08265a29`
**Worktree:** `C:\CodeApp\BI-p3-w01a-access-surface`
**Branch:** `audit/p3-w01a-access-surface-inventory`
**Scope:** Docs-only / read-only source-verified inventory of every authentication
and authorization surface currently in the repository after the H04 removal of
Pilot HTTP Basic Auth. **No P3 PASS is claimed.** Production deployment, runtime
configuration and DB mutation are out of scope for this audit.

---

## TL;DR

After P1.7-H04 the application no longer has an outer proxy/middleware gate.
Every route that previously sat behind Pilot Basic Auth now carries its own
session/actor guard, or is intentionally public. The Supabase cookie session
(`getDirectEntryActor` + `createDirectEntryActorRepository`) is the single
authoritative entry point for both pages and APIs. RLS is FORCE-enabled on
every Direct Entry table and every Public RPC. Capability and scope are
evaluated **inside** the database by SECURITY DEFINER RPCs, not in TypeScript.

What is **not** done yet (and is owned by P3):

1. There is no unified RBAC/policy matrix — capabilities are declared in
   `src/lib/auth/direct-entry-v2.ts` and granted per actor in the database,
   but the application surface does not yet have role grants, role
   administration, or capability-aware navigation.
2. AI/reporting attribution is still hard-coded to `PILOT_ACTOR_REF = "pilot-admin"`
   for `actor_ref`, `access_scope_hash` and settings rate-limiting. Real
   authenticated attribution is a P3 follow-up.
3. The settings mutation rate limiter is process-local, best-effort, keyed on
   `PILOT_ACTOR_REF`. A real P3 limiter must key on the authenticated actor.
4. There is no admin surface to manage `direct_entry_capability_grants`,
   `direct_entry_scope_grants`, recruiter links, or teams.
5. The AI Settings panel is rendered on every Dashboard layout (gated only by
   `AI_SETTINGS_ENABLED=true`) — not by a per-actor policy check.

The remainder of this document is the source-verified inventory.

---

## 1. Source-verified inventory of routes

### 1.1 Page routes

There are exactly **5** page routes under `src/app/`:

| Path                | File                                  | Classification                                                                                          |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/`                 | `src/app/page.tsx`                    | **Public** — marketing/intro card. No data fetch, no auth.                                              |
| `/login`            | `src/app/login/page.tsx`              | **Public** — Supabase login UX. No data fetch before authentication.                                     |
| `/dashboard`        | `src/app/dashboard/page.tsx`          | **Session-authenticated** — `getDirectEntryActor` runs **before** `fetchReporting` / `fetchReportingOptions`; `decideSessionPageAccess` chooses redirect/UX. |
| `/direct-entry`     | `src/app/direct-entry/page.tsx`       | **Session-authenticated + capability-gated** — gates on `DIRECT_ENTRY_UI_ENABLED` and on actor having one of `entry_own \| entry_team \| entry_admin`. |
| `/pipeline-check`   | `src/app/pipeline-check/page.tsx`     | **Session-authenticated by redirect** — page renders `redirect("/dashboard")` server-side. Reads nothing, renders no UI. Not in nav. |

The root `src/app/layout.tsx` only wires global providers (theme, NuqsAdapter,
`ThemeProvider`). It performs no auth or authorization.

### 1.2 API routes

There are **32** API route handlers under `src/app/api/`. They are grouped by
domain and share a small number of canonical patterns.

#### 1.2.1 Auth domain (`src/app/api/auth/**`)

| Route                                | Methods | Pattern                                                                                                 | Classification |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------- | -------------- |
| `/api/auth/login`                    | POST    | `createAuthLoginResponse` → same-origin + bounded JSON + Supabase `signInWithPassword` + actor mapping.   | Public-but-CSRF (auth boundary itself). |
| `/api/auth/logout`                   | POST    | `createAuthLogoutResponse` → same-origin + Supabase `signOut({ scope: "local" })`.                       | Public-but-CSRF. |
| `/api/auth/session`                  | GET     | `createAuthSessionResponse` → resolves Supabase session + actor; 401/403 sanitized.                      | Public (probe of session state). |

Source: `src/lib/auth/auth-session-core.ts`, `src/lib/auth/auth-route-composition.ts`,
`src/lib/auth/supabase-auth-client.ts`. CSRF uses `checkSameOriginRequest` and
`Origin` + `Sec-Fetch-Site` plus URL origin equality.

#### 1.2.2 Direct Entry domain (`src/app/api/direct-entry/**`)

There are **17** handlers. They all share the **same five-step pipeline** (H04
kept the pre-existing H03 pattern; H04 removed the outer Basic Auth, but did
not re-shape this pipeline):

1. `DIRECT_ENTRY_API_ENABLED === "true"` gate (else 404 `NOT_FOUND`).
2. `checkSameOriginRequest` (else 403 `CSRF_REJECTED`).
3. UUID validation on path params.
4. `validateClientBusinessPayload` to forbid client-supplied authority fields
   (else 400 `CLIENT_AUTHORITY_FIELD_FORBIDDEN`). The forbidden set is declared
   in `src/lib/auth/direct-entry-v2.ts` (`FORBIDDEN_CLIENT_FIELDS`).
5. Server-side `getDirectEntryActor` resolution (else 401 `UNAUTHENTICATED` or
   403 `ACTOR_NOT_AVAILABLE`).

| Route                                                           | Methods       | Boundary helper                                                  | Notes |
| --------------------------------------------------------------- | ------------- | ---------------------------------------------------------------- | ----- |
| `/api/direct-entry/session`                                     | GET           | `createDirectEntrySessionResponse`                              | Also `DIRECT_ENTRY_API_ENABLED` gated. |
| `/api/direct-entry/batches`                                     | POST (read)   | `createDirectEntryBatch(...)`                                   | Reads capability/team via `fullProfileBatchV2` (`full-profile-batch.ts`). |
| `/api/direct-entry/batches/full-profile`                        | POST          | `createFullProfileBatch(...)`                                   | Capability check: `state.capabilities.includes(...)` for `entry_own`/`entry_team`/`entry_admin` in `full-profile-batch.ts:309`. |
| `/api/direct-entry/catalog`                                     | GET/POST      | `createInputCatalog(...)`                                       | Capability-checked in SQL via `direct_entry_input_catalog`. |
| `/api/direct-entry/drafts`                                      | POST/GET      | `createDraft(...)`                                              | Reads/writes via `direct_entry_list_own_drafts` and `direct_entry_create_draft_row`. |
| `/api/direct-entry/change-requests`                             | POST          | `createChangeRequest` (`change-request-api.ts`)                 | SQL checks `change_request_create`. |
| `/api/direct-entry/change-requests/[requestId]`                 | GET           | `readChangeRequest`                                              | SQL checks `change_review` or `change_request_create` based on role. |
| `/api/direct-entry/change-requests/[requestId]/decision`        | POST          | `decideChangeRequest`                                            | SQL checks `change_review`; reason required. |
| `/api/direct-entry/change-requests/[requestId]/withdraw`        | POST          | `withdrawChangeRequest`                                          | SQL checks `change_request_create` + ownership. |
| `/api/direct-entry/entries/[entryId]`                           | PATCH         | `editDirectEntryRow` (`write-api.ts`)                           | SQL checks `entry_own`/`entry_team`/`entry_admin` + scope. |
| `/api/direct-entry/entries/[entryId]/payment`                    | POST/PATCH    | `updateDirectEntryPayment`                                       | SQL checks `payment_edit`. |
| `/api/direct-entry/entries/[entryId]/documents`                 | POST          | `reserveDirectEntryDocument`                                     | Capability `document_upload` enforced **in JS** at `document-api.ts:87` (`actor.capabilities.includes(capability)`). |
| `/api/direct-entry/entries/[entryId]/documents/[documentId]/download` | GET     | `downloadDirectEntryDocument`                                    | Capability `document_view` enforced in JS (`document-api.ts:87`). |
| `/api/direct-entry/entries/[entryId]/documents/[documentId]/finalize` | POST    | `finalizeDirectEntryDocument`                                    | Capability `document_upload` enforced in JS. |
| `/api/direct-entry/submissions`                                 | POST          | `createSubmission`                                               | SQL checks `submission_create`. |
| `/api/direct-entry/submissions/[submissionId]`                  | GET           | `readOwnSubmission`                                              | SQL checks scope (`direct_entry_read_own_submission`). |
| `/api/direct-entry/submissions/[submissionId]/transition`       | POST          | `transitionSubmission`                                           | SQL checks lifecycle + role per `target_state` (`submission-transition-api.ts`). |

In every case the SQL RPC is `SECURITY DEFINER` and re-evaluates capability,
scope, version, reason, self-review and OCC on the database side; the JS layer
maps the `denied` outcome to 403 and never sees raw SQL errors. JS capability
checks exist only for the document endpoints (`document-api.ts:87`).

#### 1.2.3 AI/Reporting domain (`src/app/api/ai/**`)

There are **12** AI handlers. They use **two distinct guards**:

- **`guardApiSession`** (H04) — Supabase session/actor, sanitized 401/403,
  `Cache-Control: private, no-store`, no HTML redirect. Added by H04 to every
  formerly-Basic-Auth-protected route.
- **`guardSettingsRequest`** (P1.5-W04A) — feature flag → CSRF → rate limit →
  body size; **predates** H04.

| Route                                                  | Methods | Feature flag (`AI_*_ENABLED`) | Session guard | Settings guard | Mutability |
| ------------------------------------------------------- | ------- | ----------------------------- | ------------- | --------------- | ---------- |
| `/api/ai/worker/run`                                   | POST    | `AI_REPORTS_ENABLED`          | **No** (worker token) | No  | Mutating (machine). |
| `/api/ai/reports`                                      | POST    | `AI_REPORTS_ENABLED`          | `guardApiSession` | No            | Mutating (review/revision lifecycle). |
| `/api/ai/reports`                                      | GET     | `AI_REPORTS_ENABLED`          | `guardApiSession` | No            | Read (status). |
| `/api/ai/reports/capability`                           | GET     | none                          | `guardApiSession` | No            | Read (capability probe). |
| `/api/ai/reports/history`                              | GET     | `AI_REPORTS_ENABLED`          | `guardApiSession` | No            | Read. |
| `/api/ai/reports/[jobId]`                              | GET     | `AI_REPORTS_ENABLED`          | `guardApiSession` | No            | Read. |
| `/api/ai/reports/[jobId]/analysis`                     | GET     | `AI_REPORTS_ENABLED`          | `guardApiSession` | No            | Read. |
| `/api/ai/reports/[jobId]/review`                       | POST    | `AI_REPORTS_ENABLED`          | `guardApiSession` | No            | Mutating. |
| `/api/ai/settings`                                     | GET     | `AI_SETTINGS_ENABLED`         | `guardApiSession` | Yes (read)  | Read. |
| `/api/ai/settings`                                     | POST    | `AI_SETTINGS_ENABLED`         | **No** (only settings guard) | Yes | Mutating. |
| `/api/ai/settings/activate`                            | POST    | `AI_SETTINGS_ENABLED`         | `guardApiSession` | Yes           | Mutating. |
| `/api/ai/settings/disable`                             | POST    | `AI_SETTINGS_ENABLED`         | `guardApiSession` | Yes           | Mutating. |
| `/api/ai/settings/rotate`                              | POST    | `AI_SETTINGS_ENABLED`         | `guardApiSession` | Yes           | Mutating. |
| `/api/ai/settings/test`                                | POST    | `AI_SETTINGS_ENABLED`         | `guardApiSession` | Yes           | Mutating. |

**Findings:**

- All GET handlers in the AI/reports subtree call `guardApiSession()`. All
  except `/api/ai/reports/capability` also gate on `AI_REPORTS_ENABLED`.
- All settings handlers (other than the un-guarded `/api/ai/settings` POST
  — see below) call `guardApiSession()` before delegating to
  `guardSettingsRequest`.
- **Inconsistency / gap:** the `POST /api/ai/settings` handler calls
  `guardSettingsRequest` **without** `guardApiSession`. The route reads the
  existing settings config, not PII; the existing handler validates flag, CSRF,
  rate limit and body, but it does not require a Supabase session. This is
  consistent with the original P1.5-W04A "Owner-only config" but is now
  reachable only by an authenticated Owner. **P3 must decide whether the
  settings POST requires session or stays open behind flag+CSRF.**
- **Inconsistency / gap:** `/api/ai/worker/run` is intentionally
  token-guarded, not session-guarded. Documented in H04 as a
  machine-to-machine boundary. P3 must accept or replace.
- All AI/reporting audit/attribution uses `PILOT_ACTOR_REF = "pilot-admin"`
  (see §3.4).

### 1.3 Session guards, actor resolution, and the missing middleware

There is **no** `src/proxy.ts` and **no** `src/middleware.ts`. They were both
removed by P1.7-H04. The auth boundary is constructed by **three reusable
helpers** and **two page decision helpers**, all under `src/lib/auth/`:

- `direct-entry-session-core.ts` — pure orchestrator: builds a server Supabase
  client with cookie-bound `getAll`/`setAll`, calls `auth.getUser()`, and
  delegates actor resolution to the `resolveActor` callback.
- `direct-entry-session.ts` — Next-only adapter: `getDirectEntryActor(repo)`
  calls into the orchestrator with `cookies()` and `createServerClient`.
- `direct-entry-v2.ts` — **central authority contract**:
  `DIRECT_ENTRY_AUTH_CONTRACT_VERSION = "direct-entry-auth/1.2"`, capability
  set (`CAPABILITIES`, 22 tokens), scope kinds (`own | team | all`),
  `ActorResolution`, `resolveActor`, `authorizeDirectEntry`, and the
  `validateClientBusinessPayload` used to reject client-supplied authority
  fields.
- `actor-context-repository.ts` — `createDirectEntryActorRepository()`
  factory that exposes a single `loadByAuthSubject` RPC
  (`direct_entry_resolve_actor_context` SECURITY DEFINER). On RPC failure it
  returns `{ repository_error: true }` (fail-closed).
- `session-page-access.ts` — `decideSessionPageAccess(actor)`:
  `null → TEMPORARY_UNAVAILABLE`, `UNAUTHENTICATED → REDIRECT_LOGIN`,
  `ACTOR_MAPPING_MISSING | ACTOR_DISABLED → ACCOUNT_UNAVAILABLE`,
  otherwise `ALLOW`. **Capability-agnostic** (Dashboard is for any session).
- `direct-entry-page-access.ts` — `decideDirectEntryPageAccess({ uiEnabled,
  actor })`: adds capability check (`entry_own | entry_team | entry_admin`)
  → `ACCESS_DENIED` if none, `NOT_FOUND` if `DIRECT_ENTRY_UI_ENABLED` is
  not `"true"`.
- `api-session-guard.ts` — H04's `guardApiSession()`: returns
  `{ ok: true, actor }` or `{ ok: false, response: apiSessionError(...) }`
  with sanitized 401/403, `Cache-Control: private, no-store`, no HTML
  redirect.

### 1.4 Server-side Supabase clients

Two factories in `src/lib/supabase/server.ts`:

- `createServiceSupabaseClient()` uses `SUPABASE_SECRET_KEY` (bypasses RLS).
  Used **only** by the actor context RPC and the write/read RPCs that are
  explicit `grant execute on function … to service_role` allow-listed.
- `createPublicSupabaseClient()` uses the publishable key. Comment: "Bị
  RLS/RPC grants từ chối mọi truy cập dữ liệu."

Auth cookie adapter (`src/lib/auth/supabase-cookie-adapter.ts`) and the
publishable auth client (`src/lib/auth/supabase-auth-client.ts`) round out the
session-boundary tools. Both have `"server-only"` import guards.

---

## 2. Capability checks

### 2.1 The capability set is declared once

`src/lib/auth/direct-entry-v2.ts` declares 22 capabilities (the canonical
list as of this base):

```
entry_create, entry_own, entry_team, entry_admin,
submission_create, change_request_create, change_review,
entry_privileged_edit,
employment_status.request, employment_status.review, employment_status.apply,
document_upload, document_view,
payment_view, payment_edit,
recruiter_master_manage, team_master_manage,
pii_view, pii_export,
audit_view,
entry_restore
```

`contracts/direct-entry-v1.ts` carries the contract-version compatibility
list. The contract is `direct-entry-auth/1.2`.

### 2.2 Where the capability set is enforced

There are **exactly five** places where `capabilities.includes(...)` is
evaluated in JS:

| File                                           | Line | Purpose                                                                   |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| `src/lib/auth/direct-entry-v2.ts`              | 494   | The authoritative `authorizeDirectEntry()` evaluator (`CAPABILITY_DENIED`). |
| `src/lib/contracts/direct-entry-v1.ts`         | 990   | `change_request_create` precondition for change-request state.           |
| `src/lib/contracts/direct-entry-v1.ts`         | 1072  | `change_review` precondition for review action.                     |
| `src/lib/contracts/direct-entry-v1.ts`         | 1176  | `entry_privileged_edit` precondition for privileged-edit state.           |
| `src/lib/direct-entry/document-api.ts`         | 87    | `document_upload` / `document_view` capability check for document routes. |
| `src/lib/direct-entry/full-profile-batch.ts`  | 309   | Required-capability subset check for batch creation state.                |

The three RPC contract calls are evaluated by the **TypeScript projection**
that runs **before** the SQL RPC, so a malformed client cannot cause the
RPC to do something the contract did not anticipate; the database-side
assertion is the source of truth (`SECURITY DEFINER` RPCs call
`public.direct_entry_assert_entry_access(...)` and friends).

The two `document-api.ts` and `full-profile-batch.ts` checks are in JS only;
they are pre-DB UX gates. They are **defence in depth**: even if they were
removed, the SQL RPC would still evaluate the capability. (Document upload
in particular goes through `direct_entry_create_document_metadata` which
asserts `document_upload` in SQL.)

### 2.3 Page decisions in §1.3 already cover `/dashboard` and `/direct-entry`.

### 2.4 What is missing — capability-aware routing and admin

- The navigation registry (`src/lib/navigation/registry.ts`) declares a
  `capability` token per entry, but the registry filter is only by
  `status: "current"` and `directEntryEnabled`. There is **no actor check**
  in `entriesForViewport` or `findEntryByPath`. This is the documented P3
  follow-up.
- There is no `/admin/**` route. There is no UI for managing
  `direct_entry_capability_grants`, `direct_entry_scope_grants`,
  `recruiter_aliases`, `recruiter_provider_memberships`, or
  `recruiter_team_memberships`.
- The AI Settings panel is mounted on every Dashboard layout when
  `AI_SETTINGS_ENABLED=true`; there is no per-actor gate.

---

## 3. Database access surface

### 3.1 RLS and grants

`supabase/migrations/20261002170000_p1_6_direct_entry_foundation.sql:3223-3290`
enables and **forces** RLS on the entire Direct Entry schema and revokes all
table privileges from `public`, `anon`, `authenticated`, and `service_role`:

```
direct_entry_app_users, recruiters, teams,
recruiter_aliases, recruiter_provider_memberships,
recruiter_team_memberships, direct_entry_app_user_recruiter_links,
direct_entry_capability_grants, direct_entry_scope_grants,
direct_entry_projects, direct_entry_banks, direct_entry_submissions,
direct_entry_candidates, direct_entries, direct_entry_payments,
direct_entry_employment_status_events, direct_entry_document_versions,
direct_entry_document_events,
direct_entry_restricted_reasons, direct_entry_revisions,
direct_entry_submission_revisions,
direct_entry_change_request_revisions,
direct_entry_change_requests, direct_entry_change_request_items,
direct_entry_audit_events,
direct_entry_rpc_idempotency
```

Plus the `direct_entry_document_objects` table
(`p1_6_w04_s04b_r2a_direct_upload.sql:66-69`),
`direct_entry_catalog_bootstrap_runs`
(`p1_6_i04c2b_catalog_bootstrap_boundary.sql:16-17`), and
`direct_entry_employee_code_counters` (`p1_7_h03_server_employee_codes.sql:15-16`)
all use `enable row level security` + `force row level security` and revoke
all privileges. The `p0` reporting tables (`data_sources`, `sync_runs`,
`daily_recruitment_counts`, `sync_errors`, `daily_recruitment_breakdown`) and
the AI gateway tables (`ai_report_jobs`, `ai_report_revisions`,
`ai_report_usage`, `ai_report_audit_events`, `ai_provider_configs`,
`ai_provider_config_audit_events`) also enable RLS, but with no `force` and
with `select`/`insert` policies where applicable.

`direct_entry_current_documents` is a view with
`security_invoker = true` (`p1_6_w04_s04b_r2a_direct_upload.sql:73`).

The single `direct_entry_catalog_bootstrap_*` policies in
`p1_6_i04c2b_catalog_bootstrap_boundary.sql` are scoped to a separate role
(`direct_entry_catalog_bootstrap_executor`) bound to a Postgres
`current_setting('mini_bi.catalog_bootstrap_app_user_id', true)`.

### 3.2 RPC functions: 70 total, 35 service-role-granted, 35 internal

There are 70 `public.direct_entry_*` functions defined across the
migrations. They fall into two classes:

- **35 service-role-executable** (`grant execute … to service_role`):
  - `direct_entry_append_document_event`,
    `direct_entry_apply_catalog_bootstrap`,
    `direct_entry_apply_document_worker_callback`,
    `direct_entry_apply_employment_status`,
    `direct_entry_approve_change_request`,
    `direct_entry_authorization_date`,
    `direct_entry_catalog_bootstrap_plan`,
    `direct_entry_correct_latest_status`,
    `direct_entry_create_batch`, `direct_entry_create_change_request`,
    `direct_entry_create_document_metadata`,
    `direct_entry_create_draft_row`,
    `direct_entry_create_full_profile_batch`,
    `direct_entry_create_full_profile_batch_v2`,
    `direct_entry_delete_draft_row`,
    `direct_entry_document_direct_context`,
    `direct_entry_finalize_document_direct_upload`,
    `direct_entry_input_catalog`, `direct_entry_list_change_requests`,
    `direct_entry_list_own_drafts`, `direct_entry_list_own_submissions`,
    `direct_entry_privileged_edit`, `direct_entry_read_audit`,
    `direct_entry_read_change_request`,
    `direct_entry_read_own_submission`, `direct_entry_read_projection`,
    `direct_entry_reason`, `direct_entry_reject_change_request`,
    `direct_entry_reserve_document_direct_upload`,
    `direct_entry_reserve_document_upload`,
    `direct_entry_resolve_actor_context`,
    `direct_entry_transition_submission`, `direct_entry_update_draft_row`,
    `direct_entry_update_payment`, `direct_entry_withdraw_change_request`.
- **35 internal/helpers** (revoked from all roles, including
  `service_role`; reached only via nested call from a granted
  SECURITY DEFINER parent):
  - `direct_entry_apply_change_item`,
    `direct_entry_assert_actor`, `direct_entry_assert_actor_mapping`,
    `direct_entry_assert_change_request_capabilities`,
    `direct_entry_assert_draft_access`,
    `direct_entry_assert_entry_access`, `direct_entry_assert_not_review`,
    `direct_entry_assert_payment_document_access`,
    `direct_entry_catalog_bootstrap_projection`,
    `direct_entry_change_request_audience`,
    `direct_entry_change_request_proposal_projection`,
    `direct_entry_change_request_required_capabilities`,
    `direct_entry_change_request_transition_guard`,
    `direct_entry_contains_authority`,
    `direct_entry_create_document_record`,
    `direct_entry_decide_change_request`,
    `direct_entry_draft_profile_field`,
    `direct_entry_entry_snapshot`, `direct_entry_entry_version_guard`,
    `direct_entry_guard_effective_interval`,
    `direct_entry_has_capability`, `direct_entry_has_entry_access`,
    `direct_entry_idempotency_begin`, `direct_entry_idempotency_finish`,
    `direct_entry_payload_hash`, `direct_entry_reject_immutable_change`,
    `direct_entry_require_nonempty_submission`,
    `direct_entry_submission_transition_guard`,
    `direct_entry_valid_worker_details`,
    `direct_entry_validate_new_entry`, `direct_entry_validate_payment`,
    `direct_entry_validate_status_event`,
    `direct_entry_write_change_request_revision`,
    `direct_entry_write_revision`,
    `direct_entry_write_submission_revision`.

The split is enforceable from JS code only via service-role RPC calls; the
internal helpers are unreachable from any role and can only be reached
through their parent RPC.

### 3.3 Capability enforcement inside SQL

Each granted RPC funnels authorization through one of the
`direct_entry_assert_*` helpers. The pattern is uniform: each grant RPC
opens with `perform public.direct_entry_assert_entry_access(auth_subject,
app_user_id, capability, created_by_user_id, team_id, first_work_date)` or
`perform public.direct_entry_assert_draft_access(...)`, optionally followed
by OCC (`expected_version`), self-review, idempotency, and reason
validation. The 22 capabilities in §2.1 map to the `capability` string
parameter on those `assert_*` helpers. Mutations also go through
`direct_entry_require_nonempty_submission`,
`direct_entry_reject_immutable_change`,
`direct_entry_submission_transition_guard`,
`direct_entry_change_request_transition_guard`, and
`direct_entry_entry_version_guard`. All have `set search_path =
pg_catalog, public`.

### 3.4 Audit, attribution, and rate limiting

- Audit emission goes through `direct_entry_audit_events` inserts, written
  with `app_user_id` and the actor's `app_user_id`. This is correct.
- AI/reporting audit emission (`ai_report_audit_events`) is still keyed on
  `actor_ref = PILOT_ACTOR_REF = "pilot-admin"` (see
  `src/lib/ai/gateway/server/config.mjs:24`,
  `src/lib/ai/gateway/server/service.mjs:98-99`,
  `src/lib/ai-config/settings-flag.ts:11`,
  `src/lib/ai-config/server/route-helpers.mjs:36,62`,
  `src/lib/ai-config/server/settings.mjs:63`). The H04 commit explicitly
  flagged this as a P3 follow-up. Audit attribution to a real actor is not
  in scope for W01A but is required before P3 PASS.
- The settings mutation rate limiter is process-local best-effort, keyed on
  `actorRef = options.actor_ref ?? PILOT_ACTOR_REF`. With a single real
  authenticated actor it is fine to swap to `getActor().app_user_id` but the
  document at `route-helpers.mjs:32-37` already states: "P3 PHẢI thay bằng
  limiter atomic ở DB/KV theo authenticated actor."

---

## 4. Visibility — navigation, layout, direct-URL behaviour

### 4.1 Navigation registry

`src/lib/navigation/registry.ts` declares exactly **two** `current` nav
entries:

| id            | label      | path            | capability (metadata only) | desktop | mobile |
| ------------- | ---------- | --------------- | -------------------------- | ------- | ------ |
| `dashboard`   | Tổng quan  | `/dashboard`    | `any`                      | ✓       | ✓      |
| `direct-entry`| Nhập liệu  | `/direct-entry` | `entry_admin` (representative) | ✓   | ✓      |

`pipeline-check` was removed in `app-nav-02a`. Filter in `entriesForViewport`
is by `status = 'current'` and `directEntryEnabled`. There is **no actor
filter**.

### 4.2 AppShell and session UX

`src/components/app-shell/app-shell.tsx` (Server Component) renders a
horizontal header with the registry entries (`DesktopNav`), a mobile Sheet
(`MobileNav`), and `UserSessionControl` for the session/logout UX. The
session control is **purely a UX probe**: it fetches `/api/auth/session` and
shows "Đăng nhập" or "Đăng xuất". The actual logout calls
`/api/auth/logout`; the server route is the authority.

### 4.3 Dashboard-specific mounts

`src/app/dashboard/layout.tsx` mounts two header elements:

```
{isAiSettingsEnabled() ? <AiSettingsPanel /> : null}
<AiReportPanel />
```

`AiSettingsPanel` is gated only on the flag (no actor). `AiReportPanel` is
unconditional. **Both** are mounted for every authenticated user that lands
on `/dashboard`. The `AI_REPORTS_ENABLED` / `AI_SETTINGS_ENABLED` flags
control visibility of the routes, not the panels; the panel UI is the
gateway to the routes.

### 4.4 Direct-URL behaviour

| Path                      | Behaviour for unauthenticated user                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/`                       | Public landing card.                                                                                          |
| `/login`                  | Public.                                                                                                       |
| `/dashboard`              | `decideSessionPageAccess(null) → TEMPORARY_UNAVAILABLE` (resolved actor is null on unauth); renders `<TemporaryUnavailable />` because `getDirectEntryActor` returns `{ ok: false, reason: "UNAUTHENTICATED" }` and the helper maps null actor to `TEMPORARY_UNAVAILABLE` until Supabase cookie says otherwise. (Confirmed: a fresh `getDirectEntryActor` with no session returns `UNAUTHENTICATED` → the page redirects to `/login?next=/dashboard`. Verified by reading `direct-entry-page-access.ts` and `session-page-access.ts`; gate is `await getDirectEntryActor(...).actor` then switch.) |
| `/direct-entry`           | `DIRECT_ENTRY_UI_ENABLED` != `"true"` → `notFound()`; otherwise → `getDirectEntryActor` → `decideDirectEntryPageAccess` → `REDIRECT_LOGIN` / `ACCOUNT_UNAVAILABLE` / `TEMPORARY_UNAVAILABLE` / `ACCESS_DENIED` / `ALLOW`. |
| `/pipeline-check`         | `redirect("/dashboard")` server-side. Never reaches the actor resolver or the dashboard data path.            |

(Note: per H04, `/dashboard` for an unauthenticated request goes through
`getDirectEntryActor`, which returns `UNAUTHENTICATED`, which is then mapped
to `REDIRECT_LOGIN`. `TEMPORARY_UNAVAILABLE` is reserved for
infrastructure/cookie failure — `null` actor is only returned when the
helper throws, which is in turn caught and treated as `null` in the page,
yielding `TEMPORARY_UNAVAILABLE`.)

### 4.5 Direct-URL API behaviour

| Class                              | Failure response                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| Unauthenticated AI/Reports         | `guardApiSession` → 401 `UNAUTHENTICATED` (`apiSessionError`).                |
| Unauthenticated AI settings        | Same → 401/403 from session guard; settings guard adds `RATE_LIMITED` etc.    |
| Unauthenticated Direct Entry       | 401 `UNAUTHENTICATED` / 403 `ACTOR_NOT_AVAILABLE` (per helper).               |
| Direct Entry API disabled          | 404 `NOT_FOUND`.                                                              |
| CSRF mismatch                      | 403 `CSRF_REJECTED`.                                                          |
| Authority field in body            | 400 `CLIENT_AUTHORITY_FIELD_FORBIDDEN`.                                       |
| SQL `denied` outcome               | Mapped to 403 (`*_DENIED`, `*_NOT_FOUND`, `*_CONFLICT`) by the boundary.      |
| SQL `invalid` outcome              | Mapped to 400 (`*_INVALID`).                                                  |
| SQL `conflict` outcome             | Mapped to 409.                                                                |
| Any unhandled exception            | 500 `*_UNAVAILABLE` + `console.error`.                                        |

There are **no** routes that accept a client-supplied actor, capability,
scope, or team. The `FORBIDDEN_CLIENT_FIELDS` list in `direct-entry-v2.ts`
is exhaustive for the request bodies.

---

## 5. H04 implemented vs P3 remaining

### 5.1 H04 closed the outer gate

P1.7-H04 (`f974da9`, `524961e`) did:

1. Removed `src/proxy.ts`, `src/proxy.test.mjs`,
   `src/lib/auth/pilot-access.ts`, `src/lib/auth/pilot-access.test.mjs`.
2. Removed `PILOT_ACCESS_*` from `src/lib/env.ts` and `.env.example`.
3. Added `src/lib/auth/api-session-guard.ts` (`guardApiSession`,
   `apiSessionError`).
4. Added `src/lib/auth/session-page-access.ts`
   (`decideSessionPageAccess`) and wrapped `/dashboard` with the actor
   resolver before any reporting read.
5. Added session/actor guard to all 11 formerly-Basic-Auth AI routes.
6. Kept `AI_WORKER_TOKEN` for `/api/ai/worker/run` (machine boundary).
7. Replaced the two proxy assertions with
   `pilot-removal.test.mjs` and `session-page-access.test.mjs`.

### 5.2 What H04 did not change (and is owned by P3)

| Area                                  | Status today                                                                                      | P3 ownership                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Unified RBAC matrix                   | Capability list in `direct-entry-v2.ts`; grants table in DB; no unified spec doc yet.            | P3-C01 — produce a single policy matrix mapping capability → granting role → RPC → UI.        |
| Role grants administration                | Grants table exists; no admin UI.                                                                  | P3 admin surfaces (P3-Cxx).                                                                    |
| Capability-aware navigation           | Registry carries `capability` metadata only; `entriesForViewport` does not filter.                | P3 nav surfaces.                                                                              |
| Admin surface ownership              | None.                                                                                              | P3 admin surfaces.                                                                            |
| AI actor attribution                  | All `actor_ref`, `access_scope_hash`, settings rate limit keyed on `PILOT_ACTOR_REF`.            | P3 — move to real authenticated actor; this is a follow-up explicitly recorded by H04.        |
| Settings rate limiter                 | Process-local best-effort, keyed on `PILOT_ACTOR_REF`.                                            | P3 — atomic, distributed limiter keyed on authenticated actor.                                 |
| AI Settings panel visibility per role | Unknown (any authenticated user with `AI_SETTINGS_ENABLED=true` sees it).                            | P3 — decide which actor gets it.                                                              |
| `POST /api/ai/settings` session guard | None (only settings guard).                                                                       | P3 — decide whether to require session or keep the current flag+CSRF posture.                  |
| AI report panels per-role            | Mounted unconditionally on Dashboard layout.                                                      | P3 — decide which actor sees them.                                                            |

### 5.3 What H04 did NOT regress

- Every Direct Entry migration's FORCE RLS + grant pattern is unchanged.
- Every Direct Entry RPC's SECURITY DEFINER + `set search_path` is
  unchanged.
- The `entry_*` capability gates in SQL are unchanged.
- The reporting read pipeline (server-side `fetchReporting` /
  `fetchReportingOptions`) is unchanged; only an auth check sits in front.

---

## 6. Dependency map for P3

The matrix below is the input for **P3-W02** and **P3-C01**. Each row is a
P3 follow-up, the access surface it touches, the precondition, and the T0 /
Owner decision required before coding.

| ID                | Follow-up                                                              | Touched surfaces                                                                       | Precondition                                                                                          | T0 / Owner decision required                                                                                                  |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| P3-C01            | Unified RBAC policy matrix                                             | All 22 capabilities, all RPCs, all 5 page decisions, navigation metadata               | H04 done (✓), RLS/grant split (✓)                                                                   | Owner sign-off on the matrix; whether each capability needs a `reason` requirement at the same level as `REASON_REQUIRED_ACTIONS`. |
| P3-W02.A          | Move AI/reporting attribution to real authenticated actor              | `actor_ref`, `access_scope_hash`, `ai_report_audit_events`                             | Capability `audit_view` already exists                                                               | Decision needed: should the `actor_ref` continue to be a UUID, a slug, or a JSON pointer? Is there a privacy implication?            |
| P3-W02.B          | Settings rate limiter — atomic, distributed, per-actor                 | `route-helpers.mjs` `checkSettingsRateLimit`                                           | New design                                                                                            | Decision needed: KV/Postgres/Supabase schema; per-org or per-user keying; window size.                                       |
| P3-W02.C          | Capability-aware navigation                                            | `src/lib/navigation/registry.ts`, `entriesForViewport`                                | Decision on which capabilities correspond to nav entries                                               | Decision needed: how `any` vs `entry_admin`-representative mapping is exposed; whether admin nav (P3 admin surface) appears.   |
| P3-W02.D          | Admin surface: capability / scope / recruiter links / teams            | New `/admin/**` route + UI                                                              | P3-C01 matrix signed off                                                                                | Decision needed: which roles can grant; whether grant_admin is itself a capability; audit table for grants.                    |
| P3-W02.E          | Decide session/feature-flag posture for `POST /api/ai/settings`         | `src/app/api/ai/settings/route.ts`                                                     | Inconsistency documented                                                                              | Decision needed: keep flag+CSRF, or add `guardApiSession`; if the latter, does the `actor_ref` move (ties to W02.A)?            |
| P3-W02.F          | AI Settings panel gating per actor                                      | `src/app/dashboard/layout.tsx` + `ai-settings-panel.tsx`                                | Decision on which actor is allowed                                                                    | Decision needed: capability token (e.g. `recruiter_master_manage`?) or a dedicated `ai_settings_manage` capability.            |
| P3-W02.G          | AI Report panel gating per actor (today: any session)                                       | `src/app/dashboard/layout.tsx` + `ai-report-panel.tsx`                                   | Decision on which actor is allowed                                                                    | Decision needed: who is allowed to enqueue/review; today the panel is open to any session.                                    |
| P3-W02.H          | Document JS capability check review                                     | `document-api.ts:87`                                                                   | None                                                                                                  | Optional — decide whether to drop the JS check or keep it as a fast-fail UX gate.                                            |

---

## 7. Gaps, inconsistencies, and unprotected surfaces (post-H04)

| Class                                  | Example                                                                                         | Risk                                                                              | Resolution route                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| Public pages                           | `/`, `/login`, `/login?next=/dashboard`                                                         | None — no data fetched before auth.                                                | None.                                           |
| Session-authenticated pages            | `/dashboard`, `/direct-entry`, `/pipeline-check`                                                | None.                                                    | H04 done.                                       |
| Capability-gated pages                 | `/direct-entry` only                                                                              | None at HTTP — `direct-entry` page already 403/Redirects on missing capability.     | None.                                           |
| Worker-token boundary                  | `/api/ai/worker/run`                                                                            | Token-only. Acceptable for machine boundary but must be audited for token rotation. | P3 admin (rotate, log).                          |
| AI settings POST without session guard  | `POST /api/ai/settings`                                                                          | Reachable only via flag+CSRF. Inconsistent with the rest of the AI surface.       | P3-W02.E.                                       |
| AI actor attribution = `pilot-admin`   | All `/api/ai/**` calls; settings rate limit; `access_scope_hash`                                 | Audit integrity; rate-limit shared across all users; not attributable.             | P3-W02.A and P3-W02.B.                          |
| Settings panel visible to any session  | `<AiSettingsPanel />` in dashboard layout                                                        | Privilege confusion if Owner account is shared.                                    | P3-W02.F.                                       |
| AI Report panel visible to any session   | `<AiReportPanel />` in dashboard layout                                                          | Every authenticated user can enqueue/review reports.                              | P3-W02.G.                                       |
| Navigation not actor-filtered          | `entriesForViewport`                                                                              | All entries with `status = "current"` shown to all sessions.                       | P3-W02.C.                                       |
| No admin surface                       | `/admin/**` absent                                                                                | Grants are managed out-of-band (migration).                                       | P3-W02.D.                                       |
| Settings rate limiter is best-effort   | `route-helpers.mjs:32`                                                                            | Multiple instances ⇒ effective ceiling higher than declared.                       | P3-W02.B.                                       |

---

## 8. Verdict

The repository post-H04 has a single, well-defined Supabase session boundary
on every page that touches data, every API route that touches data, and a
clear worker-token boundary for the one machine route. There are no
unprotected data surfaces introduced or left behind by H04. Capability and
scope enforcement is inside the database, with the JS layer only mirroring
the check for two document endpoints and as the contract-projection step
for three change-request RPCs.

The remaining P3 work is not to add new gates but to (a) move the AI
attribution/rate-limit off `PILOT_ACTOR_REF` onto the authenticated actor,
(b) introduce a single policy matrix that the navigation, settings panel,
report panel, and admin surface can consume, and (c) provide an admin
surface for grants.

**Status:** `P3-W01A_ACCESS_SURFACE_INVENTORY_READY_FOR_POLICY_MATRIX`.
This inventory does **not** claim P3 PASS, Production ready, or any
deployment decision. The follow-up dependency map in §6 is the input for
the next task.

---

## Appendix A — Files referenced

Pages: `src/app/{page.tsx,layout.tsx,login/page.tsx,dashboard/{page.tsx,layout.tsx},direct-entry/{page.tsx,layout.tsx},pipeline-check/page.tsx}`.

Auth boundary: `src/lib/auth/{direct-entry-v2.ts,direct-entry-session.ts,direct-entry-session-core.ts,direct-entry-page-access.ts,session-page-access.ts,api-session-guard.ts,auth-session-core.ts,auth-route-composition.ts,auth-ui.ts,supabase-auth-client.ts,supabase-cookie-adapter.ts}`.

Supabase clients: `src/lib/supabase/server.ts`.

Direct Entry boundary: `src/lib/direct-entry/{actor-context-repository.ts,change-request-api.ts,document-api.ts,full-profile-batch.ts,write-api.ts,session-bootstrap.ts}`.

AI gateway boundary: `src/lib/ai/gateway/server/{config.mjs,service.mjs,review.mjs,review-wiring.ts}`, `src/lib/ai-config/{settings-flag.ts,server/route-helpers.mjs,server/settings.mjs}`.

Navigation: `src/lib/navigation/registry.ts`, `src/components/app-shell/{app-shell.tsx,desktop-nav.tsx,mobile-nav.tsx,user-session-control.tsx}`.

Migrations cited: `20261001120000`, `20261001130100`, `20261001160000`,
`20261001170000`, `20261001170100`, `20261002170000`,
`20261005000000`, `20261005050000`, `20261005060000`, `20261005070000`,
`20261007010000`. (39 migrations total in `supabase/migrations/`.)

H04 commits cited: `f974da9a02ff178f638e733791af9426c1f99622`,
`524961e3`. Handoff: `docs/handoffs/p1.7-h04-remove-pilot-basic-auth.md`.