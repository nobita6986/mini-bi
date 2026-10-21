import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkReportMetricContract } from "./metric-contract.ts";
import { createWorkReportTemplateRepository } from "./template-repository.ts";

const ACTOR = { auth_subject: "11111111-1111-4111-8111-111111111111", app_user_id: "22222222-2222-4222-8222-222222222222" };
const TEMPLATE = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";
const SCHEMA = { version: "work-report-schema/1.0", sections: [{ section_key: "section_one", label: "Section",
  description: null, sort_order: 10, fields: [{ field_key: "calls_made", section_key: "section_one", sort_order: 10,
    label: "Calls", description: null, field_type: "integer", required: false, default_value: null,
    validation: { min_value: 0, max_value: 100, allow_zero: true }, options: null, is_metric: true,
    metric_spec: { metric_key: "calls_made", unit: "calls", aggregations: ["SUM"],
      null_policy: "EXCLUDE_FROM_AVG", zero_policy: "INCLUDE_AS_ZERO", compatible_group: "calls_made_v1" },
    is_dimension: false }] }] };
const METRICS = buildWorkReportMetricContract(SCHEMA);
const LIST_ITEM = { template_id: TEMPLATE, template_code: "DAILY_WORK", display_name: "Daily Work",
  description: null, default_frequency: "DAILY", status: "ACTIVE", current_published_version_id: VERSION,
  draft_version_id: null, version: 3, updated_at: "2026-10-21T00:00:00Z" };
const VERSION_ITEM = { version_id: VERSION, version_no: 1, status: "PUBLISHED", requires_review: false,
  schema_json: SCHEMA, metric_contract_json: METRICS, schema_checksum: "a".repeat(64), published_at: "2026-10-21T00:00:00Z" };
const MUTATION = { template_id: TEMPLATE, draft_version_id: VERSION, version: 2 };

test("repository projects list/detail and passes server actor to expected RPCs", async () => {
  const calls = [];
  const responses = {
    work_report_list_templates: { items: [LIST_ITEM] },
    work_report_get_template: { ...LIST_ITEM, versions: [VERSION_ITEM] },
    work_report_create_template: MUTATION, work_report_update_template_draft: MUTATION,
    work_report_clone_template_draft: MUTATION, work_report_publish_template: MUTATION,
    work_report_archive_template: { template_id: TEMPLATE, status: "ARCHIVED", version: 4 },
  };
  const repo = createWorkReportTemplateRepository(async (name, args) => {
    calls.push([name, args]); return { data: responses[name], error: null };
  });
  assert.deepEqual((await repo.list(ACTOR)).data, [LIST_ITEM]);
  assert.equal((await repo.get({ ...ACTOR, template_id: TEMPLATE })).data.versions[0].version_id, VERSION);
  await repo.create({ ...ACTOR, template_code: "DAILY_WORK", display_name: "Daily Work", description: null,
    default_frequency: "DAILY", schema_json: SCHEMA, metric_contract_json: METRICS, idempotency_key: KEY });
  await repo.update({ ...ACTOR, template_id: TEMPLATE, draft_version_id: VERSION, expected_version: 1,
    display_name: "Daily Work", description: null, default_frequency: "DAILY", schema_json: SCHEMA,
    metric_contract_json: METRICS, idempotency_key: KEY });
  await repo.clone({ ...ACTOR, template_id: TEMPLATE, expected_version: 1, idempotency_key: KEY });
  await repo.publish({ ...ACTOR, template_id: TEMPLATE, draft_version_id: VERSION, expected_version: 1, idempotency_key: KEY });
  await repo.archive({ ...ACTOR, template_id: TEMPLATE, expected_version: 1, idempotency_key: KEY });
  assert.deepEqual(calls.map(([name]) => name), Object.keys(responses));
  assert.ok(calls.every(([, args]) => args.p_auth_subject === ACTOR.auth_subject && args.p_app_user_id === ACTOR.app_user_id));
  assert.equal(calls[3][1].p_draft_version_id, VERSION);
});

test("repository fails closed on malformed schema and maps database denial", async () => {
  const malformed = createWorkReportTemplateRepository(async () => ({ data: {
    ...LIST_ITEM, versions: [{ ...VERSION_ITEM, schema_json: { version: "bad", sections: [] } }],
  }, error: null }));
  assert.deepEqual(await malformed.get({ ...ACTOR, template_id: TEMPLATE }), { ok: false, kind: "unavailable" });
  const denied = createWorkReportTemplateRepository(async () => ({ data: null, error: { code: "42501" } }));
  assert.deepEqual(await denied.list(ACTOR), { ok: false, kind: "denied" });
});
