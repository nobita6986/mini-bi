import assert from "node:assert/strict";
import test from "node:test";

import { decideSessionPageAccess } from "./session-page-access.ts";

test("P1.7-H04: chua dang nhap thi chuyen toi Supabase login", () => {
  assert.equal(decideSessionPageAccess({ ok: false, reason: "UNAUTHENTICATED" }), "REDIRECT_LOGIN");
});

test("P1.7-H04: actor thieu mapping hoac disabled dung UX sanitized, khong lo chi tiet", () => {
  assert.equal(decideSessionPageAccess({ ok: false, reason: "ACTOR_MAPPING_MISSING" }),
    "ACCOUNT_UNAVAILABLE");
  assert.equal(decideSessionPageAccess({ ok: false, reason: "ACTOR_DISABLED" }),
    "ACCOUNT_UNAVAILABLE");
});

test("P1.7-H04: loi ha tang/khong resolve duoc la tam thoi, khong phai cho phep", () => {
  assert.equal(decideSessionPageAccess(null), "TEMPORARY_UNAVAILABLE");
  for (const reason of ["ACTOR_REPOSITORY_MISSING", "ACTOR_REPOSITORY_INVALID",
    "AMBIGUOUS_TEAM_MEMBERSHIP", "AMBIGUOUS_RECRUITER_LINK"]) {
    assert.equal(decideSessionPageAccess({ ok: false, reason }), "TEMPORARY_UNAVAILABLE", reason);
  }
});

test("P1.7-H04: actor hop le duoc di qua", () => {
  assert.equal(decideSessionPageAccess({ ok: true, actor: {} }), "ALLOW");
});
