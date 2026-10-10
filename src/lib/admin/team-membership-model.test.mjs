import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssignMembershipRequest,
  buildMembershipListQuery,
  buildTeamCatalogListQuery,
  buildUnassignMembershipRequest,
  classifyMembershipMutation,
  MEMBERSHIP_PAGE_SIZE,
  newMembershipIntentKey,
  projectActiveTeams,
  projectMembershipList,
  setMembershipConflictLock,
  TEAM_PAGE_SIZE,
} from "./team-membership-model.ts";

const RECRUITER_A = "80fd8d2a-f45a-4596-9ebd-213fb6246041";
const RECRUITER_B = "23f30a23-347e-4d25-b90d-41335643f9f7";
const TEAM_A = "61f2d564-a685-4fb2-ae5e-d76b33c77240";
const KEY = "91f6f4f5-5d32-4e59-8243-e1f8333dc801";

function membership(state = "CURRENT", recruiter_id = RECRUITER_A) {
  return {
    membership_id: "27d3c45b-b8c9-4160-8508-0b3c6daeb5f9",
    recruiter_id,
    team_id: TEAM_A,
    team_display_name: "Nhóm A",
    valid_from: "2026-10-01",
    valid_to: null,
    recruiter_version: 4,
    state,
  };
}

function membershipEnvelope(state = "CURRENT", rows = [membership(state)]) {
  return {
    ok: true,
    list: {
      authorization_date: "2026-10-09",
      page: 2,
      page_size: MEMBERSHIP_PAGE_SIZE,
      total: 26,
      memberships: rows,
    },
  };
}

test("membership requests strictly project state, recruiter, page and bounded page_size", () => {
  const query = buildMembershipListQuery(RECRUITER_A, "SCHEDULED", 2);
  assert.equal(query?.get("recruiter_id"), RECRUITER_A);
  assert.equal(query?.get("state"), "scheduled");
  assert.equal(query?.get("page"), "2");
  assert.equal(query?.get("page_size"), "25");
  assert.equal(query?.get("page_size"), String(MEMBERSHIP_PAGE_SIZE));
  assert.equal(buildMembershipListQuery("not-a-uuid", "HISTORY", 1), null);

  assert.equal(projectMembershipList(membershipEnvelope(), {
    recruiterId: RECRUITER_A,
    state: "CURRENT",
    page: 2,
  })?.memberships.length, 1);
  assert.equal(projectMembershipList(membershipEnvelope("CURRENT", [
    membership("CURRENT", RECRUITER_B),
  ]), { recruiterId: RECRUITER_A, state: "CURRENT", page: 2 }), null);
  assert.equal(projectMembershipList(membershipEnvelope("CURRENT", [
    membership("SCHEDULED"),
  ]), { recruiterId: RECRUITER_A, state: "CURRENT", page: 2 }), null);
  assert.equal(projectMembershipList(membershipEnvelope("CURRENT", [
    membership(),
    { ...membership(), unexpected: true },
  ]), { recruiterId: RECRUITER_A, state: "CURRENT", page: 2 }), null);
  assert.equal(projectMembershipList({
    ...membershipEnvelope(),
    list: { ...membershipEnvelope().list, page_size: 100 },
  }, { recruiterId: RECRUITER_A, state: "CURRENT", page: 2 }), null);
  assert.equal(projectMembershipList({
    ...membershipEnvelope(),
    detail: "unexpected",
  }, { recruiterId: RECRUITER_A, state: "CURRENT", page: 2 }), null);
});

test("team choices use strict active-only Team Catalog projection and bounded paging", () => {
  const query = buildTeamCatalogListQuery(1);
  assert.equal(query?.get("include_inactive"), "false");
  assert.equal(query?.get("page"), "1");
  assert.equal(query?.get("page_size"), String(TEAM_PAGE_SIZE));
  const row = {
    team_id: TEAM_A,
    code: "TEAM-A",
    display_name: "Nhóm A",
    active: true,
    version: 2,
    revision_count: 1,
  };
  const payload = {
    ok: true,
    list: {
      authorization_date: "2026-10-09",
      include_inactive: false,
      search: null,
      page: 1,
      page_size: TEAM_PAGE_SIZE,
      total: 2,
      teams: [row, { ...row, team_id: RECRUITER_B, code: "TEAM-B", active: false }],
    },
  };
  assert.deepEqual(projectActiveTeams(payload, 1)?.teams.map((team) => team.code), ["TEAM-A"]);
  assert.equal(projectActiveTeams({ ...payload, list: { ...payload.list, page_size: 25 } }, 1), null);
  assert.equal(projectActiveTeams({ ...payload, list: { ...payload.list, teams: [{ ...row, raw: "extra" }] } }, 1), null);
});

