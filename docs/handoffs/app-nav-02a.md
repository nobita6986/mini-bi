# Handoff — APP-NAV-02A — Product Navigation Preparation for P1.6-I04

> Status: **APP-NAV-02A_READY_FOR_P1.6_I04_INTEGRATION**
> Worktree: `C:\CodeApp\BI-app-nav-02a`
> Branch: `feature/app-nav-02a`
> Base: `702240ded473a8c5f64ef355f459192d924998df` (P1.6-W04-S04B-S02B1)
> Scope: Navbar preparation only. Không triển khai login/RBAC, không merge
> integration/main, không deploy.

## 1. Mục tiêu & phạm vi

P1.6-I04 (integration) cần navbar sản phẩm sạch trước khi R2/document upload.
Task này chuẩn bị sẵn sàng nhưng KHÔNG chạy P3 RBAC thật:

- Navbar hiện hành chỉ còn 2 product entries: `Tổng quan` (Dashboard) và
  `Nhập liệu` (Direct Entry).
- Pipeline Check (Google Sheets → n8n) bị loại khỏi navbar; route cũ
  redirect server-side về `/dashboard`.
- Direct Entry được bọc bởi `AppShell` hiện có trên desktop và mobile.
- Không thêm dependency / icon library mới.
- Giữ metadata `capability` để P3 lọc menu sau này bằng session thật.

## 2. Menu trước / sau

### Trước (base `702240d`)

| id                | label                       | path             | status   | visible desktop / mobile |
| ----------------- | --------------------------- | ---------------- | -------- | ------------------------ |
| `dashboard`       | `Tổng quan tuyển dụng`      | `/dashboard`     | current  | true / true              |
| `pipeline-check`  | `Pipeline check`            | `/pipeline-check` | current  | true / true              |
| `direct-entry`    | `Nhập liệu trực tiếp`      | `/direct-entry`  | planned  | true / true              |

Mô tả Pipeline Check: `"Trạng thái đường dẫn dữ liệu Google Sheets → n8n → Supabase."`

### Sau (APP-NAV-02A)

| id             | label          | path             | status  | visible desktop / mobile | capability   |
| -------------- | -------------- | ---------------- | ------- | ------------------------ | ------------ |
| `dashboard`    | `Tổng quan`    | `/dashboard`     | current | true / true              | `any`        |
| `direct-entry` | `Nhập liệu`    | `/direct-entry`  | current | true / true              | `entry_admin` (đại diện cho `entry_own \| entry_team \| entry_admin`) |

- Pipeline Check đã bị loại khỏi `NAV_ENTRIES` hoàn toàn (không còn
  `planned` entry dự phòng; spec yêu cầu "không thay bằng một mục planned khác").
- Không còn chuỗi `Google Sheets` / `n8n` trong `registry.ts`,
  `desktop-nav.tsx`, `mobile-nav.tsx`, `app-shell.tsx` (test
  `registry: KHÔNG có chuỗi 'Google Sheets' hay 'n8n'` đảm bảo điều này).

## 3. File ownership

### Được sửa

| File | Thay đổi |
| --- | --- |
| `src/lib/navigation/registry.ts` | Loại `pipeline-check`; promote `direct-entry` thành `current`; thêm 3 token `entry_own`/`entry_team`/`entry_admin` vào `NavCapability`; dọn description cũ. |
| `src/lib/navigation/registry.test.mjs` | Cập nhật cho shape mới: chỉ Dashboard + Direct Entry; không còn `planned`; capability subset; test không còn n8n/Sheets. |
| `src/components/app-shell/app-shell.tsx` | Đổi comment giới thiệu (bỏ "Pipeline Check"). Không đổi logic render. |
| `src/components/app-shell/app-shell.test.mjs` | Thêm test: navbar lấy từ registry, không hard-code label; không nhắc Google Sheets/n8n; không hard-code UI role. |
| `src/app/direct-entry/layout.tsx` | **Mới** — wrap `<AppShell currentPath="/direct-entry">`. |
| `src/app/direct-entry/layout.test.mjs` | **Mới** — kiểm tra layout wrap AppShell đúng `currentPath`, không tạo shell thứ hai, không import `@/lib/ai-*`. |
| `src/app/pipeline-check/page.tsx` | Thay toàn bộ bằng `redirect("/dashboard")` server-side. Không fetch, không render pipeline UI. |
| `src/app/pipeline-check/layout.tsx` | **Bỏ** — route chỉ redirect, không render. AppShell wrap cũ không còn cần thiết. |
| `src/app/pipeline-check/layout.test.mjs` | **Đổi** từ test layout → test page redirect (không fetch, không render UI cũ; không nhắc n8n/Sheets ngoài comment giải thích). |

