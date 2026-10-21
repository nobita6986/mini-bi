import {
  workReportTemplateManagePredicate,
  type NavActorProjection,
} from "../navigation/registry-capability.ts";

import {
  WORK_REPORT_FIELD_TYPES,
  RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
  type WorkReportField,
  type WorkReportFieldType,
  type WorkReportTemplateSchema,
} from "./contracts.ts";

const METRIC_TYPES = new Set<WorkReportFieldType>(["integer", "decimal", "boolean", "single_select", "multi_select"]);

export function createWorkReportSection(index: number) {
  const suffix = Math.max(1, Math.floor(index));
  const sectionKey = `section_${suffix}`;
  return { section_key: sectionKey, label: `Nhóm ${suffix}`, description: null,
    sort_order: suffix * 10, fields: [createWorkReportField("text", sectionKey, 1)] };
}

export function createWorkReportField(fieldType: WorkReportFieldType, sectionKey: string, index: number): WorkReportField {
  const sectionNumber = sectionKey.match(/\d+/)?.[0] ?? "1";
  const fieldKey = `field_s${sectionNumber}_f${Math.max(1, Math.floor(index))}`;
  let validation: WorkReportField["validation"] = {};
  let options: WorkReportField["options"] = null;
  if (fieldType === "text") validation = { min_length: 0, max_length: 500, pattern_preset: "none" };
  if (fieldType === "textarea") validation = { min_length: 0, max_length: 4000 };
  if (fieldType === "integer") validation = { min_value: 0, max_value: 1000000, allow_zero: true };
  if (fieldType === "decimal") validation = { min_value: 0, max_value: 1000000, decimal_places: 2, allow_zero: true };
  if (fieldType === "date") validation = { min_date_rule: "any" };
  if (fieldType === "single_select" || fieldType === "multi_select") {
    validation = fieldType === "multi_select" ? { min_selected: 0, max_selected: 50 } : {};
    options = [{ option_key: "option_1", label: "Lựa chọn 1", active: true, sort_order: 10 }];
  }
  return { field_key: fieldKey, section_key: sectionKey, sort_order: index * 10, label: `Trường ${index}`,
    description: null, field_type: fieldType, required: false, default_value: null, validation,
    options, is_metric: false, metric_spec: null, is_dimension: false };
}

export function setWorkReportFieldMetric(field: WorkReportField, enabled: boolean): WorkReportField {
  if (!enabled) return { ...field, is_metric: false, metric_spec: null };
  if (!METRIC_TYPES.has(field.field_type)) return field;
  const aggregations = field.field_type === "integer" || field.field_type === "decimal"
    ? ["SUM", "AVG", "COUNT_VALID"] as const
    : field.field_type === "boolean" ? ["TRUE_COUNT", "COUNT_VALID"] as const
      : ["COUNT_BY_OPTION", "COUNT_VALID"] as const;
  return { ...field, is_metric: true, metric_spec: {
    metric_key: field.field_key, unit: "lần", aggregations,
    null_policy: "EXCLUDE_FROM_AVG", zero_policy: "INCLUDE_AS_ZERO",
    compatible_group: `${field.field_key}_v1`,
  } };
}

export function createWorkReportSchema(): WorkReportTemplateSchema {
  return structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
}

export function isWorkReportMetricFieldType(value: WorkReportFieldType): boolean {
  return METRIC_TYPES.has(value);
}

export function canManageWorkReportTemplates(actor: NavActorProjection | null): boolean {
  return actor !== null && workReportTemplateManagePredicate(actor);
}

export const workReportFieldTypeLabels: Readonly<Record<WorkReportFieldType, string>> = {
  text: "Văn bản ngắn", textarea: "Văn bản dài", integer: "Số nguyên", decimal: "Số thập phân",
  date: "Ngày", boolean: "Có / Không", single_select: "Chọn một", multi_select: "Chọn nhiều",
};

export const allWorkReportFieldTypes = WORK_REPORT_FIELD_TYPES;
