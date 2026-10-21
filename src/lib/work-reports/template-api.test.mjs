import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkReportMetricContract } from "./metric-contract.ts";
import {
  createTemplate, getTemplate, listTemplates, previewTemplate, templateAction, updateTemplate,
} from "./template-api.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222" };
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";

function schema(fieldType = "integer", metric = true) {
  let validation = {};
  let options = null;
  if (fieldType === "integer") validation = { min_value: 0, max_value: 999, allow_zero: true };
  if (fieldType === "decimal") validation = { min_value: 0, max_value: 999, decimal_places: 2, allow_zero: true };
  if (fieldType === "date") validation = { min_date_rule: "any" };
  if (fieldType === "text") validation = { min_length: 0, max_length: 100, pattern_preset: "none" };
  if (fieldType === "textarea") validation = { min_length: 0, max_length: 1000 };
  if (fieldType === "single_select" || fieldType === "multi_select") {
    validation = fieldType === "multi_select" ? { min_selected: 0, max_selected: 2 } : {};
    options = [{ option_key: "first", label: "First", active: true, sort_order: 10 }];
  }
  const spec = metric ? {
    metric_key: "field_one", unit: "items", aggregations: fieldType === "integer" ? ["SUM", "COUNT_VALID"] :
      fieldType === "boolean" ? ["TRUE_COUNT"] : ["COUNT_VALID"],
    null_policy: "EXCLUDE_FROM_AVG", zero_policy: "INCLUDE_AS_ZERO", compatible_group: "field_one_v1",
  } : null;
  return { version: "work-report-schema/1.0", sections: [{ section_key: "section_one", label: "Section",
    description: null, sort_order: 10, fields: [{ field_key: "field_one", section_key: "section_one",
      sort_order: 10, label: "Field", description: null, field_type: fieldType, required: false,
      default_value: null, validation, options, is_metric: metric, metric_spec: spec, is_dimension: false }] }] };
}

function deps(result = { ok: true, data: { template_id: TEMPLATE, draft_version_id: DRAFT, version: 2 } }, session = { actor: { ok: true, actor: ACTOR } }) {
  const calls = { session: 0, methods: [] };
  const repository = Object.fromEntries(["list", "get", "create", "update", "clone", "publish", "archive"]
    .map((method) => [method, async (value) => { calls.methods.push([method, value]); return result; }]));
  return { calls, dependencies: {
    resolveSession: async () => { calls.session += 1; return session; }, repository,
  } };
}

function request(body, method = "POST", extraHeaders = {}) {
  return new Request("https://app.test/api/work-reports/templates", {
    method, headers: { "content-type": "application/json", origin: "https://app.test",
      host: "app.test", "sec-fetch-site": "same-origin", ...extraHeaders }, body: JSON.stringify(body),
  });
}

const CREATE = { template_code: "DAILY_WORK", display_name: "Daily Work", description: null,
  default_frequency: "DAILY", schema_json: schema(), idempotency_key: KEY };

test("feature gate and session actor are required before RPC", async () => {
  const gated = deps();
  assert.equal((await listTemplates("false", gated.dependencies)).status, 404);
  assert.equal(gated.calls.session, 0);
  const signedOut = deps(undefined, { actor: { ok: false, reason: "UNAUTHENTICATED" } });
  assert.equal((await listTemplates("true", signedOut.dependencies)).status, 401);
  assert.equal(signedOut.calls.methods.length, 0);
});

test("create derives metric contract, trusts only session actor, and rejects authority injection", async () => {
  const { calls, dependencies } = deps();
  const response = await createTemplate(request(CREATE), "true", dependencies);
  assert.equal(response.status, 200);
  assert.equal(calls.methods[0][0], "create");
  assert.equal(calls.methods[0][1].auth_subject, ACTOR.auth_subject);
  assert.deepEqual(calls.methods[0][1].metric_contract_json, buildWorkReportMetricContract(CREATE.schema_json));
  const injected = deps();
  assert.equal((await createTemplate(request({ ...CREATE, app_user_id: ACTOR.app_user_id }), "true", injected.dependencies)).status, 400);
  assert.equal(injected.calls.methods.length, 0);
});

test("unsupported storage metric field types are rejected while non-metric text/date remain valid", async () => {
  for (const type of ["text", "textarea", "date"]) {
    const unsupported = deps();
    const body = { ...CREATE, schema_json: schema(type, true) };
    assert.equal((await createTemplate(request(body), "true", unsupported.dependencies)).status, 400, type);
    assert.equal(unsupported.calls.methods.length, 0);
    const supported = deps();
    const bodyWithoutMetric = { ...CREATE, schema_json: schema(type, false) };
    assert.equal((await createTemplate(request(bodyWithoutMetric), "true", supported.dependencies)).status, 200, type);
  }
});

test("mutation endpoints validate exact contracts, idempotency, and state actions", async () => {
  const { calls, dependencies } = deps();
  assert.equal((await updateTemplate(request({ draft_version_id: DRAFT, expected_version: 2,
    display_name: "Daily Work", description: null, default_frequency: "DAILY", schema_json: schema(),
    idempotency_key: KEY }), TEMPLATE, "true", dependencies)).status, 200);
  assert.equal(calls.methods[0][0], "update");
  assert.equal((await templateAction(request({ expected_version: 2, idempotency_key: KEY }), TEMPLATE,
    "clone", "true", dependencies)).status, 200);
  assert.equal((await templateAction(request({ draft_version_id: DRAFT, expected_version: 2, idempotency_key: KEY }),
    TEMPLATE, "publish", "true", dependencies)).status, 200);
  assert.equal((await templateAction(request({ expected_version: 2, idempotency_key: KEY }), TEMPLATE,
    "archive", "true", dependencies)).status, 200);
  assert.deepEqual(calls.methods.map(([method]) => method), ["update", "clone", "publish", "archive"]);
  const badKey = deps();
  assert.equal((await createTemplate(request(CREATE, "POST", { "idempotency-key": "66666666-6666-4666-8666-666666666666" }),
    "true", badKey.dependencies)).status, 400);
  assert.equal(badKey.calls.methods.length, 0);
});

test("template detail and preview reject malformed IDs and return selected immutable version", async () => {
  const version = { version_id: DRAFT, version_no: 2, status: "DRAFT", requires_review: false,
    schema_json: schema(), metric_contract_json: buildWorkReportMetricContract(schema()),
    schema_checksum: "a".repeat(64), published_at: null };
  const result = { ok: true, data: { template_id: TEMPLATE, template_code: "DAILY_WORK", display_name: "Daily Work",
    description: null, default_frequency: "DAILY", status: "DRAFT", current_published_version_id: null,
    version: 2, versions: [version] } };
  const { dependencies } = deps(result);
  assert.equal((await getTemplate(TEMPLATE, "true", dependencies)).status, 200);
  assert.equal((await previewTemplate(TEMPLATE, DRAFT, "true", dependencies)).status, 200);
  assert.equal((await previewTemplate("bad", DRAFT, "true", dependencies)).status, 400);
  assert.equal((await previewTemplate(TEMPLATE, "77777777-7777-4777-8777-777777777777", "true", dependencies)).status, 404);
});
