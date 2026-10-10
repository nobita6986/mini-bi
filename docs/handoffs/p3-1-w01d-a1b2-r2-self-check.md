# P3.1-W01D-A1b2-R2 — reserved-team helper self-check

> Base: `b3abd388e7457cfb890a2357fa8d2923dd684203`
> Scope: close the missing assertion in the migration's leader mutation-function self-check.

The R1 closing self-check already rejected `direct_entry_system_vendor_team_id()` in leader read function definitions, but the mutation-function loop did not. The mutation loop now checks each retrieved function definition (internal helper, designate RPC, revoke RPC) and raises generic `55000` if that reference is present. The read-loop diagnostic was also corrected to say “team-leader functions”; behavior is unchanged. Existing R1 `23514` reserved-team rejection, postconditions, and replacement rollback coverage remain intact.

`LEADER_WRITE_MUTATION=reserved-helper-reference` injects a comment-only reference into the mutation helper body. The focused lane fails while applying migration #71 with SQLSTATE `55000` from the closing migration self-check, not from post-apply JavaScript source inspection. The generic diagnostic is `reserved-team creator reference is forbidden in team-leader functions`. After clearing the mutation, the unchanged focused lane passes. Migration #71 SHA-256 before and after the probe is `b96524796ddead0270c77cc2fe4aacee9b13079f9a05cf76a82dceb36cf4fc7e` (identical). #1–#70 remain byte-identical; ledger remains 71 with no #72.

All required focused P3.1 lanes, `pnpm test`, Next typegen, typecheck, lint, build, docs, secrets, offline migration validation (71 valid), and `git diff --check` pass. Lint reports zero errors and 15 existing warnings.

No Production query/apply, deployment, browser/Playwright/CUA/UAT, A1b3, A2, W02, or W04 work is included.
