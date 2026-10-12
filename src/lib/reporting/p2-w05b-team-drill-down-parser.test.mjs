import assert from "node:assert/strict";
import test from "node:test";

import { parseTeamDrillDownRequest } from "./p2-w05b-team-drill-down-parser.ts";

const bucket = "team." + Buffer.from("TEAM_A").toString("base64url");

 test("R1 parser counts Unicode code points and accepts exactly 128 four-byte characters", () => {
  const code = "🦄".repeat(128);
  const result = parseTeamDrillDownRequest({ bucket_key: "team." + Buffer.from(code).toString("base64url") });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.bucket_key.length, 688);

  const tooLong = parseTeamDrillDownRequest({ bucket_key: "team." + Buffer.from("🦄".repeat(129)).toString("base64url") });
  assert.equal(tooLong.ok, false);
});

test("R1 parser rejects duplicate limit and defaults only when limit is absent", () => {
  const absent = parseTeamDrillDownRequest({ bucket_key: bucket });
  assert.equal(absent.ok, true);
  if (absent.ok) assert.equal(absent.value.limit, 25);

  const duplicate = parseTeamDrillDownRequest({ bucket_key: bucket, limit: ["1", "100"] });
  assert.equal(duplicate.ok, false);

  const explicit = parseTeamDrillDownRequest({ bucket_key: bucket, limit: "100" });
  assert.equal(explicit.ok, true);
  if (explicit.ok) assert.equal(explicit.value.limit, 100);
});

test("R1 parser rejects source and preserves shared filter validation", () => {
  assert.equal(parseTeamDrillDownRequest({ bucket_key: bucket, source: "00000000-0000-4000-8000-000000000001" }).ok, false);
  assert.equal(parseTeamDrillDownRequest({ bucket_key: bucket, from: "2026-10-12", to: "2026-10-11" }).ok, false);
});
