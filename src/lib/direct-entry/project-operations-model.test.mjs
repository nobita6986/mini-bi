import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssignRequest,
  buildCreateRequest,
  buildRenameRequest,
  buildSetActiveRequest,
  buildUnassignRequest,
  classifyResponse,
  parseDetailResponse,
  parseListResponse,
  projectStatusLabel,
  splitAssignments,
  validatePendingAssignments,
  validateProjectId,
  validateReason,
} from "./project-operations-model.ts";

const KEY = "55555555-5555-4555-8555-555555555555";
const RECRUITER = "66666666-6666-4666-8666-666666666666";
const RECRUITER_2 = "88888888-8888-4888-8888-888888888888";
const ASSIGNMENT = "77777777-7777-4777-8777-777777777777";

const FORBIDDEN = ["actor", "auth_subject", "app_user_id", "capability",
  "capabilities", "scope", "scopes", "role", "roles", "created_by"];

function assertNoAuthorityFields(body) {
  for (const key of FORBIDDEN) {
    assert.equal(key in body, false, "client khong duoc gui " + key);
  }
}

test("tao du an: body dung key va khong gui truong quyen", () => {
  const result = buildCreateRequest({ projectId: "du-an-01", displayName: " Dự án 01 ",
    reason: "khoi tao", idempotencyKey: KEY });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.body).sort(), ["display_name", "idempotency_key",
    "project_id", "reason"]);
  assert.equal(result.body.display_name, "Dự án 01");
  assertNoAuthorityFields(result.body);
});

test("doi ten du an: bat buoc expected_version (OCC) va reason", () => {
  const missingVersion = buildRenameRequest({ displayName: "X", reason: "r",
    expectedVersion: undefined, idempotencyKey: KEY });
  assert.equal(missingVersion.ok, false, "thieu expected_version phai bi chan");

  const ok = buildRenameRequest({ displayName: "Tên mới", reason: "doi ten",
    expectedVersion: 3, idempotencyKey: KEY });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.expected_version, 3);
  assert.equal(ok.body.reason, "doi ten");
  assertNoAuthorityFields(ok.body);
});

test("ngung/kich hoat: CHI doi co active, khong co RPC rieng", () => {
  const off = buildSetActiveRequest({ active: false, reason: "ngung su dung",
    expectedVersion: 4, idempotencyKey: KEY });
  assert.equal(off.ok, true);
  assert.equal(off.body.active, false);
  assert.equal("action" in off.body, false);
  assert.equal("rpc" in off.body, false);

  const on = buildSetActiveRequest({ active: true, reason: "khoi phuc",
    expectedVersion: 5, idempotencyKey: KEY });
  assert.equal(on.body.active, true);
  assert.equal(projectStatusLabel(true), "Đang hoạt động");
  assert.equal(projectStatusLabel(false), "Đã ngừng");
});

test("gan nhieu quan ly: chan trung lap va du lieu sai", () => {
  assert.equal(validatePendingAssignments([]), "Cần ít nhất một quản lý dự án.");
  assert.notEqual(validatePendingAssignments([
    { managerRecruiterId: RECRUITER, validFrom: "2026-10-01" },
    { managerRecruiterId: RECRUITER, validFrom: "2026-10-02" },
  ]), null, "khong duoc gan trung mot quan ly");
  assert.equal(validatePendingAssignments([
    { managerRecruiterId: RECRUITER, validFrom: "2026-10-01" },
    { managerRecruiterId: RECRUITER_2, validFrom: "2026-10-02" },
  ]), null);

  const bad = buildAssignRequest({ managerRecruiterId: "khong-phai-uuid",
    validFrom: "2026-10-01", reason: "r", expectedProjectVersion: 1, idempotencyKey: KEY });
  assert.equal(bad.ok, false);

  const badDate = buildAssignRequest({ managerRecruiterId: RECRUITER,
    validFrom: "01/10/2026", reason: "r", expectedProjectVersion: 1, idempotencyKey: KEY });
  assert.equal(badDate.ok, false, "ngay phai ISO YYYY-MM-DD");
});

test("thu hoi: gui CA hai version (assignment + project) va reason bat buoc", () => {
  const noReason = buildUnassignRequest({ reason: "  ", expectedVersion: 1,
    expectedProjectVersion: 2, idempotencyKey: KEY });
  assert.equal(noReason.ok, false, "reason rong phai bi chan");

  const ok = buildUnassignRequest({ reason: "thu hoi", expectedVersion: 1,
    expectedProjectVersion: 2, idempotencyKey: KEY });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.expected_version, 1);
  assert.equal(ok.body.expected_project_version, 2);
  assertNoAuthorityFields(ok.body);
});

