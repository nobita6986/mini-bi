# P2.5-HF-R5A — Final UI/interaction audit (UI-only)

**Status:** `P2.5-HF-R5A_UI_FINAL_INTERACTION_AUDIT_LOCAL_PASS_AWAITING_T0_REVIEW`
Base `origin/main@910fa2f6d69ebd560e7f1067ae61e102814222e7`. UI/client tests only: no migration, RPC,
schema, capability/grant or authorization change; `UserSessionControl`/header untouched (T1C #62).

1. **Load-more failure was silent.** `httpFailure` gave `message: null` for 5xx and every network `catch`
   did too, so retained rows (`state:"ready"`) rendered nothing. All paths carry a sanitized message now.
2. **Drawer never returned focus.** Radix restores focus only via `Dialog.Trigger`, and this drawer is
   state-opened, so Escape/×/Huỷ dropped focus to `document.body`; the opening row button is restored.
3. **Denied catalog read as a system error.** `/catalog` 403 (`ACTOR_NOT_AVAILABLE`) and 5xx shared one red
   message; 403 is now an authority limit (sky info, `role="status"`), 5xx stays red, drawer fail-closed.
4. **UUID fragment used as a manager name.** Fallback `"Quản lý · " + id.slice(0, 8)` → neutral label.

## Evidence — `test:p2.5-hf-r5a-browser` (new, 36/36 real Chrome vs the production component)
Queue before list once · initial tab per actor · cursor paging 25+5 without duplicate/lost row · failed
load-more keeps rows · 403 isolated to its tab · no UUID in UI · all-field preload + changed-only
ENTRY_FIELD payload (reason/OCC/idempotency) · WORK_STATUS OFF needs leave reason, ON sends none ·
separate bank flow · privileged correction patch · catalog denied vs error · capability gate ·
mobile drawer metrics · Escape + focus return. Defects 1–2 mutation-checked.
## Gates — `p2.5-w06` 61/61 · `p2.5-w06a` 4/4 · `app-nav-02a` 92/92 · `test:server` 215/215 · `pnpm test` PASS
· typecheck 0 · lint 0 error (13 pre-existing warnings, none from new files) · build PASS · docs 6/6 · secrets
PASS · `db:migrate --offline` 61 valid · `git diff --check` clean. `test:p2.5-hf-r4-browser` 47/47 re-verifies
rename/set-active polarity, manager assign/revoke and the 409 write-lock. Both backend gaps unchanged and
now fail closed with precise copy. No merge/deploy/Production mutation.
