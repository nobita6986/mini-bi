import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionWithBoundedRetry } from "./direct-entry-session-retry.ts";

function makeResult(value) {
  return { actor: value, response_headers: {} };
}

test("resolveSessionWithBoundedRetry: tra ngay ket qua neu lan goi dau tien thanh cong", async () => {
  let calls = 0;
  const result = await resolveSessionWithBoundedRetry(async () => {
    calls += 1;
    return makeResult({ ok: true });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, makeResult({ ok: true }));
});

test("resolveSessionWithBoundedRetry: retry 1 lan khi transient throw, thanh cong lan 2", async () => {
  let calls = 0;
  const result = await resolveSessionWithBoundedRetry(async () => {
    calls += 1;
    if (calls === 1) throw new Error("transient network");
    return makeResult({ ok: false, reason: "UNAUTHENTICATED" });
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.actor, { ok: false, reason: "UNAUTHENTICATED" });
});

test("resolveSessionWithBoundedRetry: throw sau khi retry 1 lan neu ca hai lan throw", async () => {
  let calls = 0;
  await assert.rejects(async () => {
    await resolveSessionWithBoundedRetry(async () => {
      calls += 1;
      throw new Error("always fails: " + calls);
    });
  }, /always fails: 2/);
  assert.equal(calls, 2);
});

test("resolveSessionWithBoundedRetry: khong retry vo han (toi da 2 lan goi)", async () => {
  let calls = 0;
  await assert.rejects(async () => {
    await resolveSessionWithBoundedRetry(async () => {
      calls += 1;
      throw new Error("endless");
    });
  });
  assert.equal(calls, 2, "bounded retry phai dung o 2 lan goi");
});

test("resolveSessionWithBoundedRetry: tra ngay ket qua UNAUTHENTICATED ma khong throw (4xx logic khong retry)", async () => {
  let calls = 0;
  const result = await resolveSessionWithBoundedRetry(async () => {
    calls += 1;
    return makeResult({ ok: false, reason: "UNAUTHENTICATED" });
  });
  assert.equal(calls, 1);
  assert.equal(result.actor.ok, false);
  assert.equal(result.actor.reason, "UNAUTHENTICATED");
});