### Không sửa (khoá trong task)

- `src/app/direct-entry/page.tsx` (giữ nguyên gate `isDirectEntryUiEnabled`,
  `<DirectEntryShell>`).
- `src/lib/direct-entry/*` (write/payment/document/draft/session).
- `src/app/api/direct-entry/*`.
- Migration / RPC / DB schema.
- `package.json` / `pnpm-lock.yaml` (không dependency mới).
- Auth/session implementation (P3 territory).
- `src/app/layout.tsx` (root) — vẫn ở trạng thái base, không can thiệp.
- Worktree `T1B`/`T1A`.

## 4. Capability metadata — chỉ là preparation

`NavCapability` hiện bao gồm các token:

- `"any" | "owner" | "finance" | "hrp"` (giữ nguyên từ base, dự phòng).
- `"entry_own" | "entry_team" | "entry_admin"` (mới — lấy từ
  `src/lib/contracts/direct-entry-v1.ts: Capability` để không phát minh
  vocabulary mới).

Direct Entry lưu `capability = "entry_admin"` (token rộng nhất trong ba token
Direct Entry). Đây là cách biểu diễn **một trong** các token `entry_own |
entry_team | entry_admin` khi schema chỉ cho phép một giá trị string.

**Quan trọng:** metadata này **không phải authorization**. App Shell hiện
không filter dựa trên `capability`. Direct URL vẫn phải được bảo vệ bởi
route guard / API guard hiện có của Direct Entry (`isDirectEntryUiEnabled`,
session bootstrap, write/payment/document route handlers).

P3 sẽ thay thế bằng:

```ts
// future P3 wiring — chưa implement trong APP-NAV-02A
const visibleEntries = CURRENT_NAV_ENTRIES.filter((entry) =>
  entry.capability === "any" || session.hasCapability(entry.capability)
);
```

## 5. Pipeline Check retirement

Quyết định: redirect server-side.

- `src/app/pipeline-check/page.tsx` giờ chỉ là:
  ```ts
  export const dynamic = "force-dynamic";
  export default function PipelineCheckPage(): never {
    redirect("/dashboard");
  }
  ```
- `layout.tsx` bị xóa vì không có render xảy ra. `redirect()` throw
  `NEXT_REDIRECT` (Next.js 16 documented behavior trong
  `node_modules/next/dist/docs/01-app/02-guides/redirecting.md`), nên
  AppShell cũ không bao giờ được gọi.
- Source lịch sử của `page.tsx` cũ và `layout.tsx` cũ còn trong git
  history (commit trước APP-NAV-02A), không xóa DB/reporting history.
- Test `pipeline-check: layout.tsx đã được bỏ` xác nhận route không
  render pipeline data cũ.

## 6. Test matrix đã chạy

48 targeted tests pass:

- `src/lib/navigation/registry.test.mjs` — 19 test (Dashboard + Direct Entry
  only, capability subset, không còn `pipeline-check`, không `planned`).
- `src/components/app-shell/app-shell.test.mjs` — 18 test (shell
  structure, registry import, không hard-code label, không nhắc
  n8n/Sheets, không UI role).
- `src/app/direct-entry/layout.test.mjs` — 5 test (layout wrap AppShell,
  không tạo shell thứ hai, không import AI modules, page.tsx không đổi).
- `src/app/pipeline-check/layout.test.mjs` — 6 test (redirect đúng, không
  fetch, không UI cũ, không nhắc kiến trúc cũ ngoài comment).

### Fast-track gates

| Gate | Kết quả |
| --- | --- |
| `pnpm typecheck` (sau `next typegen`) | PASS |
| Targeted ESLint trên 4 dirs đã sửa | PASS, không warning/error |
| `pnpm build` | PASS, 4 static + các dynamic routes (bao gồm `/pipeline-check` vẫn dynamic, `/direct-entry` dynamic) |
| `pnpm docs:check` | PASS, 6/6 |
| `pnpm secrets:check` | PASS, 751 files scanned, 0 secret |
| `git diff --check` | PASS |