test("assign and move use canonical path and exact body without a team identifier", () => {
  for (const move of [false, true]) {
    const result = buildAssignMembershipRequest({
      recruiterId: RECRUITER_A,
      teamId: TEAM_A,
      validFrom: "2028-02-29",
      expectedVersion: 4,
      reason: "Điều chỉnh phân công",
      idempotencyKey: KEY,
      move,
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.request.url, `/api/admin/catalog/personnel/${RECRUITER_A}/team-memberships/${TEAM_A}${move ? "/move" : ""}`);
    assert.deepEqual(Object.keys(result.request.body).sort(), [
      "expected_version", "idempotency_key", "reason", "valid_from",
    ]);
    assert.equal("team_id" in result.request.body, false);
    assert.equal(result.request.idempotencyKey, KEY);
  }
  assert.equal(buildAssignMembershipRequest({
    recruiterId: RECRUITER_A,
    teamId: TEAM_A,
    validFrom: "2026-02-30",
    expectedVersion: 4,
    reason: "Lý do",
    idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildAssignMembershipRequest({
    recruiterId: RECRUITER_A,
    teamId: TEAM_A,
    validFrom: "2026-10-09",
    expectedVersion: 4,
    reason: " ",
    idempotencyKey: KEY,
  }).ok, false);
});

test("unassign and scheduled cancellation use exact request body and required values", () => {
  const request = buildUnassignMembershipRequest({
    recruiterId: RECRUITER_A,
    validTo: "2026-10-09",
    expectedVersion: 4,
    reason: "Kết thúc phân công",
    idempotencyKey: KEY,
  });
  assert.equal(request.ok, true);
  if (request.ok) {
    assert.equal(request.request.url, `/api/admin/catalog/personnel/${RECRUITER_A}/team-memberships/unassign`);
    assert.deepEqual(Object.keys(request.request.body).sort(), [
      "expected_version", "idempotency_key", "reason", "valid_to",
    ]);
    assert.equal("team_id" in request.request.body, false);
    assert.equal(request.request.idempotencyKey, KEY);
  }
  assert.equal(buildUnassignMembershipRequest({
    recruiterId: RECRUITER_A,
    validTo: "2026-02-30",
    expectedVersion: 4,
    reason: "Lý do",
    idempotencyKey: KEY,
  }).ok, false);
  assert.equal(buildUnassignMembershipRequest({
    recruiterId: RECRUITER_A,
    validTo: "2026-10-09",
    expectedVersion: 4,
    reason: "",
    idempotencyKey: KEY,
  }).ok, false);
});

test("mutation classification fails closed and distinguishes denial, absence and OCC", () => {
  const applied = {
    ok: true,
    membership: {
      membership_id: membership().membership_id,
      recruiter_id: RECRUITER_A,
      team_id: TEAM_A,
      valid_from: "2026-10-09",
      valid_to: null,
      recruiter_version: 5,
      revision_id: "4f2b5e1d-352f-4d86-8a7a-63f914996592",
      change: "ASSIGN",
    },
  };
  assert.equal(classifyMembershipMutation(200, applied, RECRUITER_A, "assign").kind, "applied");
  assert.equal(classifyMembershipMutation(200, { ...applied, extra: true }, RECRUITER_A, "assign").kind, "unavailable");
  assert.equal(classifyMembershipMutation(200, applied, RECRUITER_B, "assign").kind, "unavailable");
  assert.equal(classifyMembershipMutation(401, null, RECRUITER_A, "assign").kind, "unauthenticated");
  assert.equal(classifyMembershipMutation(403, null, RECRUITER_A, "assign").kind, "denied");
  assert.equal(classifyMembershipMutation(404, null, RECRUITER_A, "assign").kind, "not-found");
  assert.equal(classifyMembershipMutation(409, null, RECRUITER_A, "assign").kind, "conflict");
  assert.equal(classifyMembershipMutation(400, null, RECRUITER_A, "assign").kind, "invalid");
  assert.equal(classifyMembershipMutation(500, null, RECRUITER_A, "assign").kind, "unavailable");
});

test("entity conflict lock and retry intent remain scoped to one personnel", () => {
  const initial = new Set();
  const lockedA = setMembershipConflictLock(initial, RECRUITER_A, true);
  assert.equal(lockedA.has(RECRUITER_A), true);
  assert.equal(lockedA.has(RECRUITER_B), false);
  const unlockedA = setMembershipConflictLock(lockedA, RECRUITER_A, false);
  assert.equal(unlockedA.has(RECRUITER_A), false);
  assert.equal(initial.has(RECRUITER_A), false);
});

test("new mutation intent receives a fresh key while a retry keeps its original request key", () => {
  const firstKey = newMembershipIntentKey();
  const changedIntentKey = newMembershipIntentKey();
  assert.match(firstKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(changedIntentKey, firstKey);
  const first = buildAssignMembershipRequest({
    recruiterId: RECRUITER_A,
    teamId: TEAM_A,
    validFrom: "2028-02-29",
    expectedVersion: 4,
    reason: "Lý do đầu",
    idempotencyKey: firstKey,
  });
  const changed = buildAssignMembershipRequest({
    recruiterId: RECRUITER_A,
    teamId: TEAM_A,
    validFrom: "2028-03-01",
    expectedVersion: 4,
    reason: "Lý do đã sửa",
    idempotencyKey: changedIntentKey,
  });
  assert.equal(first.ok && first.request.idempotencyKey, firstKey);
  assert.equal(changed.ok && changed.request.idempotencyKey, changedIntentKey);
});
