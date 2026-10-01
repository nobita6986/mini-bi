import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isPipelineCheckEnabled,
  PIPELINE_QUERY_FAILED_CODE,
  PIPELINE_QUERY_FAILED_MESSAGE,
  sanitizePipelineError,
} from "./pipeline-check-safety.ts";

test("development: route được phép (kể cả khi flag sai/thiếu)", () => {
  assert.equal(isPipelineCheckEnabled("development", undefined), true);
  assert.equal(isPipelineCheckEnabled("development", "false"), true);
});

test("production + thiếu flag: disabled", () => {
  assert.equal(isPipelineCheckEnabled("production", undefined), false);
});

test("production + PIPELINE_CHECK_ENABLED=false: disabled", () => {
  assert.equal(isPipelineCheckEnabled("production", "false"), false);
});

test("production + PIPELINE_CHECK_ENABLED=true: allowed", () => {
  assert.equal(isPipelineCheckEnabled("production", "true"), true);
});

test("production + giá trị flag bất kỳ khác 'true': disabled", () => {
  assert.equal(isPipelineCheckEnabled("production", "1"), false);
  assert.equal(isPipelineCheckEnabled("production", "TRUE"), false);
});

test("sanitizePipelineError trả thông báo ổn định, không lộ raw provider message", () => {
  const out = sanitizePipelineError();
  assert.equal(out.code, PIPELINE_QUERY_FAILED_CODE);
  assert.equal(out.message, PIPELINE_QUERY_FAILED_MESSAGE);
  assert.ok(!out.message.includes("Invalid API key"));
  assert.ok(!out.message.includes("permission denied"));
  assert.ok(!out.message.includes("JWT"));
});
