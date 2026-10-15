import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGrantRequest,
  buildMappingListQuery,
  buildRevokeRequest,
  classifyMappingResponse,
} from "./project-team-scope-ui-model.ts";

const TEAM = "66666666-6666-4666-8666-666666666666";
const MAPPING = "77777777-7777-4777-8777-777777777777";
const KEY = "55555555-5555-4555-8555-555555555555";

test("mapping query is bounded and preserves filters", () => {
  assert.equal(buildMappingListQuery({ projectId: "x", includeHistory: false, page: 0 }), null);
  assert.equal(buildMappingListQuery({ projectId: "x", includeHistory: false, page: 1001 }), null);
  assert.deepEqual([...buildMappingListQuery({ projectId: " project-1 ", teamId: ` ${TEAM} `, includeHistory: true, page: 2 }).entries()], [
    ["page", "2"], ["page_size", "25"], ["project_id", "project-1"], ["team_id", TEAM], ["include_history", "true"],
  ]);
});

test("legacy UI mutation builders are blocked until the coordinated batch UI contract update", () => {
  const grant = buildGrantRequest({ projectId: " project-1 ", teamId: TEAM,
    expectedPairVersion: 0, effectiveFrom: "", reason: "grant", idempotencyKey: KEY });
  assert.equal(grant.ok, false);
  const revoke = buildRevokeRequest({ mappingId: MAPPING, expectedPairVersion: 2,
    effectiveTo: "2026-10-15", reason: "same-day", idempotencyKey: KEY });
  assert.equal(revoke.ok, false);
  assert.equal(buildGrantRequest({ projectId: "x", teamId: TEAM, expectedPairVersion: -1,
    effectiveFrom: "", reason: "r", idempotencyKey: KEY }).ok, false);
  assert.equal(buildRevokeRequest({ mappingId: MAPPING, expectedPairVersion: 0,
    effectiveTo: "", reason: "r", idempotencyKey: KEY }).ok, false);
});

test("response mapping sanitizes conflict and authorization errors", () => {
  assert.equal(classifyMappingResponse(200).kind, "applied");
  assert.equal(classifyMappingResponse(401).kind, "denied");
  assert.equal(classifyMappingResponse(403).kind, "denied");
  assert.equal(classifyMappingResponse(409).kind, "conflict");
  assert.equal(classifyMappingResponse(422).kind, "invalid");
  assert.equal(classifyMappingResponse(503).kind, "unavailable");
});
