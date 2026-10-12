import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../../../../lib/reporting/p2-w05b-team-reporting-server.ts", import.meta.url), "utf8");

 test("R9 route owns auth, runtime, no-store headers and status mapping", () => {
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /await guardApiSession\(\)/);
  assert.match(server, /cache-control.*private, no-store/);
  assert.match(server, /x-content-type-options.*nosniff/);
  assert.match(server, /referrer-policy.*no-referrer/);
  assert.match(server, /status: 400/);
  assert.match(server, /status: 403/);
  assert.match(server, /status: 503/);
});

test("R9 thin parser does not widen shared parser or accept source", () => {
  assert.match(server, /parseTeamDrillDownRequest/);
  assert.match(server, /ALLOWED_KEYS/);
  assert.match(server, /parseReportingFilters\(filterParams, undefined\)/);
  assert.match(server, /limit = 25/);
  assert.match(server, /limit > 100/);
  assert.doesNotMatch(server, /parseReportingFilters.*team_active/);
  assert.doesNotMatch(server, /"source"/);
  assert.doesNotMatch(server, /JSON\.stringify\(\{ ok: true/);
});
