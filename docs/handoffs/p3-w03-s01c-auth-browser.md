# P3-W03-S01C — Auth UI browser acceptance

| Mục | Giá trị |
| --- | --- |
| Task | P3-W03-S01C |
| Owner | T1A |
| Base | `7c665a615bf8f5418f194b1a16f2246eadb38e10` (parent `612f75d4874abc51e2f04766763dfc9c186f4fb5` = S01A server contract) |
| Branch | `feature/p3-auth-browser-s01c` |
| Worktree | `C:/CodeApp/BI-p3-auth-browser` |
| Trạng thái | `P3-W03-S01C_AUTH_UI_BROWSER_PASS_FAST_TRACK` |

## Provenance 612f75d → 7c665a6

- `612f75d4874abc51e2f04766763dfc9c186f4fb5` — `feat(auth): add login/logout/server routes` (S01A, server-only — `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`).
- `7c665a615bf8f5418f194b1a16f2246eadb38e10` — `feat(auth): add login and logout UI` (S01B, UI tiêu thụ ba API ở trên; không sửa contract).

Hai commit giữ nguyên Basic Auth outer gate (proxy + S01A `auth.ts` matcher), không thay đổi server contract, không migration / RPC / schema, không thêm dependency.

## Browser matrix (52 kiểm tra)

Tier A — kiểm tra tĩnh + behavioural replay với stub `fetch` (không gọi Supabase Auth, không dev-server, không DB). 52/52 PASS.

Script: `node --test scripts/p3-w03-s01c-source-acceptance.mjs`

| Mục | Tổng | Nội dung chính |
| --- | --- | --- |
| A. Login bootstrap | 7/7 | GET `/api/auth/session` một lần trong `LoginGate`; 401 → form; 200 → `router.replace(safeDestination)`; 403 → "Tài khoản chưa được cấp quyền sử dụng hệ thống"; 503/network → error + nút "Thử lại" (không `setTimeout`/`setInterval`); retry sinh request mới. |
| B. Safe destination | 8/8 | `resolveSafeAuthDestination` chỉ nhận `/dashboard`, `/direct-entry`; loại `https://…`, `//…`, `%2F%2F…`, `%2Fdashboard`, `/dashboard%00`, `/admin`, `/direct-entry-extra`, `/dashboard/../direct-entry`, `javascript:…`. Bootstrap fetch không đọc body — API không thể điều khiển redirect. |
| C. Login form | 17/17 | email `type=email`/`autoComplete=username`/`inputMode=email`; password `type={showPassword ? "text" : "password"}`/`autoComplete="current-password"`/`spellCheck={false}`; Eye/EyeOff + aria-label đổi; một POST JSON exact `{email,password}`; email được `trim()`; password **không** trim; không `actor/role/capability/scope/redirect/next` trong body; `if (busy) return` chặn double submit; `disabled={busy}` + `aria-busy={busy}`; success → `router.replace(destination)`; `AUTH_INVALID_CREDENTIALS`/`ACCOUNT_NOT_AVAILABLE`/`AUTH_UNAVAILABLE`/`CSRF_REJECTED` đều map qua `authUiErrorMessage` (sanitized tiếng Việt, không raw code); sau lỗi `setPassword("")`; email **không** bị clear; `role="alert"` + `aria-live="polite"`; `aria-describedby` khi có lỗi. |
| D. AppShell session/logout | 8/8 | `UserSessionControl`: 200 → "Đăng xuất"; 401 → "Đăng nhập"; 403 → loading/unavailable (không render `app_user_id`/`capabilities`/`scopes`); một POST `/api/auth/logout`; 204 → `router.replace("/login")` + `router.refresh()`; 503/network → lỗi "Không thể đăng xuất lúc này. Vui lòng thử lại."; `if (busy) return` chặn double click; `h-11` (44px). |
| E. Privacy/security | 6/6 | không email/password/token/session/actor trong URL; không `localStorage`/`sessionStorage`; không `console.*`; không `access_token`/`refresh_token`/`provider_token`/`bearer`; UI không gọi `Authorization` header (proxy = outer gate); `UserSessionControl` không redirect khi session 200 (UI ≠ route authority). |
| F. Responsive / a11y | 6/6 | desktop 1920×1080 và mobile 390×844 không overflow (max-w-sm + w-full + absolute reveal button); Tab/Enter dùng native `<form>` + `type="submit"` + `type="button"`; `focus-visible:ring-2` trên mọi input/button; không màu hardcoded (Tailwind tokens); card có `p-6 shadow-sm` reserved height; alert dùng cùng card pattern. |

