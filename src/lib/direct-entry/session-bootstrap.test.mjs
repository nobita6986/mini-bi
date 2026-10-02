import assert from "node:assert/strict";
import test from "node:test";

import { createDirectEntrySessionResponse } from "./session-bootstrap.ts";

const safeActor = {
  auth_subject: "auth-subject-secret",
  app_user_id: "app-user-stable-id",
  enabled: true,
  capabilities: ["entry_create"],
  scopes: [{ kind: "own", reference: "app-user-stable-id", valid_from: "0001-01-01", valid_to: null }],
  self_recruiter_suggestion: "recruiter-stable-id",
  session: { provider: "supabase", verification: "getUser", authenticated_at: null },
};

function sessionResult(actor) {
  return {
    actor,
    response_headers: { "cache-control": "private", pragma: "no-cache" },
  };
}

test("disabled API gate returns before creating a session or calling the RPC", async () => {
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    let calls = 0;
    const response = await createDirectEntrySessionResponse(flag, async () => {
      calls += 1;
      throw new Error("should not be reached");
    });
    assert.equal(response.status, 404);
    assert.equal(calls, 0);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("unauthenticated and all unavailable actor mappings have bounded public errors", async () => {
  const unauthenticated = await createDirectEntrySessionResponse("true", async () =>
    sessionResult({ ok: false, reason: "UNAUTHENTICATED" }));
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { ok: false, code: "UNAUTHENTICATED" });

  for (const reason of [
    "ACTOR_MAPPING_MISSING",
    "ACTOR_DISABLED",
    "ACTOR_REPOSITORY_INVALID",
    "AMBIGUOUS_TEAM_MEMBERSHIP",
  ]) {
    const denied = await createDirectEntrySessionResponse("true", async () =>
      sessionResult({ ok: false, reason }));
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { ok: false, code: "ACTOR_NOT_AVAILABLE" });
  }
});

test("success returns only UI projection fields and disables caching", async () => {
  const response = await createDirectEntrySessionResponse("true", async () =>
    sessionResult({ ok: true, actor: safeActor }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  const body = await response.json();
  assert.deepEqual(Object.keys(body.actor).sort(), [
    "app_user_id", "capabilities", "scopes", "self_recruiter_suggestion",
  ]);
  assert.equal(JSON.stringify(body).includes("auth_subject"), false);
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("email"), false);
});

test("session and RPC failures return sanitized errors", async () => {
  const response = await createDirectEntrySessionResponse("true", async () => {
    throw new Error("database_url token=secret");
  });
  assert.equal(response.status, 503);
  const body = JSON.stringify(await response.json());
  assert.equal(body.includes("database_url"), false);
  assert.equal(body.includes("secret"), false);
});
