# P3-W03-S02B — Account unavailable / access denied UX closure

| Mục | Giá trị |
| --- | --- |
| Task | P3-W03-S02B |
| Owner | T1A |
| Base | `1577c035758306c54a4cd6be4808bea8452fc7c3` = `origin/main` |
| Branch | `feature/p3-access-denied-s02b` |
| Worktree | `C:/CodeApp/BI-p3-access-denied` |
| Final source | `e03cdfd86d690d4691e600e79a7762774c25c46b` (`P3-W03-S02B_ACCESS_DENIED_UX_IMPLEMENTED_FAST_TRACK`) |
| Trạng thái chấp nhận | Route decision matrix: PASS; browser visual: ACCEPTED DEFERRED; real Production route UAT: PENDING |

> **Supersession chain: S02B → R1 → R2 → R3A.**
>
> **R3A (final source `e03cdfd`)**: tách quyết định route ra pure helper `src/lib/auth/direct-entry-page-access.ts` (input đã resolve, output union `NOT_FOUND|REDIRECT_LOGIN|ACCOUNT_UNAVAILABLE|TEMPORARY_UNAVAILABLE|ACCESS_DENIED|ALLOW`); page dùng switch exhaustive. Evidence: **ROUTE DECISION MATRIX (pure) = PASS; FULL TEST/BUILD = PASS; UI COMPONENT BROWSER VISUAL = ACCEPTED DEFERRED** (không thêm test route/backdoor nên AccountUnavailable/AccessDenied không render được bằng harness synthetic); **REAL PRODUCTION ROUTE HAPPY PATH / NEGATIVE DB-AUTH STATES = PENDING**.
>
> **S02B-R1 và S02B-R2** (các commit trước).
>
> **R1**: khi `DIRECT_ENTRY_UI_ENABLED != "true"` dùng lại `notFound()`; flag on → route gate server-side: unauthenticated → redirect `/login?next=/direct-entry`; actor missing/disabled → `<AccountUnavailable />`; thiếu mọi `entry_own|entry_team|entry_admin` → `<AccessDenied />`.
>
> **R2 (transient failure semantics)**: hạ tầng Auth/actor resolver lỗi (repository missing/invalid, ambiguous mapping, unexpected throw) → `<TemporaryUnavailable />` ("Hệ thống xác thực tạm thời không khả dụng.") với retry thủ công (`router.refresh()`), **tách khỏi** account state (missing/disabled).

## Đã làm (UX closure; authorization authority không đổi)
- `src/lib/auth/auth-ui.ts`: đổi `AUTH_UNAVAILABLE` → "Hệ thống xác thực tạm thời không khả dụng."; thêm `ACCESS_DENIED_MESSAGE = "Bạn không có quyền truy cập chức năng này."`.
- `src/components/auth/login-gate.tsx`: trạng thái 403 (`ACCOUNT_NOT_AVAILABLE`) hiện thông báo chung + nút **Đăng xuất** (POST logout → `/login` + refresh); không phân biệt mapping missing/disabled, không lộ UUID/capability.
- `src/components/auth/access-denied.tsx` (MỚI): UX chung cho thiếu quyền truy cập resource — thông báo + link an toàn về Dashboard/Login; không nhận/hiển thị actor/capability/scope/raw code.
- `src/app/direct-entry/page.tsx`: final R3A pure decision returns `NOT_FOUND` when `DIRECT_ENTRY_UI_ENABLED` is off; with the UI enabled, server-resolved actor state selects login redirect, account-unavailable, temporary-unavailable, access-denied, or the page. API/DB guards are unchanged.
- `src/components/auth/access-denied.test.mjs` + cập nhật `auth-ui.test.mjs`, `login.test.mjs`: account-unavailable có action logout; access-denied UX chung + link an toàn; direct-entry flag off → `NOT_FOUND`; thông báo tạm thời đúng chuỗi; session chỉ gọi một lần.

## Bất biến giữ nguyên
- Server/session/API vẫn là authority; không client menu-hiding authorization; không nhận actor/role/capability/scope từ client; không thêm role string; không log raw body/error; destination chỉ dùng allowlist; không auto-loop retry; không optimistic session state.
- Basic Auth proxy fail-closed (không sửa); không bật `DIRECT_ENTRY_*`; không full capability nav; không DB/migration/Supabase user/env/CORS/R2/AI/P1.5; không deploy/merge.

## Tests / gates (đã chạy)
- Plain (auth-ui + login + access-denied + app-shell + navigation): **51/51 pass**.
- Auth-session server / pilot-access / supabase-cookie-adapter / proxy / session-bootstrap / session route (react-server): **30/30 pass**.
- `next typegen` + `pnpm typecheck`: PASS; targeted ESLint: exit 0; `pnpm build`: PASS; `pnpm docs:check`: 6/6; `pnpm secrets:check`: PASS; `git diff --check`: exit 0.

## Deferred
- **Browser visual acceptance** synthetic desktop 1920×1080 + mobile 390×844: **ACCEPTED DEFERRED**; do not claim browser visual PASS.
- **Real Production route happy/negative UAT**: PENDING; no credentialed route test is included in this lane.
- Full `pnpm test`: defer cho integration.

Không tuyên bố P3 PASS, P1.6 PASS, Production ready.
