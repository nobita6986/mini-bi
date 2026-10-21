import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  WORK_REPORT_FIELD_TYPES,
  WORK_REPORT_SCHEMA_VERSION,
  type WorkReportField,
  type WorkReportOption,
  type WorkReportTemplateSchema,
  type WorkReportValidationIssue,
  type WorkReportValidationResult,
} from "./contracts.ts";

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const PATTERNS = {
  none: null,
  code: /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  phone: /^\+?[0-9][0-9 .()-]{5,30}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
} as const;

type SubmissionContext = {
  period_start_date?: string;
  period_end_date?: string;
  today_date?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: WorkReportValidationIssue[], code: string, path: string): void {
  issues.push({ code, path });
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 256;
}

function validDescription(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 2000);
}

function validSortOrder(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validOptions(value: unknown, path: string, issues: WorkReportValidationIssue[]): value is WorkReportOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    issue(issues, "WORK_REPORT_OPTIONS_INVALID", path);
    return false;
  }
  const keys = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(raw) || !exactKeys(raw, ["option_key", "label", "active", "sort_order"]) ||
        typeof raw.option_key !== "string" || !KEY.test(raw.option_key) ||
        !validLabel(raw.label) || typeof raw.active !== "boolean" || !validSortOrder(raw.sort_order)) {
      issue(issues, "WORK_REPORT_OPTION_INVALID", itemPath);
      continue;
    }
    if (keys.has(raw.option_key)) issue(issues, "WORK_REPORT_OPTION_KEY_DUPLICATE", `${itemPath}.option_key`);
    keys.add(raw.option_key);
  }
  return true;
}

