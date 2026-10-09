# P3.1-W01D-A1a2 — team leader schema regression (DONE)

Base `6500eea`, branch `feature/p3-1-w01d-team-leader-lifecycle` (base never amended).

**Deliverable** — `scripts/p3-1-w01d-a1a-leader-schema.test.mjs`: applies all 71
migrations in PGlite, asserts the 30 A1a2 items in 17 test blocks — green. Lane
`test:p3-1-w01d-a1a-leader-schema`: one definition, one `pnpm test` entry (last).

**Rebaseline 70 → 71** (no blind replace, no widened assertions) — 29 migration-count
guards + 33 positional guards (`at(-N)`/`length-(N)` → +1); function inventory
162/76/86 → 165/76/89 (measured; #71 adds 3 internal helpers). `p3-1-w01c-b` test:
scope/capability CHECKs now `>=` (W01D #71); raw zero-length writes stay 23514 via
the marker trigger.

**Mutation matrix A–H** — lane red, restored byte-identical: A CHECK→`>` · B drop
trigger · C drop index predicate · D drop FORCE RLS · E extra key · F grant EXECUTE ·
G vocab 23→22 · H membership CHECK→`>`. All 8 red. After restore: #71 SHA256 =
committed (`0b919eb6…828b5`); lane green 17/17.

**Gates (all green)** — focused lane · W01A/W01B/W01C-A/W01C-B · `pnpm test` (exit 0) ·
`db:migrate --offline` = 71 valid · `docs:check` · `secrets:check` · `git diff --check`.

**Cardinality (mandatory)** — indexes are key/start-date foundations only; overlap
resolution stays A1b (team-row lock + advisory/overlap guard + postconditions). Not
claimed here. Out of scope: RPCs, legacy transition, TS/API/UI, A1b, A2, W02, W04, Production, browser.
