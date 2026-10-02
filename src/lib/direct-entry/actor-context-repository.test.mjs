import assert from "node:assert/strict";
import test from "node:test";

import { resolveActor } from "../auth/direct-entry-v2.ts";
import { createDirectEntryActorRepository } from "./actor-context-repository.ts";

const session = {
  auth_subject: "91000000-0000-4000-8000-000000000001",
  provider: "supabase",
  authenticated_at: null,
};
const at = "2026-10-03T00:00:00.000Z";

async function resolveWithRpc(rpc) {
  return resolveActor({
    session,
    repository: createDirectEntryActorRepository(rpc),
    at,
  });
}

test("repository passes only the verified subject to the context RPC", async () => {
  const calls = [];
  const repository = createDirectEntryActorRepository(async (authSubject) => {
    calls.push(authSubject);
    return { data: null, error: null };
  });
  assert.equal(await repository.loadByAuthSubject(session.auth_subject, at), null);
  assert.deepEqual(calls, [session.auth_subject]);
});

test("malformed data, RPC errors, and thrown failures fail closed as invalid mappings", async () => {
  for (const rpc of [
    async () => ({ data: [{ app_user_id: "forged" }], error: null }),
    async () => ({ data: null, error: new Error("raw database detail") }),
    async () => { throw new Error("transport detail"); },
  ]) {
    const result = await resolveWithRpc(rpc);
    assert.deepEqual(result, { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
  }
});
