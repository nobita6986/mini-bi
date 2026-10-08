# P2.5-HF-R5A — Final UI/interaction audit (UI-only)

**Status:** `P2.5-HF-R5A_UI_FINAL_INTERACTION_AUDIT_LOCAL_PASS_AWAITING_T0_REVIEW`
Base `origin/main@910fa2f6d69ebd560e7f1067ae61e102814222e7`; R1 is a fast-forward on the same branch.
UI/client tests only: no migration, RPC, schema, capability/grant or authorization change; header untouched.

1. Load-more failure was silent: 5xx and every network `catch` returned `message: null`, so retained rows
   rendered nothing. All paths carry `WORKER_LOAD_FAILED_MESSAGE` + red alert + `Thử lại`.
2. Drawer never returned focus (Radix restores focus only via `Dialog.Trigger`, and it is state-opened).
3. `/catalog` 403 was reported as a system error; 403 is now an authority limit (sky info), 5xx stays red.
4. `managerLabel` fallback showed a UUID fragment; now a neutral business label.
5. **R1 (T0 review):** the two remaining silent paths — the initial `fetchSubmissions(null)` and
   `fetchRequests(null)` rejections — now use that same canonical message (no second helper): retained
   rows are kept, both retained-rows alerts render it with a working retry, queue never prints `()`.

## Evidence — `test:p2.5-hf-r5a-browser` 41/41 real Chrome against the production component
Queue before list once · initial tab per actor · cursor paging 25+5 without duplicate/lost row · failed
load-more plus the new uploader/queue network rejects keep rows + red alert + working retry · initial
rejects show the canonical copy and never a blank page · 403 tab isolation · no UUID in the UI · all-field
preload + changed-only ENTRY_FIELD (reason/OCC/idempotency) · WORK_STATUS OFF needs leave reason, ON sends
none · separate bank flow · privileged correction · catalog denied vs error · capability gate · Escape +
focus return. Mutation-checked: reverting a handler to `message: null` fails the node guard and browser check; R4 47/47.
## Gates — `p2.5-w06` 62/62 · `test:server` 215/215 · `app-nav-02a` 92/92 · `pnpm test` PASS (44 lanes) ·
typecheck/lint 0 error · build PASS · docs/secrets · 61 migrations · `git diff --check` clean. Both backend
gaps unchanged (reviewer BEFORE projection; PM/privileged input catalog); no merge/deploy/Production.