function validateField(raw: unknown, sectionKey: string, path: string, issues: WorkReportValidationIssue[]): raw is WorkReportField {
  if (!isRecord(raw) || !exactKeys(raw, [
    "field_key", "section_key", "sort_order", "label", "description", "field_type",
    "required", "default_value", "validation", "options", "is_metric", "metric_spec",
    "is_dimension",
  ])) {
    issue(issues, "WORK_REPORT_FIELD_INVALID", path);
    return false;
  }
  if (typeof raw.field_key !== "string" || !KEY.test(raw.field_key)) issue(issues, "WORK_REPORT_FIELD_KEY_INVALID", `${path}.field_key`);
  if (raw.section_key !== sectionKey) issue(issues, "WORK_REPORT_SECTION_KEY_MISMATCH", `${path}.section_key`);
  if (!validSortOrder(raw.sort_order)) issue(issues, "WORK_REPORT_SORT_ORDER_INVALID", `${path}.sort_order`);
  if (!validLabel(raw.label)) issue(issues, "WORK_REPORT_LABEL_INVALID", `${path}.label`);
  if (!validDescription(raw.description)) issue(issues, "WORK_REPORT_DESCRIPTION_INVALID", `${path}.description`);
  if (typeof raw.field_type !== "string" || !(WORK_REPORT_FIELD_TYPES as readonly string[]).includes(raw.field_type)) {
    issue(issues, "WORK_REPORT_FIELD_TYPE_INVALID", `${path}.field_type`);
    return false;
  }
  if (typeof raw.required !== "boolean" || typeof raw.is_metric !== "boolean" || typeof raw.is_dimension !== "boolean") {
    issue(issues, "WORK_REPORT_FIELD_FLAG_INVALID", path);
  }
  if (!isRecord(raw.validation)) {
    issue(issues, "WORK_REPORT_FIELD_VALIDATION_INVALID", `${path}.validation`);
    return false;
  }

  const validation = raw.validation;
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const integer = (value: unknown) => Number.isInteger(value);
  const lengthRange = (max: number) =>
    integer(validation.min_length) && Number(validation.min_length) >= 0 &&
    integer(validation.max_length) && Number(validation.max_length) >= 1 &&
    Number(validation.max_length) <= max && Number(validation.min_length) <= Number(validation.max_length);

  if (raw.field_type === "text") {
    if (!exactKeys(validation, ["min_length", "max_length", "pattern_preset"]) || !lengthRange(500) ||
        typeof validation.pattern_preset !== "string" || !(validation.pattern_preset in PATTERNS)) {
      issue(issues, "WORK_REPORT_TEXT_RULE_INVALID", `${path}.validation`);
    }
  } else if (raw.field_type === "textarea") {
    if (!exactKeys(validation, ["min_length", "max_length"]) || !lengthRange(4000)) {
      issue(issues, "WORK_REPORT_TEXTAREA_RULE_INVALID", `${path}.validation`);
    }
  } else if (raw.field_type === "integer" || raw.field_type === "decimal") {
    const allowed = raw.field_type === "decimal"
      ? ["min_value", "max_value", "decimal_places", "allow_zero"]
      : ["min_value", "max_value", "allow_zero"];
    if (!exactKeys(validation, allowed) || !finite(validation.min_value) || !finite(validation.max_value) ||
        Number(validation.min_value) > Number(validation.max_value) || typeof validation.allow_zero !== "boolean" ||
        (raw.field_type === "integer" && (!integer(validation.min_value) || !integer(validation.max_value))) ||
        (raw.field_type === "decimal" && (!integer(validation.decimal_places) ||
          Number(validation.decimal_places) < 1 || Number(validation.decimal_places) > 4))) {
      issue(issues, "WORK_REPORT_NUMBER_RULE_INVALID", `${path}.validation`);
    }
  } else if (raw.field_type === "date") {
    if (!exactKeys(validation, ["min_date_rule"]) ||
        !["any", "within_period", "not_future"].includes(String(validation.min_date_rule))) {
      issue(issues, "WORK_REPORT_DATE_RULE_INVALID", `${path}.validation`);
    }
  } else if (raw.field_type === "boolean") {
    if (!exactKeys(validation, [])) issue(issues, "WORK_REPORT_BOOLEAN_RULE_INVALID", `${path}.validation`);
  } else {
    const allowed = raw.field_type === "multi_select" ? ["min_selected", "max_selected"] : [];
    if (!exactKeys(validation, allowed) ||
        (raw.field_type === "multi_select" &&
          (!integer(validation.min_selected) || !integer(validation.max_selected) ||
            Number(validation.min_selected) < 0 || Number(validation.max_selected) < 1 ||
            Number(validation.min_selected) > Number(validation.max_selected)))) {
      issue(issues, "WORK_REPORT_SELECT_RULE_INVALID", `${path}.validation`);
    }
  }

  const select = raw.field_type === "single_select" || raw.field_type === "multi_select";
  if (select) validOptions(raw.options, `${path}.options`, issues);
  else if (raw.options !== null) issue(issues, "WORK_REPORT_OPTIONS_NOT_ALLOWED", `${path}.options`);
  if (raw.is_metric !== (raw.metric_spec !== null)) issue(issues, "WORK_REPORT_METRIC_SPEC_MISMATCH", `${path}.metric_spec`);
  return true;
}