Behavioural harness dùng `scripts/lib/p3-auth-harness.mjs` (`createAuthStubFetch`, `simulateLoginGate`, `simulateLoginForm`, `simulateSessionControl`, `simulateLogout`) để replay flow với `fetch` stub — quan sát URL/method/headers/body cho mọi matrix. Không gọi mạng, không DB, không Supabase Auth.

## Desktop / mobile evidence

5 ảnh synthetic được tạo qua system Chrome + CDP (`scripts/p3-w03-s01c-screenshots.mjs`):

| File | Viewport | Trạng thái |
| --- | --- | --- |
| `docs/acceptance/p3-auth/login-desktop.png` | 1920×1080 | Login card centered, email + password (Eye/EyeOff), submit |
| `docs/acceptance/p3-auth/login-mobile.png` | 390×844 | Card max-w-sm, không overflow, touch targets 44px |
| `docs/acceptance/p3-auth/login-invalid.png` | 1280×720 | `AUTH_INVALID_CREDENTIALS` → "Email hoặc mật khẩu không đúng." (sanitized, không raw code) |
| `docs/acceptance/p3-auth/login-account-unavailable.png` | 1280×720 | `ACCOUNT_NOT_AVAILABLE` → alert, không form, không actor projection |
| `docs/acceptance/p3-auth/app-shell-logout.png` | 1920×1080 | AppShell với "Đăng xuất" button ở header; không có email/PII/secret trong ảnh |

Tất cả dữ liệu trong ảnh là synthetic (`user@example.invalid`); không password/token/PII/secret.

## Bug/fix

Không phát hiện bug. Matrix 52/52 PASS ngay lần chạy đầu; không sửa auth UI / helper / test nào. `git status --short` chỉ liệt kê 4 file mới (`docs/acceptance/p3-auth/`, `scripts/lib/p3-auth-harness.mjs`, `scripts/p3-w03-s01c-prior-checks.mjs`, `scripts/p3-w03-s01c-screenshots.mjs`, `scripts/p3-w03-s01c-source-acceptance.mjs`).

## Prior check coverage

`scripts/p3-w03-s01c-prior-checks.mjs` chạy lại các suite đã chạy ở S01A/S01B:

| Suite | Tests | Pass |
| --- | --- | --- |
| S01B login UI source-guard (`login.test.mjs` + `auth-ui.test.mjs`) | 8 | 8 |
| S01A auth-session server (`auth-session-core`, `supabase-cookie-adapter`, `pilot-access`, `proxy`, `direct-entry/session/route`, `session-bootstrap`, `direct-entry-v2`) | 55 | 55 |
| AppShell + nav registry + layouts (`registry`, `app-shell`, `direct-entry/layout`, `pipeline-check/layout`) | 50 | 50 |
| **Total prior** | **113** | **113** |

## Full test total

`pnpm test` (toàn bộ script chain `test:p1.6-*` + `test:main` + `test:server` + `test:export`):

- **889 tests pass / 0 fail** (tổng `ℹ pass` từ 19 sub-suite trong `/tmp/s01c_test.log`).
- Không thêm dependency mới; `package.json` không đổi.

## Quality gates

| Gate | Kết quả |
| --- | --- |
| `next typegen` | PASS (route types generated) |
| `pnpm typecheck` (`tsc --noEmit`) | PASS |
| Targeted ESLint (`src/components/auth`, `src/components/app-shell/user-session-control.tsx`, `src/lib/auth`) | PASS, 0 warning |
| `pnpm build` | PASS — `/login` (static), `/api/auth/*` (dynamic via proxy matcher); middleware proxy ghi nhận |
| `pnpm docs:check` | 6/6 examples PASS |
| `pnpm secrets:check` | 648 files scanned, no secret found |
| `git diff --check` | PASS |

## Deferred (giữ nguyên từ S01A/S01B)

- Real Supabase Auth / Production UAT — không có trong scope browser synthetic.
- DNS read-only DB dry-run — S01A đã ghi nhận `ENOTFOUND`; S01C không thêm migration nên không cần.

## Files

- `scripts/p3-w03-s01c-source-acceptance.mjs` — 52-check source + behavioural matrix (Tier A)
- `scripts/p3-w03-s01c-prior-checks.mjs` — replay prior suites (Tier B)
- `scripts/p3-w03-s01c-screenshots.mjs` — 5 CDP screenshots (Tier C)
- `scripts/lib/p3-auth-harness.mjs` — stub-fetch harness + replay helpers
- `docs/acceptance/p3-auth/login-desktop.png`, `login-mobile.png`, `login-invalid.png`, `login-account-unavailable.png`, `app-shell-logout.png`

## Trạng thái

`P3-W03-S01C_AUTH_UI_BROWSER_PASS_FAST_TRACK` — không tuyên bố P3 PASS, P1.6 PASS hay Production ready.