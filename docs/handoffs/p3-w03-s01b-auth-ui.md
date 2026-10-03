# P3-W03-S01B — Login / logout UI

| Mục | Giá trị |
| --- | --- |
| Task | P3-W03-S01B |
| Owner | T1A |
| Base | `612f75d4874abc51e2f04766763dfc9c186f4fb5` (`feature/p3-auth-session-s01a`) |
| Branch | `feature/p3-auth-ui-s01b` |
| Worktree | `C:/CodeApp/BI-p3-auth-ui` |
| Trạng thái | `P3-W03-S01B_AUTH_UI_IMPLEMENTED_FAST_TRACK` (browser acceptance chưa chạy) |

Server contract provenance: `docs/handoffs/p3-w03-s01a-auth-session-server.md` (khóa ở S01A). UI này chỉ tiêu thụ ba API
`POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`; không sửa contract.

## Đã làm

| File | Nội dung |
| --- | --- |
| `src/lib/auth/auth-ui.ts` | pure helper: allowlist destination (`/dashboard`, `/direct-entry`), từ chối absolute/protocol-relative/encoded/ngoài allowlist; map mã lỗi → tiếng Việt (không lộ raw code) |
| `src/components/auth/login-form.tsx` | client form nhỏ (native form): email `type=email`/`autoComplete=username`/`inputMode=email` + trim trước request; password `type=password`/`autoComplete=current-password`/`spellCheck=false` + Eye/EyeOff (lucide) với `aria-label` đúng trạng thái; đúng **một** POST JSON `{email,password}`; chặn double submit (`disabled`/`aria-busy`); xoá password sau lỗi; không localStorage/sessionStorage/console/credential |
| `src/components/auth/login-gate.tsx` | session bootstrap: gọi `GET /api/auth/session` đúng một lần; 200 → `router.replace(safeDestination)` (không render projection); 401 → form; 403 → thông báo chung “tài khoản chưa được cấp quyền”; 503/network → lỗi tạm thời + nút thử lại thủ công (không auto-loop) |
| `src/app/login/page.tsx` | server page + `Suspense` + metadata; không biến toàn trang thành client |
| `src/components/app-shell/user-session-control.tsx` | client nhỏ trong AppShell: session → `Đăng xuất` (POST logout, 204 → `/login` + refresh) hoặc link `Đăng nhập`; logout failure hiển thị lỗi sanitized, không giả vờ thành công; touch target 44px; không render `app_user_id`/capabilities/scopes |
| `src/components/app-shell/app-shell.tsx` | thêm `UserSessionControl` cạnh ThemeSelector (giữ layout hiện có) |

## Safe redirect policy
Chỉ nhận query `next` **exact** trong allowlist `/dashboard`, `/direct-entry`; mọi giá trị khác (absolute, `//`, encoded `%2F`, path ngoài allowlist, có query/fragment) đều về `/dashboard`. Không dùng redirect URL do API trả về. Không đặt credential vào URL/query/analytics/console.

## Bất biến giữ nguyên
- Basic Auth outer gate cho `/login` và `/api/auth` (S01A): **không** sửa/retire; không coi Basic Auth là Supabase session.
- Session control chỉ là UX; route/RPC vẫn là authority (không capability nav filtering, không client role mapping).
- Không sửa `PILOT_ACCESS_*`, proxy, navigation registry, package/lockfile, migration/RPC/schema.

## Tests / gates (đã chạy)
- `auth-ui.test.mjs`: allowlist + reject redirect + error mapping sanitized.
- `login.test.mjs` (source guard): form một POST + trim email + password không trim; chặn double submit; xoá password sau lỗi; session gọi một lần + safe redirect + không auto-loop; logout 204 → /login + không giả vờ thành công; không localStorage/sessionStorage; không render actor/capability/scope; page là server + Suspense.
- `next typegen` + `pnpm typecheck`: PASS.
- Existing auth-session server / pilot-access / proxy / app-shell / navigation / Direct Entry session suites: (xem mục gates của báo cáo bàn giao).

## Deferred
- **Browser acceptance** (desktop 1920×1080 + mobile 390×844, matrix ở prompt): chưa chạy trong lượt này → trạng thái chỉ là `UI_IMPLEMENTED`, **không** tuyên bố `..._BROWSER_PASS_FAST_TRACK`.
- Full `pnpm test`: defer cho integration.
- Real Supabase Auth / Production UAT: defer.

Không gọi Supabase Auth thật, không tạo user, không DB/R2 mutation, không đổi env/CORS, không deploy.
