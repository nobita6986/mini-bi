import assert from "node:assert/strict";
import test from "node:test";

import {
  RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
  WORK_REPORT_FIELD_TYPES,
  WORK_REPORT_METRIC_CONTRACT_VERSION,
  WORK_REPORT_SCHEMA_VERSION,
} from "./contracts.ts";
import {
  areMetricDefinitionsCompatible,
  buildWorkReportMetricContract,
  validateWorkReportMetricContract,
} from "./metric-contract.ts";
import { workReportDueAt, workReportPeriodForDate } from "./period-utils.ts";
import { validateWorkReportSchema, validateWorkReportSubmission } from "./schema-validator.ts";

test("F1 contract contains exactly the eight locked core field types", () => {
  assert.deepEqual(WORK_REPORT_FIELD_TYPES, [
    "text", "textarea", "integer", "decimal", "date", "boolean", "single_select", "multi_select",
  ]);
  assert.equal(WORK_REPORT_FIELD_TYPES.includes("project_ref"), false);
});

test("the locked recruitment daily template and metric contract validate", () => {
  assert.equal(RECRUITMENT_DAILY_TEMPLATE_SCHEMA.version, WORK_REPORT_SCHEMA_VERSION);
  assert.deepEqual(
    RECRUITMENT_DAILY_TEMPLATE_SCHEMA.sections.flatMap((section) => section.fields.map((field) => field.field_key)),
    ["calls_made", "interested_candidates", "workers_started", "notes"],
  );
  assert.equal(validateWorkReportSchema(RECRUITMENT_DAILY_TEMPLATE_SCHEMA).ok, true);
  const contract = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  assert.equal(contract.version, WORK_REPORT_METRIC_CONTRACT_VERSION);
  assert.deepEqual(contract.metrics.map((metric) => metric.metric_key), [
    "calls_made", "interested_candidates", "workers_started",
  ]);
  assert.equal(validateWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA, contract).ok, true);
});

test("submission validation rejects unknown fields and invalid values", () => {
  assert.equal(validateWorkReportSubmission(RECRUITMENT_DAILY_TEMPLATE_SCHEMA, {
    calls_made: 10,
    interested_candidates: 3,
    workers_started: 1,
    notes: "Đã liên hệ ứng viên.",
  }).ok, true);
  const invalid = validateWorkReportSubmission(RECRUITMENT_DAILY_TEMPLATE_SCHEMA, {
    calls_made: -1,
    interested_candidates: 2.5,
    workers_started: 1,
    notes: null,
    project_id: "must-not-exist",
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((item) => item.path === "$.project_id"));
  assert.ok(invalid.issues.some((item) => item.path === "$.calls_made"));
  assert.ok(invalid.issues.some((item) => item.path === "$.interested_candidates"));
});

test("technical fixture covers decimal, date, boolean and select rules", () => {
  const schema = {
    version: WORK_REPORT_SCHEMA_VERSION,
    sections: [{
      section_key: "technical",
      label: "Technical fixture",
      description: null,
      sort_order: 10,
      fields: [
        { field_key: "short_code", section_key: "technical", sort_order: 10, label: "Code", description: null,
          field_type: "text", required: true, default_value: null,
          validation: { min_length: 1, max_length: 20, pattern_preset: "code" }, options: null,
          is_metric: false, metric_spec: null, is_dimension: false },
        { field_key: "score", section_key: "technical", sort_order: 20, label: "Score", description: null,
          field_type: "decimal", required: true, default_value: 0,
          validation: { min_value: 0, max_value: 100, decimal_places: 2, allow_zero: true }, options: null,
          is_metric: false, metric_spec: null, is_dimension: false },
        { field_key: "event_date", section_key: "technical", sort_order: 30, label: "Date", description: null,
          field_type: "date", required: true, default_value: null, validation: { min_date_rule: "within_period" },
          options: null, is_metric: false, metric_spec: null, is_dimension: true },
        { field_key: "confirmed", section_key: "technical", sort_order: 40, label: "Confirmed", description: null,
          field_type: "boolean", required: true, default_value: false, validation: {}, options: null,
          is_metric: false, metric_spec: null, is_dimension: true },
        { field_key: "channel", section_key: "technical", sort_order: 50, label: "Channel", description: null,
          field_type: "single_select", required: true, default_value: null, validation: {},
          options: [{ option_key: "phone", label: "Phone", active: true, sort_order: 10 }],
          is_metric: false, metric_spec: null, is_dimension: true },
        { field_key: "tags", section_key: "technical", sort_order: 60, label: "Tags", description: null,
          field_type: "multi_select", required: false, default_value: [], validation: { min_selected: 0, max_selected: 2 },
          options: [
            { option_key: "new", label: "New", active: true, sort_order: 10 },
            { option_key: "follow_up", label: "Follow up", active: true, sort_order: 20 },
          ], is_metric: false, metric_spec: null, is_dimension: true },
      ],
    }],
  };
  assert.equal(validateWorkReportSchema(schema).ok, true);
  assert.equal(validateWorkReportSubmission(schema, {
    short_code: "ABC-01", score: 99.25, event_date: "2026-10-21", confirmed: false,
    channel: "phone", tags: ["new", "follow_up"],
  }, { period_start_date: "2026-10-20", period_end_date: "2026-10-26" }).ok, true);
  assert.equal(validateWorkReportSubmission(schema, {
    short_code: "ABC 01", score: 99.251, event_date: "2026-10-27", confirmed: "false",
    channel: "missing", tags: ["new", "new"],
  }, { period_start_date: "2026-10-20", period_end_date: "2026-10-26" }).ok, false);
});

test("period utilities honor ISO week and Vietnam day boundary", () => {
  assert.deepEqual(workReportPeriodForDate("DAILY", "2026-10-21"), {
    period_type: "DAILY", period_key: "2026-10-21",
    period_start_date: "2026-10-21", period_end_date: "2026-10-21",
  });
  assert.deepEqual(workReportPeriodForDate("WEEKLY", "2026-01-01"), {
    period_type: "WEEKLY", period_key: "2026-W01",
    period_start_date: "2025-12-29", period_end_date: "2026-01-04",
  });
  assert.equal(workReportDueAt("2026-10-21", 0, "00:00:00"), "2026-10-20T17:00:00.000Z");
});

test("metric compatibility requires stable type, unit and compatible group", () => {
  const metric = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA).metrics[0];
  assert.equal(areMetricDefinitionsCompatible(metric, { ...metric, unit: "cuộc" }), true);
  assert.equal(areMetricDefinitionsCompatible(metric, { ...metric, unit: "giờ" }), false);
});
