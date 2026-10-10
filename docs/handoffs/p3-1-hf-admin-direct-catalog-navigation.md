# P3.1-HF — Admin direct catalog navigation handoff

- **Base:** `5640ef3774ea344b2133303351e53e4413f3c021` (mobile theme hotfix on `feature/p3-1-hf-mobile-theme-menu`).
- **Before:** `/admin` rendered an introductory card and required another click to reach Personnel.
- **After:** authorized requests to `/admin` server-redirect to `/admin/catalog/personnel`; no intermediate landing UI remains.
- **Default route:** `/admin/catalog/personnel`.
- **Active tabs:** shared `AdminSubnav` derives exactly one current tab from `usePathname()` using exact-or-nested-prefix matching. Personnel and Team nested routes remain highlighted after refresh/direct navigation.
- **Top-level navigation:** registry remains at `/admin`; existing longest-prefix matching keeps “Quản trị” active beneath both catalog routes. Desktop/mobile nav renderers are unchanged.
- **Security:** the `/admin` redirect follows the existing server-side actor resolution and `decideAdminAreaAccess`; the Admin layout and each catalog page retain their access gates and existing denied/unavailable states. Navigation visibility is not treated as authorization.
- **Reuse:** existing Admin section registry, shared `AdminSubnav`, `findEntryByPath`, and existing page-access decisions; no backend, capability, authority, API, migration, or dependency changes.
- **Tests:** focused Admin routing/subnav lane (97/97), navigation regression lane (96/96), mobile-theme lane (52/52), Personnel/Membership/Team UI lanes, and W01B/W01C backend lanes passed. All seven requested mutation probes were killed; every probed source file was restored byte-identically.
- **Gates:** canonical `pnpm test` passed (2,285/2,285 across 63 test programs); `next typegen`, typecheck, build, docs, secrets, and offline migrations (73) passed. Targeted ESLint: 0 errors, 0 warnings. Full lint: 0 errors, 15 pre-existing warnings in unrelated files. `git diff --check` passed.
- **Final commit SHA and remote parity:** confirmed in the completion summary.
- Browser/CUA/UAT was not run; it remains Owner-only.
