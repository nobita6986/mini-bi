# PRE-W2-HF-D1 — Dashboard-only navigation for the duplicate CCCD report

- **Status:** `PRE_W2_HF_D1_DASHBOARD_ONLY_DUPLICATE_CCCD_LOCAL_PASS_AWAITING_T0_REVIEW`
- **Base:** `origin/main@a056f37fa3791a3b63c8e894866f31fb8501a5d0` (ledger 87; P2 name-correction merged #14).
- **Impl SHA:** `ef2d58115276fe7f25a47bb8d43d2e2a1e6ccaf5`
- **Branch / worktree:** `feature/pre-w2-hf-d1-dashboard-only-duplicate-cccd` trên worktree cô lập
  `C:\CodeApp\BI\.worktrees\pre-w2-hf-d1` (`node_modules` là junction về primary). **Primary
  checkout không bị chạm.**

## Preflight kết luận (current origin/main)

- Đã fetch: base `a056f37`, ledger 87.
- Callers của report: chỉ `dashboard/page.tsx` → `DashboardView`/`BodDashboardTabs` →
  `DuplicateCccdReportPanel`; API `/api/direct-entry/duplicate-cccd-report` (dùng cho panel, giữ
  nguyên). **Không có trang/endpoint báo cáo độc lập** (`/reports/duplicate-cccd` không tồn tại).
- Menu chính có entry `duplicate-cccd-report` (`path: /dashboard?tab=duplicate-cccd`, capability
  metadata `duplicate_cccd_report`) → đây chính là link độc lập cần bỏ.
- **Không cần đổi authorization/backend:** Dashboard dùng `decideSessionPageAccess` = ALLOW cho mọi
  `actor.ok`, và `canViewDuplicateCccdReport` = `actor.ok`. Nghĩa là mọi account được HF-C cho phép
  xem CCCD trùng **đã** vào được Tổng quan và mở tab bằng deep link. Không có blocker.

## Thay đổi (chỉ điều hướng/UI + test)

- **`registry.ts`**: xoá entry `duplicate-cccd-report` khỏi `NAV_ENTRIES`; xoá token `duplicate_cccd_report`
  khỏi union `NavCapability`; xoá import `ShieldAlert` (đã thành unused).
- **`registry-capability.ts`**: xoá `duplicateCccdReportNavPredicate` và mục `duplicate_cccd_report`
  trong `NAV_CAPABILITY_PREDICATES` (chỉ dùng cho entry đã bỏ; không còn dead code).
- **`desktop-nav.tsx` / `mobile-nav.tsx`**: xoá ánh xạ icon `"duplicate-cccd-report": ShieldAlert`
  và import `ShieldAlert`.
- **Dashboard tab giữ nguyên**: `bod-dashboard-tabs.tsx` vẫn có tab thứ ba `Báo cáo CCCD trùng` sau
  `Báo cáo theo nhóm`, gate bằng `canViewDuplicateCccd`. `dashboard/page.tsx` vẫn server-gate deep
  link `?tab=duplicate-cccd`; `dashboard-view.tsx` không đổi.
- **Không** sửa tiêu chí trùng/RPC/migration/API/permission/projection; **không** tạo trang/panel/API
  thứ hai; **không** đổi authorization các tab Tổng quan / Báo cáo theo nhóm.

## File

- Sửa `src/lib/navigation/registry.ts`, `src/lib/navigation/registry-capability.ts`.
- Sửa `src/components/app-shell/desktop-nav.tsx`, `src/components/app-shell/mobile-nav.tsx`.
- Sửa tests: `src/lib/navigation/registry.test.mjs`, `src/lib/navigation/registry-capability.test.mjs`,
  `src/lib/auth/duplicate-cccd-report-access.test.mjs` (đổi expectation sang Dashboard-only).
- Sửa `package.json` (lane `test:pre-w2-hf-d1-dashboard-only-duplicate-cccd`, đăng ký một lần vào
  `pnpm test`).
- Mới `scripts/pre-w2-hf-d1-dashboard-only-duplicate-cccd-mutation.mjs`.
- Mới `docs/handoffs/pre-w2-hf-d1-dashboard-only-duplicate-cccd.md` (file này).

## Acceptance mapping (đều có regression)

1. Menu chính không còn "Báo cáo CCCD trùng" — `registry.test.mjs` + access test "no standalone nav entry".
2. Tab CCCD vẫn trong Tổng quan, sau "Báo cáo theo nhóm" — access test "Dashboard tab right after team".
3. Account HF-C vẫn mở từ Tổng quan + deep link — `canViewDuplicateCccdReport` test + "Dashboard page server-gates".
4. Tab Tổng quan/Báo cáo theo nhóm giữ nguyên authorization — "Dashboard page + view server-gate" test (general/team/own branches unchanged).
5. Không có duplicate panel/endpoint/page — access test "no standalone nav entry or page".

## Test & gate

- Focused lane `test:pre-w2-hf-d1-dashboard-only-duplicate-cccd` — **61/61 pass** (access + registry +
  registry-capability + resolve-nav-actor).
- Related lanes: `test:app-nav-02a` (96), `test:pre-w2-hf-c-global-duplicate-cccd-read-access` (15+10),
  `test:p3-1-hf-duplicate-cccd-report` (10), `test:p3-1-hf-mobile-theme-menu` (52) — tất cả xanh.
- `pnpm typecheck` 0 · `pnpm lint` 0 error / 13 warning pre-existing · `next build --webpack` 0 ·
  `pnpm docs:check` 6/6 · `pnpm secrets:check` clean · `git diff --check` 0.

## Mutation evidence

`node scripts/pre-w2-hf-d1-dashboard-only-duplicate-cccd-mutation.mjs` — **4/4 RED**, khôi phục
byte-identical:
1. Nav độc lập tái xuất hiện (deep-link path) → nav-menu test đỏ.
2. Xoá tab CCCD khỏi Dashboard → tab-order test đỏ.
3. Bỏ gate server `canViewDuplicateCccdReport` → gate test đỏ.
4. Tab CCCD hiển thị không cần quyền (`visibleTabs` luôn true) → gate/tab test đỏ.

## Rủi ro / blocker

- Không có blocker. Quyền thật vẫn do `direct_entry_assert_duplicate_cccd_reader` (#87) + API/RPC
  enforce; UI chỉ ẩn nav + giữ tab có gate server-derived.
- `canViewDuplicateCccdReport` được giữ nguyên (mở cho mọi `actor.ok`) — chỉ bỏ đường vào menu độc
  lập, không thu hẹp audience CCCD.
- Không merge main; không apply DB/migration; không deploy VPS/Vercel; không tự UAT (Owner chạy).
