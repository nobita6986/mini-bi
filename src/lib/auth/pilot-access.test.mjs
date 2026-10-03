import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { evaluatePilotAccess, isPilotProtectedPath, PILOT_AUTH_REALM } from "./pilot-access.ts";

const auth = (cred) => "Basic " + Buffer.from(cred, "utf8").toString("base64");

const USER = "pilot";
const PASS = "s3cret";

test("1. development cho phép không cần credential", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: true, username: undefined, password: undefined, authorizationHeader: null }),
    { kind: "allow" }
  );
});

test("2. production thiếu username => 503 (unavailable)", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: undefined, password: PASS, authorizationHeader: auth(USER + ":" + PASS) }),
    { kind: "unavailable" }
  );
});

test("3. production thiếu password => 503 (unavailable)", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: undefined, authorizationHeader: auth(USER + ":" + PASS) }),
    { kind: "unavailable" }
  );
});

test("4. không Authorization => 401", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: null }),
    { kind: "unauthorized" }
  );
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: "" }),
    { kind: "unauthorized" }
  );
});

test("5. scheme không phải Basic => 401", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: "Bearer " + Buffer.from(USER + ":" + PASS).toString("base64") }),
    { kind: "unauthorized" }
  );
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: "Digest abc" }),
    { kind: "unauthorized" }
  );
});

test("6. Base64 malformed => 401", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: "Basic !!!not-base64!!!" }),
    { kind: "unauthorized" }
  );
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: "Basic abc" }),
    { kind: "unauthorized" }
  );
});

test("7. payload thiếu dấu ':' => 401", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: auth("pilot") }),
    { kind: "unauthorized" }
  );
});

test("8. sai username => 401", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: auth("wrong:" + PASS) }),
    { kind: "unauthorized" }
  );
});

test("9. sai password => 401", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: auth(USER + ":wrong") }),
    { kind: "unauthorized" }
  );
});

test("10. credential đúng => allow", () => {
  assert.deepEqual(
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: auth(USER + ":" + PASS) }),
    { kind: "allow" }
  );
});

test("11. password có ký tự đặc biệt / dấu ':' vẫn xử lý đúng", () => {
  const cases = [
    "p@ss:wörd!$",
    "mật#khẩu",
    "a b:c=d+e/f?",
  ];
  for (const pw of cases) {
    const decision = evaluatePilotAccess({
      isDevelopment: false,
      username: USER,
      password: pw,
      authorizationHeader: auth(USER + ":" + pw),
    });
    assert.deepEqual(decision, { kind: "allow" }, "password: " + pw);
  }
});

test("12. không có secret trong decision (object lỗi/response)", () => {
  const decisions = [
    evaluatePilotAccess({ isDevelopment: false, username: undefined, password: undefined, authorizationHeader: null }),
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: null }),
    evaluatePilotAccess({ isDevelopment: false, username: USER, password: PASS, authorizationHeader: auth(USER + ":" + PASS) }),
  ];
  for (const d of decisions) {
    const json = JSON.stringify(d);
    assert.ok(!json.includes(PASS), "decision không được chứa password");
    assert.ok(!json.includes(USER), "decision không được chứa username");
    // Chỉ chứa đúng key 'kind', không có field thừa nào có thể rò rỉ giá trị.
    assert.deepEqual(Object.keys(d), ["kind"]);
  }
  assert.equal(PILOT_AUTH_REALM, "Mini BI Pilot");
});

test("13. matcher bao phủ login, auth API, dashboard và Direct Entry", () => {
  for (const p of [
    "/login",
    "/login/reset",
    "/api/auth",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/session",
    "/api/auth/other/path",
    "/dashboard",
    "/dashboard/a",
    "/dashboard/a/b/c",
    "/pipeline-check",
    "/pipeline-check/x",
    "/api/reporting",
    "/api/reporting/x/y",
    "/direct-entry",
    "/direct-entry/",
    "/direct-entry/submissions/123",
    "/api/direct-entry",
    "/api/direct-entry/",
    "/api/direct-entry/session",
    "/api/direct-entry/entries/123",
    "/api/direct-entry/change-requests",
  ]) {
    assert.equal(isPilotProtectedPath(p), true, p);
  }
});

test("14. route ngoài matcher (như '/') không bị gate", () => {
  for (const p of [
    "/",
    "/about",
    "/api/other",
    "/loginx",
    "/api/authx",
    "/dashboardx",
    "/pipeline-checkfoo",
    "/direct-entryx",
    "/api/direct-entryx",
  ]) {
    assert.equal(isPilotProtectedPath(p), false, p);
  }
});