test("ly do bat buoc cho MOI thao tac thay doi", () => {
  assert.notEqual(validateReason(""), null);
  assert.notEqual(validateReason("   "), null);
  assert.notEqual(validateReason("x".repeat(4001)), null);
  assert.equal(validateReason("hop le"), null);

  const builders = [
    () => buildCreateRequest({ projectId: "p1", displayName: "X", reason: "",
      idempotencyKey: KEY }),
    () => buildRenameRequest({ displayName: "X", reason: " ",
      expectedVersion: 1, idempotencyKey: KEY }),
    () => buildSetActiveRequest({ active: false, reason: "",
      expectedVersion: 1, idempotencyKey: KEY }),
    () => buildAssignRequest({ managerRecruiterId: RECRUITER, validFrom: "2026-10-01",
      reason: "", expectedProjectVersion: 1, idempotencyKey: KEY }),
    () => buildUnassignRequest({ reason: "", expectedVersion: 1,
      expectedProjectVersion: 1, idempotencyKey: KEY }),
  ];
  for (const build of builders) assert.equal(build().ok, false, "thieu reason phai bi chan");
});

test("ma du an: chi chap nhan shape DB cho phep", () => {
  assert.equal(validateProjectId("du-an.01:A"), null);
  assert.notEqual(validateProjectId("   "), null);
  assert.notEqual(validateProjectId("-bat-dau-sai"), null);
  assert.notEqual(validateProjectId("x".repeat(129)), null);
});

test("xung dot OCC: version du an CU => bat buoc tai lai, khong ghi de", () => {
  const staleProject = classifyResponse(409, { ok: false, code: "PROJECT_CONFLICT" });
  assert.equal(staleProject.kind, "reload-required");
  assert.match(staleProject.message, /tải lại/i);

  // Cung ket qua khi server tra 409 khong kem code (van phai tai lai).
  assert.equal(classifyResponse(409, null).kind, "reload-required");
});

test("xung dot OCC: version phan cong CU cung bat buoc tai lai", () => {
  const staleAssignment = classifyResponse(409, { ok: false, code: "PROJECT_CONFLICT" });
  assert.equal(staleAssignment.kind, "reload-required");
});

test("loi duoc sanitized: khong lo ma DB/raw message", () => {
  const cases = [
    [403, { ok: false, code: "PROJECT_DENIED" }, "denied"],
    [404, { ok: false, code: "PROJECT_NOT_FOUND" }, "not-found"],
    [400, { ok: false, code: "PROJECT_INVALID" }, "invalid"],
    [401, { ok: false, code: "UNAUTHENTICATED" }, "unauthenticated"],
    [500, { ok: false, code: "PROJECT_UNAVAILABLE" }, "unavailable"],
  ];
  for (const [status, payload, kind] of cases) {
    const outcome = classifyResponse(status, payload);
    assert.equal(outcome.kind, kind);
    for (const leak of ["P0002", "42501", "23505", "40001", "SQLSTATE", "postgres",
      "duplicate key", "relation "]) {
      assert.equal(outcome.message.includes(leak), false, "ro ri " + leak);
    }
  }
});

test("parse response: fail-closed khi shape sai", () => {
  assert.equal(parseListResponse(null), null);
  assert.equal(parseListResponse({ ok: false }), null);
  assert.equal(parseListResponse({ ok: true, list: { projects: [{}] } }), null);
  assert.deepEqual(parseListResponse({ ok: true, list: { projects: [
    { project_id: "p1", display_name: "A", active: true, version: 2 },
  ] } }), [{ project_id: "p1", display_name: "A", active: true, version: 2 }]);

  assert.equal(parseDetailResponse({ ok: true, detail: { assignments: [{}] } }), null);
  const detail = parseDetailResponse({ ok: true, detail: { authorization_date: "2026-10-07",
    project_id: "p1", project_version: 2, project_active: true,
    active_assignment_count: 1, assignments: [{ assignment_id: ASSIGNMENT, project_id: "p1",
      project_version: 2, manager_recruiter_id: RECRUITER, valid_from: "2026-10-01",
      valid_to: null, effective: true, version: 1, revoked_at: null,
      created_at: "2026-10-01T00:00:00Z" }] } });
  assert.equal(detail.assignments.length, 1);
});

test("tach quan ly hien tai va lich su phan cong", () => {
  const make = (id, effective, validTo, from) => ({ assignment_id: id, project_id: "p1",
    project_version: 1, manager_recruiter_id: RECRUITER, valid_from: from, valid_to: validTo,
    effective, version: 1, revoked_at: validTo, created_at: from });
  const split = splitAssignments([
    make(ASSIGNMENT, true, null, "2026-10-01"),
    make("aaaa", false, "2026-09-30", "2026-09-01"),
  ]);
  assert.equal(split.current.length, 1);
  assert.equal(split.history.length, 1);
});
