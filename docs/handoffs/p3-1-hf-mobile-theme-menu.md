# P3.1-HF — Mobile theme menu handoff

- **Base:** `79f9a4e46635a832c3c1816a4c53e3df73fb0a5b`.
- **Before:** theme selector was in the header at all viewport sizes.
- **After:** desktop keeps the existing header selector (`md:block`); mobile uses its compact, swatch-only trigger as the last footer item in the navigation drawer.
- Reuses `ThemeSelector`, `ThemeProvider`, `useTheme`, `THEMES`, storage persistence, and CSS variables. Both selector instances share provider state; `useId()` supplies unique menu IDs.
- The mobile popup portals into the Radix Dialog content, above its links and overlay, with viewport-bounded placement. Escape closes the popup first and returns focus to its trigger; the existing Dialog keeps drawer Escape/focus handling.
- No navigation registry, session behavior, dependency, API, or migration changes.
- Focused AppShell/mobile-navigation/theme lane: 52/52; navigation regression lane: 96/96.
- All six required mutations were killed; modified files were restored byte-identically.
- Gates: full `pnpm test` 2,183/2,183 (62 test programs); `next typegen`, typecheck, build, docs (6/6), secrets, and offline migration validation (73) passed. Full lint has 0 errors and 15 pre-existing warnings; changed-file lint has 0 warnings.
- Base SHA: `79f9a4e46635a832c3c1816a4c53e3df73fb0a5b`. Final commit SHA and remote parity are confirmed in the completion summary.
- Browser/UAT was intentionally not run (Owner-only).