export function validateWorkReportSchema(input: unknown): WorkReportValidationResult<WorkReportTemplateSchema> {
  const issues: WorkReportValidationIssue[] = [];
  if (!isRecord(input) || !exactKeys(input, ["version", "sections"]) ||
      input.version !== WORK_REPORT_SCHEMA_VERSION || !Array.isArray(input.sections) || input.sections.length === 0) {
    return { ok: false, issues: [{ code: "WORK_REPORT_SCHEMA_INVALID", path: "$" }] };
  }
  const sectionKeys = new Set<string>();
  const fieldKeys = new Set<string>();
  for (const [sectionIndex, rawSection] of input.sections.entries()) {
    const path = `$.sections[${sectionIndex}]`;
    if (!isRecord(rawSection) || !exactKeys(rawSection, ["section_key", "label", "description", "sort_order", "fields"]) ||
        typeof rawSection.section_key !== "string" || !KEY.test(rawSection.section_key) ||
        !validLabel(rawSection.label) || !validDescription(rawSection.description) ||
        !validSortOrder(rawSection.sort_order) || !Array.isArray(rawSection.fields) || rawSection.fields.length === 0) {
      issue(issues, "WORK_REPORT_SECTION_INVALID", path);
      continue;
    }
    if (sectionKeys.has(rawSection.section_key)) issue(issues, "WORK_REPORT_SECTION_KEY_DUPLICATE", `${path}.section_key`);
    sectionKeys.add(rawSection.section_key);
    for (const [fieldIndex, rawField] of rawSection.fields.entries()) {
      const fieldPath = `${path}.fields[${fieldIndex}]`;
      validateField(rawField, rawSection.section_key, fieldPath, issues);
      if (isRecord(rawField) && typeof rawField.field_key === "string") {
        if (fieldKeys.has(rawField.field_key)) issue(issues, "WORK_REPORT_FIELD_KEY_DUPLICATE", `${fieldPath}.field_key`);
        fieldKeys.add(rawField.field_key);
      }
    }
  }
  return issues.length === 0
    ? { ok: true, value: input as WorkReportTemplateSchema }
    : { ok: false, issues };
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

function validateValue(field: WorkReportField, value: unknown, context: SubmissionContext): boolean {
  if (value === null || value === undefined || value === "") return !field.required;
  const rules = field.validation;
  if (field.field_type === "text" || field.field_type === "textarea") {
    if (typeof value !== "string" || value.length < Number(rules.min_length) || value.length > Number(rules.max_length)) return false;
    if (field.field_type === "text" && rules.pattern_preset && rules.pattern_preset !== "none") {
      return PATTERNS[rules.pattern_preset]?.test(value) === true;
    }
    return true;
  }
  if (field.field_type === "integer" || field.field_type === "decimal") {
    if (typeof value !== "number" || !Number.isFinite(value) ||
        (field.field_type === "integer" && !Number.isInteger(value)) ||
        value < Number(rules.min_value) || value > Number(rules.max_value) ||
        (rules.allow_zero === false && value === 0)) return false;
    return field.field_type !== "decimal" || decimalPlaces(value) <= Number(rules.decimal_places);
  }
  if (field.field_type === "date") {
    if (!isRealCalendarDate(value)) return false;
    if (rules.min_date_rule === "within_period") {
      return isRealCalendarDate(context.period_start_date) && isRealCalendarDate(context.period_end_date) &&
        value >= context.period_start_date! && value <= context.period_end_date!;
    }
    if (rules.min_date_rule === "not_future") {
      return isRealCalendarDate(context.today_date) && value <= context.today_date!;
    }
    return true;
  }
  if (field.field_type === "boolean") return typeof value === "boolean";
  const optionKeys = new Set((field.options ?? []).filter((option) => option.active).map((option) => option.option_key));
  if (field.field_type === "single_select") return typeof value === "string" && optionKeys.has(value);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string") || new Set(value).size !== value.length) return false;
  return value.length >= Number(rules.min_selected) && value.length <= Number(rules.max_selected) &&
    value.every((item) => optionKeys.has(item));
}

export function validateWorkReportSubmission(
  schema: WorkReportTemplateSchema,
  payload: unknown,
  context: SubmissionContext = {},
): WorkReportValidationResult<Record<string, unknown>> {
  const schemaResult = validateWorkReportSchema(schema);
  if (!schemaResult.ok) return schemaResult;
  if (!isRecord(payload)) return { ok: false, issues: [{ code: "WORK_REPORT_PAYLOAD_INVALID", path: "$" }] };
  const issues: WorkReportValidationIssue[] = [];
  const fields = schema.sections.flatMap((section) => section.fields);
  const keys = new Set(fields.map((field) => field.field_key));
  for (const key of Object.keys(payload)) {
    if (!keys.has(key)) issue(issues, "WORK_REPORT_PAYLOAD_FIELD_UNKNOWN", `$.${key}`);
  }
  for (const field of fields) {
    if (!validateValue(field, payload[field.field_key], context)) {
      issue(issues, "WORK_REPORT_PAYLOAD_VALUE_INVALID", `$.${field.field_key}`);
    }
  }
  return issues.length === 0 ? { ok: true, value: payload } : { ok: false, issues };
}