## 7. Deferred — không nằm trong APP-NAV-02A

- **P3 capability-based filtering thật.** App Shell vẫn render tất cả
  `CURRENT_NAV_ENTRIES` cho mọi phiên. Khi P3 có session/authn thật sẽ
  filter theo `entry.capability`. Spec tường minh: "P3 sau này sẽ dùng
  server session để filter thật. Không triển khai fake client-side RBAC."
- **Browser keyboard acceptance / NVDA / VoiceOver.** Deferred cho I04
  hoặc sprint a11y riêng.
- **Capability vocabulary mở rộng** (vd. `entry_restore`, `pii_view`).
  Direct Entry contract đã có sẵn; task này chỉ thêm 3 token navbar cần
  ngay.
- **Login / logout / deployment.**
- **Full `pnpm test` matrix.** Tập này đã chạy targeted; chạy full
  matrix sẽ thuộc I04 integration.

## 8. Cách port vào P1.6-I04

Khi cherry-pick hoặc merge vào integration branch:

1. Pull `feature/app-nav-02a` vào integration worktree. Conflict có thể
   xảy ra ở `src/lib/navigation/registry.ts` (đã sửa) và
   `src/app/pipeline-check/page.tsx` (đã đổi).
2. Trong I04:
   - Nếu cần entry `Pipeline Check` cho migration period: chỉ cần thêm
       lại vào `NAV_ENTRIES` với `status: 'planned'` (hiện đã bỏ theo
       spec). Nhưng spec rõ ràng là "không thay bằng một mục planned
       khác", nên **không** nên thêm lại trừ khi I04 xác nhận yêu cầu.
   - Direct Entry AppShell wrap đã có sẵn, chỉ cần đảm bảo
       `DIRECT_ENTRY_UI_ENABLED=true` để page render bình thường trong
       acceptance script.
3. Sau khi I04 đóng, P3 sẽ thay thế `AppShell` đọc session thật và filter
   `CURRENT_NAV_ENTRIES` theo `entry.capability`. Metadata trong registry
   đã đủ để làm điều đó mà không cần đổi schema.

## 9. Xác nhận (checklist từ spec)

- [x] Navbar hiện hành chỉ có Dashboard + Direct Entry.
- [x] Pipeline Check bị loại khỏi `CURRENT_NAV_ENTRIES` và `NAV_ENTRIES`.
- [x] Direct Entry `status = 'current'`, desktop + mobile visible.
- [x] Không thay bằng một mục "planned" khác.
- [x] Capability vocabulary dùng token hiện có (`entry_own`,
      `entry_team`, `entry_admin` từ `direct-entry-v1.ts`).
- [x] Metadata là preparation, không triển khai fake RBAC.
- [x] Direct Entry được bọc bởi `AppShell` hiện có với
      `currentPath="/direct-entry"`.
- [x] Direct Entry page business logic không đổi (assert bởi
      `direct-entry/layout.test.mjs`).
- [x] Desktop nav và mobile Radix Sheet render từ cùng registry
      (`entriesForViewport`).
- [x] Pipeline direct route redirect server-side về `/dashboard`,
      không render pipeline UI cũ, không nhắc Google Sheets/n8n trong
      code (chỉ comment giải thích).
- [x] Không xóa DB / reporting history.
- [x] Không thêm dependency mới (`package.json`/`pnpm-lock.yaml`
      không đổi).
- [x] App Shell giữ nguyên Radix Dialog/Sheet, Lucide, ThemeSelector.
- [x] Fast-track gates pass.

## 10. Commit

Sẽ commit trên `feature/app-nav-02a` với message tối thiểu:

```
APP-NAV-02A: navbar preparation for P1.6-I04

- registry: drop pipeline-check; promote direct-entry to current;
  add entry_own|entry_team|entry_admin NavCapability tokens
- App Shell: keep Radix Dialog/Sheet + Lucide + ThemeSelector;
  remove pipeline references
- direct-entry: wrap with AppShell currentPath=/direct-entry
- pipeline-check: page redirect to /dashboard (server-side);
  layout.tsx removed (route never renders)
- tests: 48 targeted tests cover registry, AppShell, direct-entry
  layout, pipeline-check redirect
- no new deps; no Direct Entry business logic touched; P3
  capability filtering deferred
```

Push tới `origin/feature/app-nav-02a` và xác minh remote SHA = local HEAD.