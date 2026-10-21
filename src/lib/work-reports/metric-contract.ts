import {
  WORK_REPORT_AGGREGATIONS,
  WORK_REPORT_METRIC_CONTRACT_VERSION,
  type WorkReportAggregation,
  type WorkReportField,
  type WorkReportMetricContract,
  type WorkReportMetricDefinition,
  type WorkReportTemplateSchema,
  type WorkReportValidationIssue,
  type WorkReportValidationResult,
} from "./contracts.ts";
import { validateWorkReportSchema } from "./schema-validator.ts";

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const ALLOWED_BY_TYPE: Readonly<Record<string, readonly WorkReportAggregation[]>> = {
  text: ["COUNT_VALID"],
  textarea: ["COUNT_VALID"],
  integer: ["SUM", "AVG", "MIN", "MAX", "COUNT_VALID"],
  decimal: ["SUM", "AVG", "MIN", "MAX", "COUNT_VALID"],
  boolean: ["TRUE_COUNT", "TRUE_RATE", "COUNT_VALID"],
  single_select: ["COUNT_BY_OPTION", "COUNT_VALID"],
  multi_select: ["COUNT_BY_OPTION", "COUNT_VALID"],
  date: ["COUNT_VALID"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function buildWorkReportMetricContract(schema: WorkReportTemplateSchema): WorkReportMetricContract {
  const metrics = schema.sections.flatMap((section) => section.fields)
    .filter((field) => field.is_metric && field.metric_spec !== null)
    .map((field): WorkReportMetricDefinition => ({
      field_key: field.field_key,
      field_type: field.field_type,
      ...field.metric_spec!,
    }));
  return { version: WORK_REPORT_METRIC_CONTRACT_VERSION, metrics };
}

function metricMatchesField(metric: WorkReportMetricDefinition, field: WorkReportField): boolean {
  const spec = field.metric_spec;
  if (!field.is_metric || spec === null || metric.field_key !== field.field_key ||
      metric.field_type !== field.field_type || metric.metric_key !== spec.metric_key ||
      metric.unit !== spec.unit || metric.null_policy !== spec.null_policy ||
      metric.zero_policy !== spec.zero_policy || metric.compatible_group !== spec.compatible_group ||
      !sameValues(metric.aggregations, spec.aggregations)) return false;
  const allowed = ALLOWED_BY_TYPE[field.field_type] ?? [];
  return metric.aggregations.length > 0 && metric.aggregations.every((value) => allowed.includes(value));
}

export function validateWorkReportMetricContract(
  schema: WorkReportTemplateSchema,
  input: unknown,
): WorkReportValidationResult<WorkReportMetricContract> {
  const schemaResult = validateWorkReportSchema(schema);
  if (!schemaResult.ok) return schemaResult;
  if (!isRecord(input) || input.version !== WORK_REPORT_METRIC_CONTRACT_VERSION || !Array.isArray(input.metrics) ||
      Object.keys(input).some((key) => !["version", "metrics"].includes(key))) {
    return { ok: false, issues: [{ code: "WORK_REPORT_METRIC_CONTRACT_INVALID", path: "$" }] };
  }
  const issues: WorkReportValidationIssue[] = [];
  const fields = new Map(schema.sections.flatMap((section) => section.fields).map((field) => [field.field_key, field]));
  const metricKeys = new Set<string>();
  const metricFields = new Set<string>();
  for (const [index, raw] of input.metrics.entries()) {
    const path = `$.metrics[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).some((key) => ![
      "field_key", "field_type", "metric_key", "unit", "aggregations", "null_policy", "zero_policy", "compatible_group",
    ].includes(key)) || typeof raw.field_key !== "string" || typeof raw.field_type !== "string" ||
        typeof raw.metric_key !== "string" || !KEY.test(raw.metric_key) || typeof raw.unit !== "string" ||
        raw.unit.trim() === "" || raw.unit.length > 64 || !Array.isArray(raw.aggregations) ||
        raw.aggregations.some((value) => !(WORK_REPORT_AGGREGATIONS as readonly unknown[]).includes(value)) ||
        !["EXCLUDE_FROM_AVG", "INCLUDE_AS_ZERO"].includes(String(raw.null_policy)) ||
        !["INCLUDE_AS_ZERO", "EXCLUDE"].includes(String(raw.zero_policy)) ||
        typeof raw.compatible_group !== "string" || !KEY.test(raw.compatible_group)) {
      issues.push({ code: "WORK_REPORT_METRIC_INVALID", path });
      continue;
    }
    const metric = raw as unknown as WorkReportMetricDefinition;
    const field = fields.get(metric.field_key);
    if (!field || !metricMatchesField(metric, field)) issues.push({ code: "WORK_REPORT_METRIC_FIELD_MISMATCH", path });
    if (metricKeys.has(metric.metric_key)) issues.push({ code: "WORK_REPORT_METRIC_KEY_DUPLICATE", path: `${path}.metric_key` });
    if (metricFields.has(metric.field_key)) issues.push({ code: "WORK_REPORT_METRIC_FIELD_DUPLICATE", path: `${path}.field_key` });
    metricKeys.add(metric.metric_key);
    metricFields.add(metric.field_key);
  }
  for (const field of fields.values()) {
    if (field.is_metric && !metricFields.has(field.field_key)) {
      issues.push({ code: "WORK_REPORT_METRIC_MISSING", path: `$.${field.field_key}` });
    }
  }
  return issues.length === 0
    ? { ok: true, value: input as unknown as WorkReportMetricContract }
    : { ok: false, issues };
}

export function areMetricDefinitionsCompatible(
  previous: WorkReportMetricDefinition,
  next: WorkReportMetricDefinition,
): boolean {
  return previous.metric_key === next.metric_key && previous.field_type === next.field_type &&
    previous.unit === next.unit && previous.compatible_group === next.compatible_group;
}
