export const WORK_REPORT_SCHEMA_VERSION = "work-report-schema/1.0" as const;
export const WORK_REPORT_METRIC_CONTRACT_VERSION = "work-report-metrics/1.0" as const;

export const WORK_REPORT_FIELD_TYPES = [
  "text",
  "textarea",
  "integer",
  "decimal",
  "date",
  "boolean",
  "single_select",
  "multi_select",
] as const;

export const WORK_REPORT_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "ONCE"] as const;
export const WORK_REPORT_ASSIGNMENT_TARGET_KINDS = ["USER", "TEAM", "USER_SET", "GROUP"] as const;
export const WORK_REPORT_AGGREGATIONS = [
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT_VALID",
  "TRUE_COUNT",
  "TRUE_RATE",
  "COUNT_BY_OPTION",
] as const;

export type WorkReportFieldType = (typeof WORK_REPORT_FIELD_TYPES)[number];
export type WorkReportFrequency = (typeof WORK_REPORT_FREQUENCIES)[number];
export type WorkReportAssignmentTargetKind = (typeof WORK_REPORT_ASSIGNMENT_TARGET_KINDS)[number];
export type WorkReportAggregation = (typeof WORK_REPORT_AGGREGATIONS)[number];
export type WorkReportNullPolicy = "EXCLUDE_FROM_AVG" | "INCLUDE_AS_ZERO";
export type WorkReportZeroPolicy = "INCLUDE_AS_ZERO" | "EXCLUDE";
export type WorkReportPatternPreset = "none" | "code" | "phone" | "email";
export type WorkReportMinDateRule = "any" | "within_period" | "not_future";

export type WorkReportOption = {
  option_key: string;
  label: string;
  active: boolean;
  sort_order: number;
};

export type WorkReportMetricSpec = {
  metric_key: string;
  unit: string;
  aggregations: readonly WorkReportAggregation[];
  null_policy: WorkReportNullPolicy;
  zero_policy: WorkReportZeroPolicy;
  compatible_group: string;
};

export type WorkReportFieldValidation = {
  min_length?: number;
  max_length?: number;
  pattern_preset?: WorkReportPatternPreset;
  min_value?: number;
  max_value?: number;
  allow_zero?: boolean;
  decimal_places?: number;
  min_date_rule?: WorkReportMinDateRule;
  min_selected?: number;
  max_selected?: number;
};

export type WorkReportField = {
  field_key: string;
  section_key: string;
  sort_order: number;
  label: string;
  description: string | null;
  field_type: WorkReportFieldType;
  required: boolean;
  default_value: unknown;
  validation: WorkReportFieldValidation;
  options: readonly WorkReportOption[] | null;
  is_metric: boolean;
  metric_spec: WorkReportMetricSpec | null;
  is_dimension: boolean;
};

export type WorkReportSection = {
  section_key: string;
  label: string;
  description: string | null;
  sort_order: number;
  fields: readonly WorkReportField[];
};

export type WorkReportTemplateSchema = {
  version: typeof WORK_REPORT_SCHEMA_VERSION;
  sections: readonly WorkReportSection[];
};

export type WorkReportMetricDefinition = WorkReportMetricSpec & {
  field_key: string;
  field_type: WorkReportFieldType;
};

export type WorkReportMetricContract = {
  version: typeof WORK_REPORT_METRIC_CONTRACT_VERSION;
  metrics: readonly WorkReportMetricDefinition[];
};

export type WorkReportValidationIssue = {
  code: string;
  path: string;
};

export type WorkReportValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly WorkReportValidationIssue[] };

export type WorkReportPeriod = {
  period_type: WorkReportFrequency;
  period_key: string;
  period_start_date: string;
  period_end_date: string;
};

export const RECRUITMENT_DAILY_TEMPLATE_SCHEMA: WorkReportTemplateSchema = {
  version: WORK_REPORT_SCHEMA_VERSION,
  sections: [
    {
      section_key: "daily_kpi",
      label: "Kết quả tuyển dụng trong ngày",
      description: null,
      sort_order: 10,
      fields: [
        recruitmentIntegerField("calls_made", "Số cuộc gọi", "cuộc", 10),
        recruitmentIntegerField("interested_candidates", "Ứng viên quan tâm", "người", 20),
        recruitmentIntegerField("workers_started", "NLĐ đi làm", "người", 30),
        {
          field_key: "notes",
          section_key: "daily_kpi",
          sort_order: 40,
          label: "Nội dung công việc",
          description: null,
          field_type: "textarea",
          required: false,
          default_value: null,
          validation: { min_length: 0, max_length: 4000 },
          options: null,
          is_metric: false,
          metric_spec: null,
          is_dimension: false,
        },
      ],
    },
  ],
};

function recruitmentIntegerField(
  fieldKey: "calls_made" | "interested_candidates" | "workers_started",
  label: string,
  unit: string,
  sortOrder: number,
): WorkReportField {
  return {
    field_key: fieldKey,
    section_key: "daily_kpi",
    sort_order: sortOrder,
    label,
    description: null,
    field_type: "integer",
    required: true,
    default_value: 0,
    validation: { min_value: 0, max_value: 10000, allow_zero: true },
    options: null,
    is_metric: true,
    metric_spec: {
      metric_key: fieldKey,
      unit,
      aggregations: fieldKey === "calls_made"
        ? ["SUM", "AVG", "COUNT_VALID"]
        : ["SUM", "AVG"],
      null_policy: "EXCLUDE_FROM_AVG",
      zero_policy: "INCLUDE_AS_ZERO",
      compatible_group: `recruitment_daily_${fieldKey}_v1`,
    },
    is_dimension: false,
  };
}
