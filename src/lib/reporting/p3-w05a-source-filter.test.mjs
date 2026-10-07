import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SOURCE_OUT_OF_SCOPE_MESSAGE,
  validateAllSourceFilter,
} from "./p3-w05a-source-filter.ts";

const ACTIVE = "11111111-1111-4111-8111-111111111111";
const TEST = "22222222-2222-4222-8222-222222222222";
const INACTIVE = "33333333-3333-4333-8333-333333333333";
const MISSING = "44444444-4444-4444-8444-444444444444";
const ALLOWLIST = [ACTIVE];

test("R3: active/non-test source in the allowlist is accepted", () => {
  const r = validateAllSourceFilter({ source: ACTIVE, allowlist: ALLOWLIST });
  assert.deepEqual(r, { ok: true });
});

test("R3: unset source is accepted", () => {
  assert.deepEqual(validateAllSourceFilter({ source: undefined, allowlist: [] }), { ok: true });
});

test("R3: test source is rejected as INVALID_FILTER", () => {
  const r = validateAllSourceFilter({ source: TEST, allowlist: ALLOWLIST });
  assert.deepEqual(r, { ok: false, code: "INVALID_FILTER", message: SOURCE_OUT_OF_SCOPE_MESSAGE });
});

test("R3: inactive source is rejected as INVALID_FILTER", () => {
  const r = validateAllSourceFilter({ source: INACTIVE, allowlist: ALLOWLIST });
  assert.deepEqual(r, { ok: false, code: "INVALID_FILTER", message: SOURCE_OUT_OF_SCOPE_MESSAGE });
});

test("R3: nonexistent source UUID is rejected as INVALID_FILTER", () => {
  const r = validateAllSourceFilter({ source: MISSING, allowlist: ALLOWLIST });
  assert.deepEqual(r, { ok: false, code: "INVALID_FILTER", message: SOURCE_OUT_OF_SCOPE_MESSAGE });
});
