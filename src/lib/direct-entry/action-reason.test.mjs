import assert from "node:assert/strict";
import test from "node:test";

import { projectOptionalActionReason } from "./action-reason.ts";

test("optional action reason canonicalizes absence and blank values to null", () => {
  for (const value of [undefined, null, "", "   ", "\n\t "]) {
    assert.deepEqual(projectOptionalActionReason(value), { ok: true, value: null });
  }
  assert.deepEqual(projectOptionalActionReason("  reviewed  "), { ok: true, value: "reviewed" });
});

test("optional action reason preserves strict type and length validation", () => {
  for (const value of [false, 1, [], {}]) {
    assert.deepEqual(projectOptionalActionReason(value), { ok: false });
  }
  assert.deepEqual(projectOptionalActionReason("x".repeat(4000)), {
    ok: true, value: "x".repeat(4000),
  });
  assert.deepEqual(projectOptionalActionReason("x".repeat(4001)), { ok: false });
  assert.deepEqual(projectOptionalActionReason("x".repeat(1001), 1000), { ok: false });
});
