import { P2_W04A_CUTOVER_DATE } from "../../reporting/p2-w04a-cutover.ts";

import {
  N8N_BOD_READONLY_PRINCIPAL,
  N8N_BOD_READONLY_SCOPE,
} from "./auth.ts";

export const N8N_BOD_CATALOG_VERSION = "n8n-bod-bi-catalog/1.0" as const;
export const N8N_BOD_BUSINESS_TIMEZONE = "Asia/Ho_Chi_Minh" as const;

export type N8nDomainKey =
  | "recruitment"
  | "workforce"
  | "workers"
  | "attendance"
  | "vendor_finance"
  | "data_quality"
  | "catalogs"
  | "work_reports";

export type N8nQueryMode = "aggregate" | "detail" | "both";

export type N8nFilterOperator =
  | "eq"
  | "neq"
  | "in"
  | "gte"
  | "lte"
  | "between"
  | "contains"
  | "is_null";

export type N8nSensitivityClass =
  | "public_business"
  | "pii_national_id"
  | "pii_phone"
  | "pii_personal"
  | "financial_account"
  | "gps_location"
  | "free_text";

export type N8nFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "datetime"
  | "json";

export type N8nFieldSpec = {
  name: string;
  type: N8nFieldType;
  description: string;
  selectable: boolean;
  filterable: boolean;
  sortable: boolean;
  sensitive: boolean;
  sensitivity_class: N8nSensitivityClass;
};

export type N8nMeasureSpec = {
  name: string;
  type: "integer" | "number";
  label: string;
  formula: string;
  description: string;
  business_limits: string;
};

export type N8nDimensionSpec = {
  name: string;
  label: string;
  description: string;
  catalog_dataset: string | null;
};

export type N8nFilterSpec = {
  field: string;
  type: N8nFieldType;
  allowed_operators: readonly N8nFilterOperator[];
  required?: boolean;
  description: string;
};

export type N8nRelationSpec = {
  target_dataset: string;
  local_field: string;
  target_field: string;
  cardinality: "many_to_one" | "one_to_many" | "one_to_one";
  description: string;
};

export type N8nDatasetTimeSemantics = {
  timezone: typeof N8N_BOD_BUSINESS_TIMEZONE;
  business_date_field: string | null;
  supports_date_range: boolean;
  supports_as_of_date: boolean;
  cutoff_date: string | null;
  description: string;
};

export type N8nDatasetPaginationSpec = {
  strategy: "cursor" | "page_cursor" | "keyset_cursor" | "none";
  default_page_size: number;
  max_page_size: number;
};

export type N8nDatasetSpec = {
  dataset: string;
  domain: N8nDomainKey;
  title: string;
  description: string;
  grain: string;
  canonical_source: {
    name: string;
    kind: "rpc" | "read_model";
    underlying_objects: readonly string[];
    subledger_grain?: string | null;
  };
  supported_modes: readonly N8nQueryMode[];
  default_mode: N8nQueryMode;
  time_semantics: N8nDatasetTimeSemantics;
  fields: readonly N8nFieldSpec[];
  measures: readonly N8nMeasureSpec[];
  dimensions: readonly N8nDimensionSpec[];
  filters: readonly N8nFilterSpec[];
  allowed_relations: readonly N8nRelationSpec[];
  pagination: N8nDatasetPaginationSpec;
  business_rules: readonly string[];
};

export type N8nPendingDatasetSpec = {
  dataset: string;
  domain: N8nDomainKey;
  title: string;
  status: "PENDING_T1A_CONTRACT";
  reason: string;
  planned_capabilities: readonly string[];
};

export type N8nBodCatalog = {
  catalog_version: typeof N8N_BOD_CATALOG_VERSION;
  generated_at: string;
  principal: typeof N8N_BOD_READONLY_PRINCIPAL;
  scope: typeof N8N_BOD_READONLY_SCOPE;
  business_timezone: typeof N8N_BOD_BUSINESS_TIMEZONE;
  business_date: string;
  query_contract: {
    endpoint: "/api/integrations/n8n/v1/query";
    method: "POST";
    supported_operators: readonly N8nFilterOperator[];
    max_page_size_ceiling: number;
    max_request_body_bytes: number;
    max_response_bytes: number;
    query_timeout_ms: number;
    arbitrary_sql_allowed: false;
    client_authority_fields_allowed: false;
    sensitive_field_policy: string;
    media_policy: string;
    multi_query_guidance: readonly string[];
  };
  domains: ReadonlyArray<{
    domain: N8nDomainKey;
    title: string;
    status: "ACTIVE" | "PENDING_T1A_CONTRACT";
    description: string;
  }>;
  datasets: readonly N8nDatasetSpec[];
  pending_datasets: readonly N8nPendingDatasetSpec[];
};

function field(
  name: string,
  type: N8nFieldType,
  description: string,
  options: {
    selectable?: boolean;
    filterable?: boolean;
    sortable?: boolean;
    sensitive?: boolean;
    sensitivity_class?: N8nSensitivityClass;
  } = {},
): N8nFieldSpec {
  const sensitive = options.sensitive ?? false;
  return {
    name,
    type,
    description,
    selectable: options.selectable ?? true,
    filterable: options.filterable ?? false,
    sortable: options.sortable ?? false,
    sensitive,
    sensitivity_class:
      options.sensitivity_class ??
      (sensitive ? "pii_personal" : "public_business"),
  };
}

export function currentHoChiMinhBusinessDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: N8N_BOD_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value ?? "2026";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

const DATASETS: readonly N8nDatasetSpec[] = Object.freeze([
  // =========================================================================
  // 1. RECRUITMENT DOMAIN (Tuyển dụng)
  // =========================================================================
  {
    dataset: "recruitment_cutover_summary",
    domain: "recruitment",
    title: "Tổng hợp Tuyển dụng (Direct Entry Cutover & So sánh kỳ)",
    description:
      "Báo cáo tuyển dụng chuẩn từ nguồn Direct Entry (SUBMITTED episodes) có hỗ trợ lọc theo khoảng ngày first_work_date, chiều dự án/nhóm/người tuyển/loại lao động/trạng thái làm việc và đối sánh kỳ liền kề.",
    grain:
      "Summary KPI toàn phạm vi lọc + chuỗi thời gian theo ngày (report_date) hoặc breakdown theo dimension được chọn.",
    canonical_source: {
      name: "public.direct_entry_reporting_scoped_facts",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_reporting_scoped_facts",
        "public.direct_entry_reporting_facts_v01",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "report_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: P2_W04A_CUTOVER_DATE,
      description:
        `Ngày nghiệp vụ là first_work_date (report_date) theo múi giờ Asia/Ho_Chi_Minh. Dữ liệu Direct Entry có hiệu lực từ mốc cutover ${P2_W04A_CUTOVER_DATE}; dữ liệu legacy Google Sheets từ mốc này trở đi bị che (mask) để tuyệt đối không cộng trùng.`,
    },
    fields: [
      field("row_kind", "string", "Loại dòng trả về: by_date | by_project | by_recruiter | by_team | by_labor_type | by_employment_status", {
        filterable: true,
        sortable: true,
      }),
      field("report_date", "date", "Ngày báo cáo (YYYY-MM-DD, tương ứng first_work_date)", {
        filterable: true,
        sortable: true,
      }),
      field("dimension", "string", "Tên chiều phân tích khi row_kind là breakdown", {
        sortable: true,
      }),
      field("key", "string", "Mã định danh chuẩn hóa của mục phân tích", {
        filterable: true,
        sortable: true,
      }),
      field("label", "string", "Nhãn hiển thị của mục phân tích", {
        sortable: true,
      }),
      field("recruited_total", "integer", "Tổng số lao động tuyển dụng (SUBMITTED, không xóa/void)", {
        sortable: true,
      }),
      field("hrp_count", "integer", "Số lượng lao động thuộc kênh nội bộ HRP", {
        sortable: true,
      }),
      field("vendor_count", "integer", "Số lượng lao động thuộc kênh Vendor", {
        sortable: true,
      }),
      field("hrp_share", "number", "Tỷ trọng HRP = hrp_count / (hrp_count + vendor_count)", {
        sortable: true,
      }),
      field("vendor_share", "number", "Tỷ trọng Vendor = vendor_count / (hrp_count + vendor_count)", {
        sortable: true,
      }),
      field("share_of_total", "number", "Tỷ trọng của nhóm trên tổng số tuyển dụng trong kỳ", {
        sortable: true,
      }),
      field("previous_recruited_total", "integer", "Tổng tuyển dụng của kỳ liền trước cùng độ dài", {
        sortable: true,
      }),
      field("delta", "integer", "Chênh lệch tuyệt đối so với kỳ liền trước", {
        sortable: true,
      }),
      field("delta_pct", "number", "Tỷ lệ tăng/giảm so với kỳ liền trước (null nếu kỳ trước = 0)", {
        sortable: true,
      }),
    ],
    measures: [
      {
        name: "recruited_total",
        type: "integer",
        label: "Tổng tuyển dụng",
        formula: "SUM(recruited_total) trên tập bản ghi Direct Entry SUBMITTED hợp lệ",
        description: "Tổng số đợt làm việc đã nộp (SUBMITTED) không bị xóa/void trong phạm vi lọc.",
        business_limits:
          "Chỉ tính từ nguồn Direct Entry sau cutover; không cộng gộp trực tiếp với bảng legacy trong cùng ngày >= cutoff_date.",
      },
      {
        name: "hrp_count",
        type: "integer",
        label: "Tuyển dụng kênh HRP",
        formula: "SUM(hrp_count) nơi provider_type = 'hrp'",
        description: "Số lao động tuyển qua đội ngũ tuyển dụng nội bộ HRP.",
        business_limits: "Phụ thuộc vào phân loại provider_type trên đợt làm việc.",
      },
      {
        name: "vendor_count",
        type: "integer",
        label: "Tuyển dụng kênh Vendor",
        formula: "SUM(vendor_count) nơi provider_type = 'vendor'",
        description: "Số lao động tuyển qua nhà cung ứng (Vendor).",
        business_limits: "Phụ thuộc vào phân loại provider_type trên đợt làm việc.",
      },
      {
        name: "hrp_share",
        type: "number",
        label: "Tỷ trọng kênh HRP",
        formula: "hrp_count / NULLIF(hrp_count + vendor_count, 0)",
        description: "Tỷ lệ phần trăm lao động kênh HRP trên tổng số lao động đã xác định kênh.",
        business_limits: "Trả về null khi known_coverage = 0.",
      },
      {
        name: "vendor_share",
        type: "number",
        label: "Tỷ trọng kênh Vendor",
        formula: "vendor_count / NULLIF(hrp_count + vendor_count, 0)",
        description: "Tỷ lệ phần trăm lao động kênh Vendor trên tổng số lao động đã xác định kênh.",
        business_limits: "Trả về null khi known_coverage = 0.",
      },
      {
        name: "coverage_ratio",
        type: "number",
        label: "Tỷ lệ phủ phân loại kênh",
        formula: "(hrp_count + vendor_count) / NULLIF(recruited_total, 0)",
        description: "Độ phủ phân loại HRP/Vendor trên tổng tuyển dụng.",
        business_limits: "Trên Direct Entry chuẩn, mỗi bản ghi đều có provider_type ('hrp'|'vendor') nên coverage_ratio = 1 khi recruited_total > 0.",
      },
    ],
    dimensions: [
      {
        name: "date",
        label: "Ngày báo cáo",
        description: "Chuỗi thời gian theo ngày (by_date).",
        catalog_dataset: null,
      },
      {
        name: "project",
        label: "Dự án",
        description: "Phân bổ theo dự án (by_project).",
        catalog_dataset: "catalog_projects",
      },
      {
        name: "recruiter",
        label: "Người tuyển",
        description: "Phân bổ theo nhân sự tuyển dụng (by_recruiter).",
        catalog_dataset: "catalog_recruiters",
      },
      {
        name: "team",
        label: "Nhóm tuyển dụng",
        description: "Phân bổ theo nhóm tuyển dụng (by_team).",
        catalog_dataset: "catalog_teams",
      },
      {
        name: "labor_type",
        label: "Loại lao động",
        description: "Phân bổ theo loại hình lao động (by_labor_type).",
        catalog_dataset: "catalog_labor_types",
      },
      {
        name: "employment_status",
        label: "Trạng thái làm việc",
        description: "Phân bổ theo trạng thái làm việc mới nhất (by_employment_status).",
        catalog_dataset: null,
      },
    ],
    filters: [
      {
        field: "project_key",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo khóa dự án chuẩn hóa (project_key hoặc project_id viết thường).",
      },
      {
        field: "recruiter_key",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo khóa người tuyển hoặc recruiter_id.",
      },
      {
        field: "team_key",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo khóa nhóm hoặc team_id.",
      },
      {
        field: "labor_type_key",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo khóa loại lao động.",
      },
      {
        field: "employment_status_key",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo khóa trạng thái làm việc (on, off, unconfirmed).",
      },
      {
        field: "provider_type",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo kênh cung ứng ('hrp' hoặc 'vendor').",
      },
      {
        field: "row_kind",
        type: "string",
        allowed_operators: ["eq", "in"],
        description: "Giới hạn loại dòng trả về trong rows (by_date, by_project, by_recruiter, by_team, by_labor_type, by_employment_status).",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "recruitment_cutover_reconciliation",
        local_field: "report_date",
        target_field: "cutoff_date",
        cardinality: "many_to_one",
        description: "Đối chiếu tổng số liệu cutover giữa Direct Entry và nguồn legacy Google Sheets.",
      },
      {
        target_dataset: "catalog_projects",
        local_field: "key",
        target_field: "project_id",
        cardinality: "many_to_one",
        description: "Tra cứu danh mục dự án chuẩn.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 100,
      max_page_size: 500,
    },
    business_rules: [
      `Mốc cutover Direct Entry cố định tại ${P2_W04A_CUTOVER_DATE}.`,
      "Tuyệt đối không cộng gộp trực tiếp kết quả từ recruitment_cutover_summary và recruitment_legacy_summary trên cùng ngày >= cutoff_date.",
    ],
  },
  {
    dataset: "recruitment_legacy_summary",
    domain: "recruitment",
    title: "Tổng hợp Tuyển dụng Nguồn Cũ (Legacy Google Sheets)",
    description:
      "Dữ liệu tuyển dụng từ bảng đồng bộ Google Sheets cũ (daily_recruitment_breakdown). Mặc định tự động che (mask) các dòng có report_date >= cutoff_date để tránh cộng trùng với Direct Entry.",
    grain: "Tổng hợp theo ngày (report_date) và chiều phân tích trên bảng daily_recruitment_breakdown.",
    canonical_source: {
      name: "public.daily_recruitment_breakdown",
      kind: "read_model",
      underlying_objects: [
        "public.daily_recruitment_breakdown",
        "public.reporting_sources_with_facts_v01",
        "public.reporting_latest_sync_runs_v01",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "report_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: P2_W04A_CUTOVER_DATE,
      description:
        `Mặc định chỉ trả dữ liệu trước ngày cutover (${P2_W04A_CUTOVER_DATE}). Nếu đặt filter mask_post_cutover=false để kiểm toán lịch sử đồng bộ cũ, phản hồi sẽ gắn cảnh báo không được cộng gộp với Direct Entry.`,
    },
    fields: [
      field("row_kind", "string", "Loại dòng: by_date | by_project | by_recruiter | by_labor_type | by_employment_status", {
        filterable: true,
        sortable: true,
      }),
      field("report_date", "date", "Ngày báo cáo trên nguồn legacy", {
        filterable: true,
        sortable: true,
      }),
      field("dimension", "string", "Chiều phân tích", { sortable: true }),
      field("key", "string", "Khóa phân tích chuẩn hóa", {
        filterable: true,
        sortable: true,
      }),
      field("label", "string", "Nhãn hiển thị", { sortable: true }),
      field("recruited_total", "integer", "Tổng tuyển dụng ghi nhận trên nguồn legacy", {
        sortable: true,
      }),
      field("hrp_count", "integer", "Số lượng HRP trên nguồn legacy", {
        sortable: true,
      }),
      field("vendor_count", "integer", "Số lượng Vendor trên nguồn legacy", {
        sortable: true,
      }),
      field("hrp_share", "number", "Tỷ trọng HRP", { sortable: true }),
      field("vendor_share", "number", "Tỷ trọng Vendor", { sortable: true }),
    ],
    measures: [
      {
        name: "recruited_total",
        type: "integer",
        label: "Tổng tuyển dụng (Legacy)",
        formula: "SUM(recruited_total) trên daily_recruitment_breakdown",
        description: "Tổng số lượng tuyển dụng từ nguồn đồng bộ bảng tính cũ.",
        business_limits:
          `Bị che về 0 từ mốc ${P2_W04A_CUTOVER_DATE} trở đi khi mask_post_cutover=true (mặc định).`,
      },
    ],
    dimensions: [
      { name: "date", label: "Ngày báo cáo", description: "Chuỗi ngày (by_date).", catalog_dataset: null },
      { name: "project", label: "Dự án", description: "Theo dự án (by_project).", catalog_dataset: "catalog_projects" },
      { name: "recruiter", label: "Người tuyển", description: "Theo người tuyển (by_recruiter).", catalog_dataset: "catalog_recruiters" },
      { name: "labor_type", label: "Loại lao động", description: "Theo loại lao động (by_labor_type).", catalog_dataset: "catalog_labor_types" },
      { name: "employment_status", label: "Trạng thái", description: "Theo trạng thái (by_employment_status).", catalog_dataset: null },
    ],
    filters: [
      { field: "project_key", type: "string", allowed_operators: ["eq"], description: "Khóa dự án chuẩn hóa." },
      { field: "recruiter_key", type: "string", allowed_operators: ["eq"], description: "Khóa người tuyển chuẩn hóa." },
      { field: "labor_type_key", type: "string", allowed_operators: ["eq"], description: "Khóa loại lao động chuẩn hóa." },
      { field: "employment_status_key", type: "string", allowed_operators: ["eq"], description: "Khóa trạng thái chuẩn hóa." },
      {
        field: "mask_post_cutover",
        type: "boolean",
        allowed_operators: ["eq"],
        description: "Mặc định true (che các dòng >= cutoff_date). Chỉ đặt false khi đối soát riêng nguồn cũ.",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "recruitment_cutover_reconciliation",
        local_field: "report_date",
        target_field: "cutoff_date",
        cardinality: "many_to_one",
        description: "Đối soát chênh lệch và vùng chồng lấp giữa nguồn cũ và Direct Entry.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 100,
      max_page_size: 500,
    },
    business_rules: [
      "Không bao giờ cộng trực tiếp dữ liệu legacy chưa mask với dữ liệu Direct Entry.",
    ],
  },
  {
    dataset: "recruitment_cutover_reconciliation",
    domain: "recruitment",
    title: "Đối soát Cutover Tuyển dụng (Legacy vs Direct Entry)",
    description:
      "Báo cáo đối soát nguồn cũ (daily_recruitment_breakdown) và nguồn mới (Direct Entry) xung quanh mốc cutover, chỉ rõ phần bị che (masked), phần chồng lấp (overlap blocker) và tổng hợp chuẩn không trùng lặp.",
    grain: "1 dòng đối soát tổng hợp cho khoảng thời gian truy vấn (date_range).",
    canonical_source: {
      name: "public.direct_entry_reporting_reconciliation_totals",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_reporting_reconciliation_totals",
        "public.daily_recruitment_breakdown",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "cutoff_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: P2_W04A_CUTOVER_DATE,
      description: `Đối soát theo mốc cutover ${P2_W04A_CUTOVER_DATE} trong khoảng date_range được yêu cầu.`,
    },
    fields: [
      field("cutoff_date", "date", "Ngày cutover chuẩn giữa nguồn cũ và Direct Entry"),
      field("date_from", "date", "Ngày bắt đầu đối soát"),
      field("date_to", "date", "Ngày kết thúc đối soát"),
      field("legacy_before_cutoff_total", "integer", "Tổng tuyển dụng nguồn cũ trước cutoff_date (được giữ trong tổng kết hợp)"),
      field("legacy_on_or_after_cutoff_masked_total", "integer", "Tổng tuyển dụng nguồn cũ từ cutoff_date trở đi đã bị che (masked) để chống cộng trùng"),
      field("direct_entry_before_cutoff_blocker_total", "integer", "Số bản ghi Direct Entry phát sinh trước cutoff_date (overlap blocker)"),
      field("direct_entry_on_or_after_cutoff_total", "integer", "Tổng tuyển dụng Direct Entry hợp lệ từ cutoff_date trở đi"),
      field("combined_non_overlapping_total", "integer", "Tổng tuyển dụng chuẩn không trùng = legacy_before_cutoff_total + direct_entry_on_or_after_cutoff_total"),
      field("has_overlap_blocker", "boolean", "True nếu có bản ghi Direct Entry trước ngày cutoff_date"),
    ],
    measures: [
      {
        name: "combined_non_overlapping_total",
        type: "integer",
        label: "Tổng tuyển dụng chuẩn không trùng",
        formula: "legacy_before_cutoff_total + direct_entry_on_or_after_cutoff_total",
        description: "Tổng số tuyển dụng kết hợp giữa hai nguồn sau khi đã loại trừ vùng chồng lấp theo cutoff_date.",
        business_limits: "Chỉ cộng nguồn cũ trước cutoff_date và nguồn Direct Entry từ cutoff_date trở đi.",
      },
    ],
    dimensions: [],
    filters: [],
    allowed_relations: [
      {
        target_dataset: "recruitment_cutover_summary",
        local_field: "cutoff_date",
        target_field: "report_date",
        cardinality: "one_to_many",
        description: "Chi tiết tuyển dụng Direct Entry sau cutover.",
      },
    ],
    pagination: {
      strategy: "none",
      default_page_size: 1,
      max_page_size: 10,
    },
    business_rules: [
      "Mọi báo cáo tổng hợp xuyên kỳ cutover phải dùng combined_non_overlapping_total, tuyệt đối không cộng legacy_on_or_after_cutoff_masked_total.",
    ],
  },

  // =========================================================================
  // 2. WORKFORCE DOMAIN (Lực lượng lao động)
  // =========================================================================
  {
    dataset: "workforce_analytics",
    domain: "workforce",
    title: "Phân tích Lực lượng Lao động (Snapshot, Biến động, Chờ việc, Thâm niên, Retention, Lý do nghỉ)",
    description:
      "Báo cáo toàn diện về lực lượng lao động (WF-01..WF-04): snapshot trạng thái tại ngày chốt (as_of_date), biến động chuyển trạng thái trong kỳ, cân đối đầu kỳ/cuối kỳ, thời gian chờ việc (UNCONFIRMED), thâm niên làm việc (ON), tỷ lệ giữ chân (D7/D30/D90), phân bổ theo dự án/nhóm/người tuyển/vendor và nhóm lý do nghỉ việc.",
    grain:
      "Summary chứa toàn bộ khối chỉ số chuẩn WF-01..WF-04; rows trả danh sách phân bổ theo section được chọn (by_project, by_team, by_recruiter, by_provider, leave_reason_categories, leave_reason_details, retention_cohorts).",
    canonical_source: {
      name: "public.direct_entry_workforce_reporting_scoped",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_workforce_reporting_scoped",
        "public.direct_entries",
        "public.direct_entry_employment_status_events",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "as_of_date",
      supports_date_range: true,
      supports_as_of_date: true,
      cutoff_date: null,
      description:
        "Snapshot, chờ việc, thâm niên hiện tại và retention được tính tại as_of_date (mặc định bằng date_range.to hoặc ngày nghiệp vụ hiện tại, không vượt quá ngày hiện tại tại Asia/Ho_Chi_Minh). Biến động, cân đối kỳ và lý do nghỉ việc được tính trong khoảng date_range.",
    },
    fields: [
      field("section", "string", "Phân mục của dòng: by_project | by_team | by_recruiter | by_provider | leave_reason_categories | leave_reason_details | retention_cohorts", {
        filterable: true,
        sortable: true,
      }),
      field("key", "string", "Mã định danh của mục (project_id, team_id, recruiter_id, provider_key, category_key, horizon)", {
        filterable: true,
        sortable: true,
      }),
      field("label", "string", "Tên hiển thị của mục", { sortable: true }),
      field("provider_type", "string", "Kênh cung ứng ('hrp' | 'vendor') nếu có", {
        filterable: true,
        sortable: true,
      }),
      field("snapshot_total", "integer", "Tổng số đợt làm việc có hiệu lực tại as_of_date", {
        sortable: true,
      }),
      field("working_on_count", "integer", "Số lao động đang làm việc (ON) tại as_of_date", {
        sortable: true,
      }),
      field("waiting_unconfirmed_count", "integer", "Số lao động đang chờ việc (UNCONFIRMED) tại as_of_date", {
        sortable: true,
      }),
      field("left_off_count", "integer", "Số đợt làm việc đã nghỉ (OFF) tại as_of_date", {
        sortable: true,
      }),
      field("active_pool_count", "integer", "Tổng nguồn lao động hoạt động = working_on_count + waiting_unconfirmed_count", {
        sortable: true,
      }),
      field("inflow_on_total", "integer", "Tổng tăng mới vào trạng thái ON trong kỳ", {
        sortable: true,
      }),
      field("outflow_to_off_count", "integer", "Tổng chuyển từ ON sang OFF trong kỳ", {
        sortable: true,
      }),
      field("net_working_change", "integer", "Biến động ròng số đang làm việc = inflow_on_total - outflow_to_off_count", {
        sortable: true,
      }),
      field("off_event_count", "integer", "Số sự kiện nghỉ việc (cho section leave_reason_*)", {
        sortable: true,
      }),
      field("share_of_categorized", "number", "Tỷ trọng lý do nghỉ việc trên các sự kiện đã phân loại", {
        sortable: true,
      }),
      field("eligible_cohort_size", "integer", "Quy mô cohort đủ tuổi đánh giá retention (D7/D30/D90)", {
        sortable: true,
      }),
      field("retained_count", "integer", "Số đợt làm việc giữ chân thành công qua ngưỡng D7/D30/D90", {
        sortable: true,
      }),
      field("retention_rate", "number", "Tỷ lệ giữ chân = retained_count / NULLIF(eligible_cohort_size, 0)", {
        sortable: true,
      }),
    ],
    measures: [
      {
        name: "working_on_count",
        type: "integer",
        label: "Đang làm việc (ON)",
        formula: "COUNT(episodes) có trạng thái hợp lệ mới nhất tại as_of_date = 'ON'",
        description: "Số đợt làm việc SUBMITTED đang ở trạng thái ON tại ngày chốt as_of_date.",
        business_limits: "Loại trừ các sự kiện đã bị thay thế (superseded) hoặc có effective_date > as_of_date.",
      },
      {
        name: "waiting_unconfirmed_count",
        type: "integer",
        label: "Đang chờ việc (UNCONFIRMED)",
        formula: "COUNT(episodes) có trạng thái hợp lệ mới nhất tại as_of_date = 'UNCONFIRMED'",
        description: "Số đợt làm việc đang ở trạng thái chờ việc tại ngày chốt as_of_date.",
        business_limits: "Tuổi chờ việc tính từ effective_date của trạng thái UNCONFIRMED hiện tại đến as_of_date.",
      },
      {
        name: "left_off_count",
        type: "integer",
        label: "Đã nghỉ việc (OFF)",
        formula: "COUNT(episodes) có trạng thái hợp lệ mới nhất tại as_of_date = 'OFF'",
        description: "Số đợt làm việc có trạng thái mới nhất là OFF tại as_of_date.",
        business_limits: "Tính theo độ hạt đợt làm việc (episode).",
      },
      {
        name: "active_pool_count",
        type: "integer",
        label: "Nguồn lao động hoạt động",
        formula: "working_on_count + waiting_unconfirmed_count",
        description: "Tổng số đợt làm việc đang làm (ON) hoặc đang chờ việc (UNCONFIRMED).",
        business_limits: "Không bao gồm các đợt đã OFF.",
      },
      {
        name: "net_working_change",
        type: "integer",
        label: "Biến động ròng lao động ON trong kỳ",
        formula: "closing_working_on_count - opening_working_on_count = inflow_on_total - outflow_to_off_count",
        description: "Chênh lệch giữa số lượng vào làm (inflow ON) và nghỉ việc (outflow OFF) trong khoảng date_range.",
        business_limits: "Luôn đảm bảo cân đối: opening_working_on_count + inflow_on_total - outflow_to_off_count = closing_working_on_count.",
      },
      {
        name: "avg_waiting_days",
        type: "number",
        label: "Số ngày chờ việc trung bình",
        formula: "AVG(as_of_date - unconfirmed_effective_date) trên các đợt đang UNCONFIRMED",
        description: "Trung bình số ngày chờ việc của các lao động đang ở trạng thái UNCONFIRMED tại as_of_date.",
        business_limits: "Trả về null khi current_waiting_count = 0.",
      },
      {
        name: "current_on_avg_days",
        type: "number",
        label: "Thâm niên ON hiện tại trung bình (ngày)",
        formula: "AVG(as_of_date - on_span_start_date + 1) trên các đợt đang ON",
        description: "Số ngày làm việc trung bình của các đợt đang ở trạng thái ON tính tới as_of_date.",
        business_limits: "Trả về null khi current_on_count = 0.",
      },
      {
        name: "d7_retention_rate",
        type: "number",
        label: "Tỷ lệ giữ chân D7",
        formula: "d7.retained_count / NULLIF(d7.eligible_cohort_size, 0)",
        description: "Tỷ lệ lao động bắt đầu ON trong kỳ (và đã đủ >= 7 ngày tính tới as_of_date) không bị OFF trong vòng 7 ngày đầu.",
        business_limits: "Loại trừ các đợt chưa đủ 7 ngày kể từ ngày ON đầu tiên (immature_excluded_count).",
      },
      {
        name: "d30_retention_rate",
        type: "number",
        label: "Tỷ lệ giữ chân D30",
        formula: "d30.retained_count / NULLIF(d30.eligible_cohort_size, 0)",
        description: "Tỷ lệ lao động bắt đầu ON trong kỳ (và đã đủ >= 30 ngày tính tới as_of_date) không bị OFF trong vòng 30 ngày đầu.",
        business_limits: "Loại trừ các đợt chưa đủ 30 ngày kể từ ngày ON đầu tiên.",
      },
      {
        name: "d90_retention_rate",
        type: "number",
        label: "Tỷ lệ giữ chân D90",
        formula: "d90.retained_count / NULLIF(d90.eligible_cohort_size, 0)",
        description: "Tỷ lệ lao động bắt đầu ON trong kỳ (và đã đủ >= 90 ngày tính tới as_of_date) không bị OFF trong vòng 90 ngày đầu.",
        business_limits: "Loại trừ các đợt chưa đủ 90 ngày kể từ ngày ON đầu tiên.",
      },
    ],
    dimensions: [
      { name: "project", label: "Dự án", description: "Breakdown theo dự án (by_project).", catalog_dataset: "catalog_projects" },
      { name: "team", label: "Nhóm", description: "Breakdown theo nhóm tuyển dụng (by_team).", catalog_dataset: "catalog_teams" },
      { name: "recruiter", label: "Người tuyển", description: "Breakdown theo nhân sự tuyển dụng (by_recruiter).", catalog_dataset: "catalog_recruiters" },
      { name: "provider", label: "Nhà cung ứng / Kênh", description: "Breakdown theo kênh HRP hoặc từng Vendor (by_provider).", catalog_dataset: "catalog_vendors" },
      { name: "leave_reason", label: "Lý do nghỉ việc", description: "Breakdown theo nhóm lý do nghỉ việc chuẩn hóa và chi tiết.", catalog_dataset: null },
    ],
    filters: [
      {
        field: "project_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc toàn bộ báo cáo lực lượng lao động theo mã dự án (project_id).",
      },
      {
        field: "recruiter_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo UUID của người tuyển (recruiter_id).",
      },
      {
        field: "provider_type",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo kênh cung ứng ('hrp' hoặc 'vendor').",
      },
      {
        field: "section",
        type: "string",
        allowed_operators: ["eq", "in"],
        description:
          "Chọn phân mục chi tiết trả về trong rows: by_project | by_team | by_recruiter | by_provider | leave_reason_categories | leave_reason_details | retention_cohorts.",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "workforce_offboarding",
        local_field: "key",
        target_field: "project_id",
        cardinality: "one_to_many",
        description: "Tra cứu danh sách người lao động đã nghỉ >= 3 ngày chưa có đợt làm việc ON mới theo dự án.",
      },
      {
        target_dataset: "catalog_projects",
        local_field: "key",
        target_field: "project_id",
        cardinality: "many_to_one",
        description: "Đối chiếu thông tin dự án.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 25,
      max_page_size: 100,
    },
    business_rules: [
      "as_of_date không bao giờ vượt quá ngày hiện tại theo múi giờ Asia/Ho_Chi_Minh.",
      "Các sự kiện trạng thái đã bị thay thế (superseded) không được tính vào snapshot hoặc biến động.",
    ],
  },
  {
    dataset: "workforce_offboarding",
    domain: "workforce",
    title: "Báo cáo Lao động Nghỉ việc / Chưa có việc mới (>= 3 ngày)",
    description:
      "Danh sách người lao động đã nghỉ việc (OFF) ở đợt làm việc cuối cùng đủ từ 3 ngày trở lên tính tới ngày nghiệp vụ và hiện chưa có đợt làm việc ON mới hơn ở bất kỳ dự án nào.",
    grain: "1 dòng trên mỗi người lao động (nhóm theo định danh người lao động ở đợt OFF cuối cùng).",
    canonical_source: {
      name: "public.direct_entry_offboarding_report",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_offboarding_report",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "off_effective_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description:
        "Chỉ bao gồm người lao động có off_effective_date <= authorization_date - 3 ngày và chưa có đợt ON mới hơn.",
    },
    fields: [
      field("employee_code", "string", "Mã nhân viên của đợt làm việc OFF cuối cùng", {
        filterable: true,
        sortable: true,
      }),
      field("display_name", "string", "Họ và tên người lao động", {
        filterable: true,
        sortable: true,
      }),
      field("project_id", "string", "Mã dự án cuối cùng trước khi nghỉ", {
        filterable: true,
        sortable: true,
      }),
      field("project_display", "string", "Tên dự án cuối cùng", { sortable: true }),
      field("recruiter_id", "string", "UUID người tuyển phụ trách đợt làm việc cuối", {
        filterable: true,
        sortable: true,
      }),
      field("recruiter_display", "string", "Tên người tuyển phụ trách", { sortable: true }),
      field("off_effective_date", "date", "Ngày hiệu lực nghỉ việc (OFF) gần nhất", {
        filterable: true,
        sortable: true,
      }),
      field("days_since_off", "integer", "Số ngày đã nghỉ tính tới ngày nghiệp vụ hiện tại (>= 3)", {
        filterable: true,
        sortable: true,
      }),
      field("phone", "string", "Số điện thoại người lao động (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "pii_phone",
      }),
    ],
    measures: [
      {
        name: "total_workers",
        type: "integer",
        label: "Tổng số lao động nghỉ việc >= 3 ngày chưa quay lại",
        formula: "COUNT(*) từ public.direct_entry_offboarding_report",
        description: "Tổng số người lao động đủ điều kiện trong phạm vi lọc.",
        business_limits: "Không bao gồm các bản ghi đã bị ẩn hợp lệ trong sổ suppression.",
      },
    ],
    dimensions: [
      { name: "project", label: "Dự án cuối", description: "Theo dự án làm việc cuối cùng.", catalog_dataset: "catalog_projects" },
      { name: "recruiter", label: "Người tuyển cuối", description: "Theo người tuyển phụ trách cuối cùng.", catalog_dataset: "catalog_recruiters" },
    ],
    filters: [
      { field: "project_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo mã dự án cuối cùng." },
      { field: "recruiter_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID người tuyển." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm kiếm theo tên hoặc mã nhân viên." },
      { field: "days_since_off", type: "integer", allowed_operators: ["gte", "lte", "between"], description: "Lọc theo số ngày kể từ khi nghỉ việc." },
    ],
    allowed_relations: [
      {
        target_dataset: "workers_episodes_lookup",
        local_field: "employee_code",
        target_field: "employee_code",
        cardinality: "one_to_many",
        description: "Tra cứu toàn bộ lịch sử các đợt làm việc của người lao động.",
      },
    ],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 25,
      max_page_size: 100,
    },
    business_rules: [
      "Trường phone là dữ liệu PII nhạy cảm; chỉ được trả về khi QuerySpec.fields liệt kê tường minh 'phone'.",
      "Số CCCD chỉ dùng để gom định danh phía DB, tuyệt đối không xuất hiện trong dataset này.",
    ],
  },

  // =========================================================================
  // 3. WORKERS DOMAIN (Hồ sơ NLĐ)
  // =========================================================================
  {
    dataset: "workers_directory",
    domain: "workers",
    title: "Danh bạ Hồ sơ Đợt làm việc NLĐ (Toàn miền BoD)",
    description:
      "Danh sách các đợt làm việc đã nộp (SUBMITTED) trên toàn miền BoD, hỗ trợ lọc theo dự án, người tuyển, trạng thái làm việc (ON/OFF/UNCONFIRMED), tìm kiếm theo tên/mã NV và phân trang keyset cursor.",
    grain: "1 dòng trên mỗi đợt làm việc (entry_id) ở trạng thái SUBMITTED.",
    canonical_source: {
      name: "public.direct_entry_list_workers",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_list_workers",
        "public.direct_entries",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "first_work_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Sắp xếp giảm dần theo first_work_date DESC, entry_id DESC.",
    },
    fields: [
      field("entry_id", "string", "UUID đợt làm việc", {
        filterable: true,
        sortable: true,
      }),
      field("entry_version", "integer", "Phiên bản hiện tại của bản ghi"),
      field("submission_state", "string", "Trạng thái nộp (SUBMITTED)"),
      field("employee_code", "string", "Mã nhân viên", {
        filterable: true,
        sortable: true,
      }),
      field("display_name", "string", "Họ và tên người lao động", {
        filterable: true,
        sortable: true,
      }),
      field("project_id", "string", "Mã dự án", {
        filterable: true,
        sortable: true,
      }),
      field("project_display", "string", "Tên hiển thị dự án", { sortable: true }),
      field("first_work_date", "date", "Ngày vào làm (YYYY-MM-DD)", {
        filterable: true,
        sortable: true,
      }),
      field("labor_type", "string", "Mã loại lao động", {
        filterable: true,
        sortable: true,
      }),
      field("labor_type_display", "string", "Tên loại lao động", { sortable: true }),
      field("employment_status", "string", "Trạng thái làm việc mới nhất: ON | OFF | UNCONFIRMED", {
        filterable: true,
        sortable: true,
      }),
      field("recruiter_id", "string", "UUID người tuyển", {
        filterable: true,
        sortable: true,
      }),
      field("recruiter_display", "string", "Tên người tuyển", { sortable: true }),
      field("payment_state", "string", "Trạng thái thông tin thanh toán (nếu có)"),
      field("bank_id", "string", "Mã ngân hàng"),
      field("account_number", "string", "Số tài khoản ngân hàng (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "financial_account",
      }),
      field("account_holder_name", "string", "Tên chủ tài khoản ngân hàng (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "financial_account",
      }),
    ],
    measures: [
      {
        name: "total_workers",
        type: "integer",
        label: "Tổng số hồ sơ đợt làm việc",
        formula: "summary.total_workers từ public.direct_entry_list_workers",
        description: "Tổng số hồ sơ SUBMITTED thỏa mãn bộ lọc.",
        business_limits: "Không tính các bản ghi DRAFT/REVIEW hoặc đã bị xóa/void.",
      },
      {
        name: "project_count",
        type: "integer",
        label: "Số lượng dự án có lao động",
        formula: "COUNT(DISTINCT project_id) trên tập hồ sơ khớp bộ lọc",
        description: "Số dự án phân biệt trong tập kết quả.",
        business_limits: "Tính trên tập hồ sơ khớp bộ lọc.",
      },
      {
        name: "recruiter_count",
        type: "integer",
        label: "Số lượng người tuyển có lao động",
        formula: "COUNT(DISTINCT recruiter_id) trên tập hồ sơ khớp bộ lọc",
        description: "Số người tuyển phân biệt trong tập kết quả.",
        business_limits: "Tính trên tập hồ sơ khớp bộ lọc.",
      },
    ],
    dimensions: [
      { name: "project", label: "Dự án", description: "Theo dự án.", catalog_dataset: "catalog_projects" },
      { name: "recruiter", label: "Người tuyển", description: "Theo người tuyển.", catalog_dataset: "catalog_recruiters" },
      { name: "employment_status", label: "Trạng thái làm việc", description: "ON | OFF | UNCONFIRMED.", catalog_dataset: null },
    ],
    filters: [
      { field: "project_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo mã dự án." },
      { field: "recruiter_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID người tuyển." },
      { field: "employment_status", type: "string", allowed_operators: ["eq"], description: "Lọc theo trạng thái làm việc: ON, OFF, UNCONFIRMED." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm theo tên người lao động hoặc mã nhân viên." },
    ],
    allowed_relations: [
      {
        target_dataset: "workers_profile_detail",
        local_field: "entry_id",
        target_field: "entry_id",
        cardinality: "one_to_one",
        description: "Đọc hồ sơ chi tiết của một đợt làm việc cụ thể theo entry_id.",
      },
      {
        target_dataset: "workers_episodes_lookup",
        local_field: "employee_code",
        target_field: "employee_code",
        cardinality: "one_to_many",
        description: "Tra cứu toàn bộ các đợt làm việc của cùng người lao động.",
      },
    ],
    pagination: {
      strategy: "keyset_cursor",
      default_page_size: 25,
      max_page_size: 100,
    },
    business_rules: [
      "Số tài khoản và tên chủ tài khoản ngân hàng chỉ trả khi được liệt kê tường minh trong fields.",
    ],
  },
  {
    dataset: "workers_profile_detail",
    domain: "workers",
    title: "Chi tiết Hồ sơ Đợt làm việc NLĐ (Theo entry_id)",
    description:
      "Đọc chi tiết một hồ sơ đợt làm việc theo entry_id (bao gồm thông tin cá nhân, trạng thái làm việc, ngân hàng và trạng thái метаdata chứng từ mà không trả tệp ảnh nhị phân).",
    grain: "1 dòng cho đúng entry_id được yêu cầu.",
    canonical_source: {
      name: "public.direct_entry_read_projection",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_read_projection",
      ],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "first_work_date",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Trả trạng thái hiện hành của hồ sơ đợt làm việc theo entry_id.",
    },
    fields: [
      field("entry_id", "string", "UUID đợt làm việc", { filterable: true }),
      field("submission_id", "string", "UUID lô nộp"),
      field("version", "integer", "Phiên bản bản ghi"),
      field("employee_code", "string", "Mã nhân viên"),
      field("display_name", "string", "Họ và tên người lao động"),
      field("project_id", "string", "Mã dự án"),
      field("recruiter_id", "string", "UUID người tuyển"),
      field("team_id", "string", "UUID nhóm tuyển dụng"),
      field("provider_type", "string", "Kênh cung ứng ('hrp' | 'vendor')"),
      field("labor_type", "string", "Mã loại lao động"),
      field("labor_type_display", "string", "Tên loại lao động"),
      field("first_work_date", "date", "Ngày vào làm"),
      field("employment_status", "string", "Trạng thái làm việc hiện tại"),
      field("employment_status_effective_date", "date", "Ngày hiệu lực của trạng thái hiện tại"),
      field("gender", "string", "Giới tính"),
      field("date_of_birth", "date", "Ngày sinh (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_personal",
      }),
      field("national_id_masked", "string", "Số CCCD đã che (••••••••1234)"),
      field("national_id", "string", "Số CCCD đầy đủ (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_national_id",
      }),
      field("national_id_issued_at", "date", "Ngày cấp CCCD (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_personal",
      }),
      field("national_id_issued_place", "string", "Nơi cấp CCCD (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_personal",
      }),
      field("phone", "string", "Số điện thoại (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_phone",
      }),
      field("address", "string", "Địa chỉ thường trú (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_personal",
      }),
      field("general_note", "string", "Ghi chú tự do trên hồ sơ (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "free_text",
      }),
      field("payment_state", "string", "Trạng thái thông tin thanh toán"),
      field("bank_id", "string", "Mã ngân hàng"),
      field("bank_name", "string", "Tên ngân hàng"),
      field("account_number_masked", "string", "Số tài khoản ngân hàng đã che"),
      field("account_number", "string", "Số tài khoản ngân hàng đầy đủ (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "financial_account",
      }),
      field("account_holder_name", "string", "Tên chủ tài khoản ngân hàng (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "financial_account",
      }),
      field("portrait_status", "string", "Trạng thái ảnh chân dung (chỉ trả metadata)"),
      field("document_count", "integer", "Số lượng tài liệu CCCD đính kèm (chỉ trả metadata, không trả ảnh)"),
    ],
    measures: [],
    dimensions: [],
    filters: [
      {
        field: "entry_id",
        type: "string",
        allowed_operators: ["eq"],
        required: true,
        description: "UUID của đợt làm việc cần xem chi tiết (bắt buộc).",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "workers_episodes_lookup",
        local_field: "employee_code",
        target_field: "employee_code",
        cardinality: "one_to_many",
        description: "Tra cứu tất cả đợt làm việc của người lao động này.",
      },
    ],
    pagination: {
      strategy: "none",
      default_page_size: 1,
      max_page_size: 1,
    },
    business_rules: [
      "Chỉ trả metadata về tài liệu/ảnh; tuyệt đối không trả nội dung ảnh hoặc presigned URL trong /query.",
      "Các trường CCCD, SĐT, ngày sinh, địa chỉ, số tài khoản, ghi chú tự do chỉ được trả khi liệt kê trong fields.",
    ],
  },
  {
    dataset: "workers_episodes_lookup",
    domain: "workers",
    title: "Tra cứu Lịch sử Đợt làm việc & Điều kiện Tuyển lại NLĐ",
    description:
      "Tra cứu tất cả các đợt làm việc (episodes) của một người lao động theo số CCCD (12 chữ số) hoặc mã nhân viên (employee_code), kèm kết luận người lao động đang có đợt ON/UNCONFIRMED hay đủ điều kiện tạo đợt làm việc mới.",
    grain: "1 dòng trên mỗi đợt làm việc (episode) khớp với CCCD hoặc mã nhân viên.",
    canonical_source: {
      name: "public.direct_entry_lookup_worker_episodes",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_lookup_worker_episodes",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "first_work_date",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Trả toàn bộ lịch sử đợt làm việc tính tới thời điểm hiện tại.",
    },
    fields: [
      field("entry_id", "string", "UUID đợt làm việc"),
      field("employee_code", "string", "Mã nhân viên", { filterable: true }),
      field("display_name", "string", "Họ và tên người lao động", {
        filterable: true,
      }),
      field("project_id", "string", "Mã dự án", { filterable: true }),
      field("project_display", "string", "Tên hiển thị dự án"),
      field("first_work_date", "date", "Ngày vào làm của đợt"),
      field("latest_employment_status", "string", "Trạng thái làm việc mới nhất của đợt (ON | OFF | UNCONFIRMED)"),
      field("worker_episode_count", "integer", "Tổng số đợt làm việc của người lao động này"),
      field("active_episode_exists", "boolean", "True nếu người lao động đang có đợt ON hoặc UNCONFIRMED"),
      field("rehire_allowed", "boolean", "True nếu người lao động đủ điều kiện tuyển lại"),
    ],
    measures: [
      {
        name: "matched_worker_count",
        type: "integer",
        label: "Số người lao động khớp điều kiện",
        formula: "COUNT(workers) từ public.direct_entry_lookup_worker_episodes",
        description: "Số người lao động khớp với điều kiện tìm kiếm CCCD hoặc họ tên.",
        business_limits: "Yêu cầu cung cấp project_id và ít nhất một trong hai filter: national_id hoặc display_name.",
      },
    ],
    dimensions: [],
    filters: [
      {
        field: "project_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Mã dự án để đối chiếu phạm vi tra cứu (mặc định 'default' nếu không truyền).",
      },
      {
        field: "national_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Số CCCD chính xác 9 hoặc 12 chữ số.",
      },
      {
        field: "display_name",
        type: "string",
        allowed_operators: ["eq", "contains"],
        description: "Họ và tên người lao động cần tra cứu.",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "workers_profile_detail",
        local_field: "entry_id",
        target_field: "entry_id",
        cardinality: "one_to_one",
        description: "Xem chi tiết hồ sơ của từng đợt làm việc.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 25,
      max_page_size: 50,
    },
    business_rules: [
      "Tra cứu lịch sử đợt làm việc theo CCCD hoặc họ tên; RPC không trả số CCCD thô trong danh sách tập hợp.",
    ],
  },
  {
    dataset: "workers_duplicate_cccd",
    domain: "workers",
    title: "Báo cáo Trùng CCCD đang hoạt động (Phạm vi BoD)",
    description:
      "Danh sách các nhóm số CCCD bị trùng trên từ 2 đợt làm việc SUBMITTED trở lên trong phạm vi toàn miền BoD.",
    grain: "Mỗi dòng là một đợt làm việc (episode) nằm trong nhóm trùng CCCD.",
    canonical_source: {
      name: "public.direct_entry_duplicate_cccd_report",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_duplicate_cccd_report",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "first_work_date",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Phản ánh trạng thái trùng CCCD hiện hành tại ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("cccd_last4", "string", "4 số cuối của CCCD bị trùng", {
        filterable: true,
        sortable: true,
      }),
      field("canonical_cccd_masked", "string", "Số CCCD chuẩn hóa đã che (••••••••1234)", {
        sortable: true,
      }),
      field("cccd_length", "integer", "Độ dài số CCCD (9 hoặc 12 số)"),
      field("group_episode_count", "integer", "Số đợt làm việc đang trùng trong cùng nhóm CCCD", {
        sortable: true,
      }),
      field("active_profile_count", "integer", "Số đợt làm việc đang hoạt động (ON/UNCONFIRMED) trong nhóm", {
        sortable: true,
      }),
      field("project_count", "integer", "Số dự án liên quan trong nhóm trùng CCCD", {
        sortable: true,
      }),
      field("entry_id", "string", "UUID đợt làm việc", { filterable: true }),
      field("entry_version", "integer", "Phiên bản đợt làm việc"),
      field("employee_code", "string", "Mã nhân viên", {
        filterable: true,
        sortable: true,
      }),
      field("display_name", "string", "Họ và tên người lao động", {
        filterable: true,
        sortable: true,
      }),
      field("project_display", "string", "Tên hiển thị dự án", {
        filterable: true,
        sortable: true,
      }),
      field("first_work_date", "date", "Ngày vào làm", { sortable: true }),
      field("latest_status", "string", "Trạng thái hiện tại của đợt làm việc (ON | OFF | UNCONFIRMED)", {
        filterable: true,
        sortable: true,
      }),
      field("active", "boolean", "True nếu đợt làm việc đang ở trạng thái hoạt động", {
        filterable: true,
      }),
    ],
    measures: [
      {
        name: "total_duplicate_groups",
        type: "integer",
        label: "Tổng số nhóm CCCD bị trùng",
        formula: "total_groups từ public.direct_entry_duplicate_cccd_report",
        description: "Số lượng số CCCD phân biệt đang có >= 2 đợt làm việc SUBMITTED.",
        business_limits: "Tính trên toàn bộ các bản ghi SUBMITTED chưa bị xóa/void.",
      },
      {
        name: "total_duplicate_episodes",
        type: "integer",
        label: "Tổng số đợt làm việc nằm trong các nhóm trùng CCCD",
        formula: "total_entries từ public.direct_entry_duplicate_cccd_report",
        description: "Tổng số đợt làm việc liên quan đến các nhóm trùng CCCD.",
        business_limits: "Tính trên toàn bộ các nhóm trùng CCCD.",
      },
    ],
    dimensions: [
      { name: "project", label: "Dự án", description: "Theo dự án của đợt làm việc trùng.", catalog_dataset: "catalog_projects" },
    ],
    filters: [
      { field: "project_display", type: "string", allowed_operators: ["eq", "contains"], description: "Lọc các dòng theo tên dự án." },
      { field: "latest_status", type: "string", allowed_operators: ["eq"], description: "Lọc theo trạng thái (ON | OFF | UNCONFIRMED)." },
      { field: "cccd_last4", type: "string", allowed_operators: ["eq"], description: "Lọc theo 4 chữ số cuối của CCCD." },
    ],
    allowed_relations: [
      {
        target_dataset: "workers_profile_detail",
        local_field: "entry_id",
        target_field: "entry_id",
        cardinality: "one_to_one",
        description: "Xem chi tiết hồ sơ (và CCCD đầy đủ khi yêu cầu trường nhạy cảm national_id) của đợt làm việc bị trùng.",
      },
    ],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 25,
      max_page_size: 100,
    },
    business_rules: [
      "Báo cáo nhóm trùng CCCD chỉ trả 4 số cuối (cccd_last4 / canonical_cccd_masked); để xem số CCCD 12 số của một đợt làm việc cụ thể, truy vấn workers_profile_detail theo entry_id với fields=['national_id'].",
    ],
  },

  // =========================================================================
  // 4. ATTENDANCE DOMAIN (Chấm công)
  // =========================================================================
  {
    dataset: "attendance_checkins",
    domain: "attendance",
    title: "Báo cáo Chấm công & Xác minh Thời gian / Khoảng cách GPS",
    description:
      "Tổng quan KPI và danh sách chi tiết các lượt chấm công (attendance_admin_report), bao gồm giờ chấm công, trạng thái xác minh thời gian (time_verified), độ trễ đồng bộ, khoảng cách so với trụ sở (HQ) tại thời điểm chấm công, tọa độ GPS và ghi chú.",
    grain: "1 dòng trên mỗi lượt chấm công (checkin_id).",
    canonical_source: {
      name: "public.attendance_admin_report",
      kind: "rpc",
      underlying_objects: [
        "public.attendance_admin_report",
        "public.attendance_checkins",
        "public.attendance_hq_location_revisions",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "business_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description:
        "Lọc theo khoảng ngày nghiệp vụ business_date (Asia/Ho_Chi_Minh), tối đa 93 ngày mỗi lần truy vấn. Mặc định lấy ngày nghiệp vụ hiện tại nếu không truyền date_range.",
    },
    fields: [
      field("checkin_id", "string", "UUID lượt chấm công", { filterable: true }),
      field("app_user_id", "string", "UUID tài khoản nhân sự chấm công (dùng để lọc theo nhân sự)", { filterable: true }),
      field("employee_code", "string", "Mã nhân viên / mã định danh nhân sự (personnel_code)", {
        filterable: true,
        sortable: true,
      }),
      field("display_name", "string", "Họ và tên nhân sự chấm công", {
        filterable: true,
        sortable: true,
      }),
      field("business_date", "date", "Ngày nghiệp vụ chấm công (YYYY-MM-DD)", {
        filterable: true,
        sortable: true,
      }),
      field("sequence_in_day", "integer", "Số thứ tự lượt chấm công trong ngày của nhân sự", {
        sortable: true,
      }),
      field("captured_at", "datetime", "Thời điểm ghi nhận chấm công (UTC ISO-8601)", {
        sortable: true,
      }),
      field("captured_at_local", "string", "Thời điểm chấm công theo giờ địa phương (YYYY-MM-DD HH:mm:ss)", {
        sortable: true,
      }),
      field("received_at", "datetime", "Thời điểm server nhận bản ghi đồng bộ (UTC ISO-8601)", {
        sortable: true,
      }),
      field("time_source", "string", "Nguồn thời gian: SERVER_TOKEN | SERVER_RECEIVE | CLIENT_UNVERIFIED_OFFLINE", {
        filterable: true,
        sortable: true,
      }),
      field("time_verified", "boolean", "True nếu thời gian chấm công đã được xác thực bởi server", {
        filterable: true,
        sortable: true,
      }),
      field("sync_delay_seconds", "integer", "Độ trễ đồng bộ từ lúc chụp đến lúc server nhận (giây)", {
        sortable: true,
      }),
      field("distance_meters", "number", "Khoảng cách tới tọa độ HQ hiệu lực tại thời điểm chấm công (mét)", {
        filterable: true,
        sortable: true,
      }),
      field("distance_status", "string", "Phân loại khoảng cách: WITHIN_100M | OVER_100M | HQ_NOT_CONFIGURED", {
        filterable: true,
        sortable: true,
      }),
      field("hq_version_used", "integer", "Phiên bản tọa độ HQ được dùng để tính khoảng cách"),
      field("latitude", "number", "Vĩ độ GPS (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "gps_location",
      }),
      field("longitude", "number", "Kinh độ GPS (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "gps_location",
      }),
      field("accuracy_meters", "number", "Sai số GPS tính bằng mét (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "gps_location",
      }),
      field("address_hint", "string", "Gợi ý địa chỉ tại điểm chấm công (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "gps_location",
      }),
      field("note", "string", "Ghi chú tự do của nhân sự khi chấm công (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "free_text",
      }),
    ],
    measures: [
      {
        name: "total_checkins",
        type: "integer",
        label: "Tổng số lượt chấm công",
        formula: "overview.total_checkins từ public.attendance_admin_report",
        description: "Tổng số lượt chấm công khớp điều kiện lọc trong khoảng ngày.",
        business_limits: "Khoảng ngày truy vấn tối đa 93 ngày.",
      },
      {
        name: "unique_employees",
        type: "integer",
        label: "Số nhân sự chấm công phân biệt",
        formula: "overview.unique_employees (COUNT(DISTINCT app_user_id))",
        description: "Số lượng nhân sự có chấm công trong khoảng thời gian.",
        business_limits: "Tính trên phạm vi bộ lọc hiện tại.",
      },
      {
        name: "verified_time_count",
        type: "integer",
        label: "Số lượt chấm công đã xác minh thời gian",
        formula: "overview.verified_time_count (COUNT(*) WHERE time_verified = true)",
        description: "Số lượt chấm công có nguồn thời gian được xác thực bởi server.",
        business_limits: "Bao gồm SERVER_TOKEN và SERVER_RECEIVE hợp lệ.",
      },
      {
        name: "unverified_time_count",
        type: "integer",
        label: "Số lượt chấm công chưa xác minh thời gian (offline)",
        formula: "overview.unverified_time_count (COUNT(*) WHERE time_verified = false)",
        description: "Số lượt chấm công ngoại tuyến chưa có time token xác thực.",
        business_limits: "Cần lưu ý khi đối soát chuyên cần.",
      },
      {
        name: "distance_computed_count",
        type: "integer",
        label: "Số lượt chấm công đã tính được khoảng cách HQ",
        formula: "overview.distance_computed_count",
        description: "Số lượt chấm công có tọa độ HQ hiệu lực để tính khoảng cách.",
        business_limits: "Đối chiếu với phiên bản tọa độ HQ có hiệu lực tại thời điểm chấm công.",
      },
      {
        name: "avg_distance_meters",
        type: "number",
        label: "Khoảng cách trung bình tới HQ (mét)",
        formula: "overview.avg_distance_meters",
        description: "Khoảng cách trung bình từ điểm chấm công tới tọa độ HQ.",
        business_limits: "Null nếu không có lượt chấm công nào tính được khoảng cách.",
      },
    ],
    dimensions: [
      { name: "business_date", label: "Ngày chấm công", description: "Theo ngày nghiệp vụ.", catalog_dataset: null },
      { name: "distance_status", label: "Trạng thái khoảng cách HQ", description: "WITHIN_100M | OVER_100M | HQ_NOT_CONFIGURED.", catalog_dataset: null },
      { name: "time_verified", label: "Trạng thái xác minh giờ", description: "Đã xác minh / Chưa xác minh.", catalog_dataset: null },
    ],
    filters: [
      {
        field: "app_user_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo UUID tài khoản nhân sự chấm công (employee_id).",
      },
      {
        field: "employee_code",
        type: "string",
        allowed_operators: ["eq", "contains"],
        description: "Lọc/tìm kiếm theo mã nhân viên hoặc tên nhân sự.",
      },
      {
        field: "time_verified",
        type: "boolean",
        allowed_operators: ["eq"],
        description: "Lọc theo trạng thái xác minh thời gian (true | false).",
      },
      {
        field: "distance_status",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo khoảng cách tới HQ: WITHIN_100M | OVER_100M | HQ_NOT_CONFIGURED.",
      },
    ],
    allowed_relations: [],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 200,
    },
    business_rules: [
      "Tọa độ GPS (latitude, longitude, accuracy_meters, address_hint) và ghi chú (note) là trường nhạy cảm; chỉ trả khi được yêu cầu tường minh trong fields.",
      "Ảnh chấm công không bao giờ trả hàng loạt trong /query; chỉ trả cờ has_photo.",
    ],
  },

  // =========================================================================
  // 5. VENDOR FINANCE DOMAIN (Tài chính Vendor)
  // =========================================================================
  {
    dataset: "vendor_finance_monthly_report",
    domain: "vendor_finance",
    title: "Báo cáo Tài chính Vendor theo Tháng (Nguyên tắc Sổ phụ Dự án + Kế toán)",
    description:
      "Báo cáo tài chính Vendor theo tháng (YYYY-MM), giữ nguyên độ hạt sổ phụ theo từng cặp (Dự án, Kế toán phụ trách, Vendor) và tách riêng sổ LEGACY_UNALLOCATED. Tuyệt đối không gộp bù trừ số dư giữa các kế toán khác nhau.",
    grain:
      "1 dòng trên mỗi sổ phụ (ledger_scope, project_id, responsible_accountant_user_id, vendor_id) trong tháng báo cáo.",
    canonical_source: {
      name: "public.vendor_finance_get_monthly_report",
      kind: "rpc",
      underlying_objects: [
        "public.vendor_finance_get_monthly_report",
        "public.vendor_finance_entries",
        "public.vendor_finance_reconciliations",
      ],
      subledger_grain: "(ledger_scope, project_id, responsible_accountant_user_id, vendor_id)",
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "month",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description:
        "Báo cáo theo kỳ tháng YYYY-MM (filter month hoặc suy ra từ date_range.from / ngày nghiệp vụ hiện tại).",
    },
    fields: [
      field("month", "string", "Tháng báo cáo (YYYY-MM)", { filterable: true, sortable: true }),
      field("ledger_scope", "string", "Phạm vi sổ: PROJECT_ACCOUNTANT | LEGACY_UNALLOCATED", {
        filterable: true,
        sortable: true,
      }),
      field("project_id", "string", "Mã dự án (null nếu là LEGACY_UNALLOCATED)", {
        filterable: true,
        sortable: true,
      }),
      field("project_display_name", "string", "Tên dự án", { sortable: true }),
      field("project_active", "boolean", "Trạng thái hoạt động của dự án"),
      field("accountant_ref", "string", "Mã tham chiếu kế toán phụ trách sổ phụ (UUID hoặc null nếu LEGACY_UNALLOCATED)", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_user_id", "string", "UUID kế toán phụ trách sổ phụ (null nếu là LEGACY_UNALLOCATED)", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_display_name", "string", "Tên kế toán phụ trách sổ phụ", {
        sortable: true,
      }),
      field("is_currently_assigned", "boolean", "True nếu kế toán đang được phân công hiện hành trên dự án"),
      field("vendor_id", "string", "Mã Vendor", {
        filterable: true,
        sortable: true,
      }),
      field("vendor_display_name", "string", "Tên hiển thị Vendor", { sortable: true }),
      field("vendor_active", "boolean", "Trạng thái hoạt động của Vendor"),
      field("balance_before_month_minor", "string", "Số dư trước đầu tháng của sổ phụ (VND; >0 phải trả Vendor, <0 đã ứng cho Vendor)", {
        sortable: true,
      }),
      field("opening_payable_in_month_minor", "string", "Số dư đầu kỳ phải trả khởi tạo trong tháng (VND)", {
        sortable: true,
      }),
      field("opening_advance_in_month_minor", "string", "Số dư đầu kỳ tạm ứng khởi tạo trong tháng (VND)", {
        sortable: true,
      }),
      field("obligations_in_month_minor", "string", "Phát sinh nghĩa vụ phải trả Vendor trong tháng (VND)", {
        sortable: true,
      }),
      field("paid_in_month_minor", "string", "Tổng tiền thanh toán công nợ cho Vendor trong tháng (VND)", {
        sortable: true,
      }),
      field("advanced_in_month_minor", "string", "Tổng tiền tạm ứng cho Vendor trong tháng (VND)", {
        sortable: true,
      }),
      field("paid_and_advanced_in_month_minor", "string", "Tổng tiền đã chi (thanh toán + tạm ứng) trong tháng (VND)", {
        sortable: true,
      }),
      field("net_change_in_month_minor", "string", "Biến động ròng số dư trong tháng (VND)", {
        sortable: true,
      }),
      field("closing_balance_minor", "string", "Số dư cuối tháng của sổ phụ (VND)", {
        sortable: true,
      }),
      field("closing_direction", "string", "Chiều số dư cuối tháng: PAYABLE | ADVANCE | SETTLED", {
        filterable: true,
        sortable: true,
      }),
      field("closing_payable_minor", "string", "Công nợ phải trả Vendor cuối tháng của đúng sổ phụ này (VND)", {
        sortable: true,
      }),
      field("closing_advance_minor", "string", "Số dư tạm ứng còn lại cuối tháng của đúng sổ phụ này (VND)", {
        sortable: true,
      }),
      field("current_balance_minor", "string", "Số dư hiện tại của sổ phụ (VND)", {
        sortable: true,
      }),
      field("in_month_entry_count", "integer", "Số bút toán phát sinh trong tháng"),
      field("total_entry_count", "integer", "Tổng số bút toán lũy kế của sổ phụ"),
    ],
    measures: [
      {
        name: "closing_payable_minor",
        type: "integer",
        label: "Công nợ phải trả cuối kỳ (theo từng sổ phụ)",
        formula: "GREATEST(closing_balance_minor, 0) tính riêng trên từng sổ phụ (project_id, responsible_accountant_user_id, vendor_id)",
        description: "Số tiền còn phải trả Vendor trên từng sổ phụ dự án + kế toán.",
        business_limits:
          "Nguyên tắc sổ phụ: chỉ tổng hợp trong phạm vi cùng (project_id, responsible_accountant_user_id) tại project_accountant_summaries; tuyệt đối không cấn trừ số dư dương của kế toán A với số dư âm của kế toán B.",
      },
      {
        name: "closing_advance_minor",
        type: "integer",
        label: "Số dư đã ứng cuối kỳ (theo từng sổ phụ)",
        formula: "GREATEST(-closing_balance_minor, 0) tính riêng trên từng sổ phụ (project_id, responsible_accountant_user_id, vendor_id)",
        description: "Số tiền đã tạm ứng vượt công nợ trên từng sổ phụ dự án + kế toán.",
        business_limits:
          "Nguyên tắc sổ phụ: không được bù trừ ngang giữa các kế toán khác nhau hoặc giữa sổ LEGACY_UNALLOCATED với sổ PROJECT_ACCOUNTANT.",
      },
    ],
    dimensions: [
      { name: "project", label: "Dự án", description: "Dự án của sổ phụ.", catalog_dataset: "catalog_projects" },
      { name: "accountant", label: "Kế toán phụ trách", description: "Kế toán phụ trách sổ phụ.", catalog_dataset: null },
      { name: "vendor", label: "Vendor", description: "Nhà cung ứng lao động.", catalog_dataset: "catalog_vendors" },
      { name: "ledger_scope", label: "Loại sổ phụ", description: "PROJECT_ACCOUNTANT hoặc LEGACY_UNALLOCATED.", catalog_dataset: null },
    ],
    filters: [
      {
        field: "month",
        type: "string",
        allowed_operators: ["eq"],
        description: "Tháng báo cáo định dạng YYYY-MM (ví dụ: 2026-10). Nếu không truyền sẽ lấy từ date_range.from hoặc tháng hiện tại.",
      },
      {
        field: "project_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo mã dự án.",
      },
      {
        field: "accountant_ref",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo UUID kế toán phụ trách (hoặc 'LEGACY_UNALLOCATED' để chỉ lấy sổ cũ chưa phân bổ).",
      },
      {
        field: "responsible_accountant_user_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Alias của accountant_ref: lọc theo UUID kế toán phụ trách.",
      },
      {
        field: "vendor_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo mã Vendor.",
      },
      {
        field: "ledger_scope",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo loại sổ: PROJECT_ACCOUNTANT | LEGACY_UNALLOCATED.",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "vendor_finance_entries",
        local_field: "vendor_id",
        target_field: "vendor_id",
        cardinality: "one_to_many",
        description: "Tra cứu các bút toán chi tiết của sổ phụ theo vendor_id, project_id và accountant_ref.",
      },
      {
        target_dataset: "vendor_finance_reconciliations",
        local_field: "vendor_id",
        target_field: "vendor_id",
        cardinality: "one_to_many",
        description: "Tra cứu lịch sử biên bản đối soát của sổ phụ.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 100,
      max_page_size: 500,
    },
    business_rules: [
      "NGUYÊN TẮC SỔ PHỤ BẮT BUỘC: Mỗi sổ phụ được định danh bởi (ledger_scope, project_id, responsible_accountant_user_id, vendor_id).",
      "Truy vấn toàn miền cho BoD trả nguyên vẹn từng sổ phụ và tổng hợp theo từng cặp (project_id, responsible_accountant_user_id) trong summary.project_accountant_summaries; TUYỆT ĐỐI KHÔNG gộp bù trừ số dư của các kế toán khác nhau.",
    ],
  },
  {
    dataset: "vendor_finance_subledgers",
    domain: "vendor_finance",
    title: "Danh sách Sổ phụ & Số dư Hiện hành theo Dự án / Kế toán / Vendor",
    description:
      "Trả danh sách các sổ phụ tài chính Vendor hiện hành theo từng cặp (Dự án, Kế toán phụ trách, Vendor) từ vendor_finance_list_vendors / vendor_finance_get_vendor, giữ nguyên số dư, công nợ, tạm ứng và đối soát gần nhất của từng sổ phụ.",
    grain:
      "1 dòng trên mỗi sổ phụ (ledger_scope, project_id, responsible_accountant_user_id, vendor_id).",
    canonical_source: {
      name: "public.vendor_finance_list_vendors",
      kind: "rpc",
      underlying_objects: [
        "public.vendor_finance_list_vendors",
        "public.vendor_finance_get_vendor",
      ],
      subledger_grain: "(ledger_scope, project_id, responsible_accountant_user_id, vendor_id)",
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "last_entry_business_date",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Phản ánh số dư sổ phụ hiện hành tính tới ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("vendor_id", "string", "Mã Vendor", { filterable: true, sortable: true }),
      field("vendor_display_name", "string", "Tên hiển thị Vendor", { sortable: true }),
      field("vendor_active", "boolean", "Trạng thái hoạt động của Vendor", { filterable: true }),
      field("ledger_scope", "string", "Loại sổ phụ: PROJECT_ACCOUNTANT | LEGACY_UNALLOCATED", {
        filterable: true,
        sortable: true,
      }),
      field("project_id", "string", "Mã dự án của sổ phụ", {
        filterable: true,
        sortable: true,
      }),
      field("project_display_name", "string", "Tên hiển thị dự án", { sortable: true }),
      field("accountant_ref", "string", "Mã tham chiếu kế toán phụ trách sổ phụ", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_user_id", "string", "UUID kế toán phụ trách sổ phụ", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_display_name", "string", "Tên hiển thị kế toán phụ trách", {
        sortable: true,
      }),
      field("has_opening_entry", "boolean", "True nếu sổ phụ đã có bút toán số dư đầu kỳ", {
        filterable: true,
      }),
      field("entry_count", "integer", "Tổng số bút toán trên sổ phụ", { sortable: true }),
      field("current_balance_minor", "string", "Số dư hiện tại của sổ phụ (VND; >0 phải trả, <0 đã ứng)", {
        sortable: true,
      }),
      field("payable_minor", "string", "Công nợ phải trả hiện tại của sổ phụ (VND)", {
        sortable: true,
      }),
      field("advance_minor", "string", "Số dư tạm ứng hiện tại của sổ phụ (VND)", {
        sortable: true,
      }),
      field("balance_direction", "string", "Chiều số dư của sổ phụ: PAYABLE | ADVANCE | SETTLED", {
        filterable: true,
        sortable: true,
      }),
      field("balance_state", "string", "Trạng thái số dư của sổ phụ: PAYABLE | ADVANCE | SETTLED", {
        filterable: true,
        sortable: true,
      }),
      field("last_reconciled_as_of_date", "date", "Ngày chốt đối soát gần nhất trên sổ phụ", {
        sortable: true,
      }),
    ],
    measures: [
      {
        name: "subledger_count",
        type: "integer",
        label: "Số lượng sổ phụ",
        formula: "COUNT(*) các sổ phụ khớp bộ lọc",
        description: "Tổng số sổ phụ (Dự án + Kế toán + Vendor) trong phạm vi lọc.",
        business_limits: "Không gộp bù trừ số dư giữa các sổ phụ của các kế toán khác nhau.",
      },
    ],
    dimensions: [
      { name: "project", label: "Dự án", description: "Theo dự án.", catalog_dataset: "catalog_projects" },
      { name: "accountant", label: "Kế toán phụ trách", description: "Theo kế toán phụ trách sổ phụ.", catalog_dataset: null },
      { name: "vendor", label: "Vendor", description: "Theo Vendor.", catalog_dataset: "catalog_vendors" },
    ],
    filters: [
      { field: "vendor_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo mã Vendor." },
      { field: "project_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo mã dự án." },
      { field: "accountant_ref", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID kế toán phụ trách hoặc 'LEGACY_UNALLOCATED'." },
      { field: "responsible_accountant_user_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID kế toán phụ trách." },
      { field: "ledger_scope", type: "string", allowed_operators: ["eq"], description: "PROJECT_ACCOUNTANT | LEGACY_UNALLOCATED." },
      { field: "balance_state", type: "string", allowed_operators: ["eq"], description: "UNINITIALIZED | PAYABLE | ADVANCE | SETTLED." },
      { field: "include_inactive", type: "boolean", allowed_operators: ["eq"], description: "Có bao gồm Vendor ngưng hoạt động hay không (mặc định true cho BoD)." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm kiếm theo tên hoặc mã Vendor." },
    ],
    allowed_relations: [
      {
        target_dataset: "vendor_finance_entries",
        local_field: "vendor_id",
        target_field: "vendor_id",
        cardinality: "one_to_many",
        description: "Xem danh sách bút toán sổ phụ.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 100,
      max_page_size: 500,
    },
    business_rules: [
      "Giữ nguyên nguyên tắc sổ phụ: không trả số dư gộp toàn công ty cấp Vendor bằng cách bù trừ giữa các kế toán khác nhau.",
    ],
  },
  {
    dataset: "vendor_finance_entries",
    domain: "vendor_finance",
    title: "Sổ cái Bút toán Tài chính Vendor (Theo Sổ phụ Dự án / Kế toán)",
    description:
      "Danh sách bút toán bất biến (append-only ledger entries) của Vendor theo sổ phụ dự án và kế toán phụ trách, hỗ trợ lọc theo loại bút toán, khoảng ngày nghiệp vụ và phân trang keyset cursor.",
    grain: "1 dòng trên mỗi bút toán (entry_id) thuộc một sổ phụ (vendor_id, ledger_scope, project_id, responsible_accountant_user_id).",
    canonical_source: {
      name: "public.vendor_finance_list_vendor_entries",
      kind: "rpc",
      underlying_objects: [
        "public.vendor_finance_list_vendor_entries",
        "public.vendor_finance_entries",
      ],
      subledger_grain: "(ledger_scope, project_id, responsible_accountant_user_id, vendor_id)",
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "business_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Lọc theo ngày nghiệp vụ bút toán (business_date).",
    },
    fields: [
      field("entry_id", "string", "UUID bút toán", { filterable: true }),
      field("vendor_id", "string", "Mã Vendor", { filterable: true, sortable: true }),
      field("ledger_scope", "string", "Phạm vi sổ phụ: PROJECT_ACCOUNTANT | LEGACY_UNALLOCATED", {
        filterable: true,
      }),
      field("project_id", "string", "Mã dự án của sổ phụ", { filterable: true, sortable: true }),
      field("project_display_name_snapshot", "string", "Tên dự án tại thời điểm ghi sổ"),
      field("accountant_ref", "string", "Mã tham chiếu kế toán phụ trách sổ phụ", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_user_id", "string", "UUID kế toán phụ trách sổ phụ", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_display_name_snapshot", "string", "Tên kế toán phụ trách tại thời điểm ghi sổ"),
      field("cursor_sequence", "integer", "Số thứ tự con trỏ toàn cục của bút toán", {
        sortable: true,
      }),
      field("vendor_sequence", "integer", "Số thứ tự liên tiếp của bút toán trong sổ phụ", {
        sortable: true,
      }),
      field("document_no", "string", "Số chứng từ"),
      field("document_kind", "string", "Loại chứng từ"),
      field("entry_type", "string", "Loại bút toán: OPENING_PAYABLE | OPENING_ADVANCE | PAYABLE_INCREASE | ADVANCE_OUT | PAYMENT_OUT | REFUND_IN | ADJUSTMENT_INCREASE | ADJUSTMENT_DECREASE | REVERSAL", {
        filterable: true,
        sortable: true,
      }),
      field("amount_minor", "string", "Số tiền tuyệt đối của bút toán (VND, luôn > 0)", {
        sortable: true,
      }),
      field("balance_delta_minor", "string", "Biến động số dư sổ phụ do bút toán tạo ra (VND)", {
        sortable: true,
      }),
      field("balance_before_minor", "string", "Số dư sổ phụ trước bút toán (VND)"),
      field("balance_after_minor", "string", "Số dư sổ phụ sau bút toán (VND)"),
      field("effective_date", "date", "Ngày hiệu lực của bút toán (YYYY-MM-DD)"),
      field("business_date", "date", "Ngày nghiệp vụ của bút toán (YYYY-MM-DD)", {
        filterable: true,
        sortable: true,
      }),
      field("reverses_entry_id", "string", "UUID bút toán gốc bị đảo (nếu entry_type = REVERSAL)"),
      field("reversed_by_entry_id", "string", "UUID bút toán đảo đã hủy bút toán này (nếu có)"),
      field("created_by_display_name", "string", "Tên người tạo bút toán"),
      field("created_at", "datetime", "Thời điểm ghi sổ (UTC ISO-8601)", { sortable: true }),
      field("has_evidence", "boolean", "True nếu bút toán có chứng từ đính kèm (không trả tệp hàng loạt)"),
      field("reason", "string", "Lý do / diễn giải tự do của bút toán (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "free_text",
      }),
    ],
    measures: [],
    dimensions: [
      { name: "entry_type", label: "Loại bút toán", description: "Phân loại nghiệp vụ bút toán.", catalog_dataset: null },
      { name: "project", label: "Dự án", description: "Dự án của sổ phụ.", catalog_dataset: "catalog_projects" },
      { name: "accountant", label: "Kế toán phụ trách", description: "Kế toán phụ trách sổ phụ.", catalog_dataset: null },
    ],
    filters: [
      {
        field: "vendor_id",
        type: "string",
        allowed_operators: ["eq"],
        required: true,
        description: "Mã Vendor cần tra cứu bút toán (bắt buộc).",
      },
      {
        field: "project_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo mã dự án của sổ phụ.",
      },
      {
        field: "accountant_ref",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo UUID kế toán phụ trách hoặc 'LEGACY_UNALLOCATED'.",
      },
      {
        field: "entry_type",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo loại bút toán.",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "vendor_finance_subledgers",
        local_field: "vendor_id",
        target_field: "vendor_id",
        cardinality: "many_to_one",
        description: "Xem tổng quan các sổ phụ của cùng Vendor.",
      },
    ],
    pagination: {
      strategy: "keyset_cursor",
      default_page_size: 50,
      max_page_size: 200,
    },
    business_rules: [
      "Bắt buộc truyền filter vendor_id.",
      "Chuỗi balance_before_minor -> balance_after_minor và vendor_sequence được tính độc lập trên từng sổ phụ (ledger_scope, project_id, responsible_accountant_user_id, vendor_id).",
      "Trường reason (diễn giải tự do) chỉ trả khi được yêu cầu trong fields; chứng từ chỉ trả cờ has_evidence.",
    ],
  },
  {
    dataset: "vendor_finance_reconciliations",
    domain: "vendor_finance",
    title: "Lịch sử Đối soát Công nợ Vendor (Theo Sổ phụ Dự án / Kế toán)",
    description:
      "Danh sách các bản ghi đối soát công nợ của Vendor theo đúng sổ phụ dự án và kế toán phụ trách.",
    grain: "1 dòng trên mỗi bản ghi đối soát (reconciliation_id) của một sổ phụ.",
    canonical_source: {
      name: "public.vendor_finance_list_vendor_reconciliations",
      kind: "rpc",
      underlying_objects: [
        "public.vendor_finance_list_vendor_reconciliations",
        "public.vendor_finance_reconciliations",
      ],
      subledger_grain: "(ledger_scope, project_id, responsible_accountant_user_id, vendor_id)",
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "as_of_date",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Theo ngày chốt đối soát as_of_date (YYYY-MM-DD) và thời điểm tạo created_at.",
    },
    fields: [
      field("reconciliation_id", "string", "UUID bản ghi đối soát"),
      field("vendor_id", "string", "Mã Vendor", { filterable: true, sortable: true }),
      field("ledger_scope", "string", "Phạm vi sổ phụ: PROJECT_ACCOUNTANT | LEGACY_UNALLOCATED", {
        filterable: true,
      }),
      field("project_id", "string", "Mã dự án của sổ phụ", { filterable: true, sortable: true }),
      field("project_display_name_snapshot", "string", "Tên dự án tại thời điểm đối soát"),
      field("accountant_ref", "string", "Mã tham chiếu kế toán phụ trách sổ phụ", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_user_id", "string", "UUID kế toán phụ trách sổ phụ", {
        filterable: true,
        sortable: true,
      }),
      field("responsible_accountant_display_name_snapshot", "string", "Tên kế toán phụ trách tại thời điểm đối soát"),
      field("as_of_date", "date", "Ngày chốt đối soát (YYYY-MM-DD)", {
        filterable: true,
        sortable: true,
      }),
      field("ledger_sequence_at_reconciliation", "integer", "Số thứ tự bút toán chốt sổ phụ tại thời điểm đối soát"),
      field("system_balance_minor", "string", "Số dư trên hệ thống của sổ phụ (VND)"),
      field("confirmed_balance_minor", "string", "Số dư đối soát đã xác nhận (VND)"),
      field("difference_minor", "string", "Chênh lệch đối soát (VND)"),
      field("created_by_display_name", "string", "Tên người tạo bản ghi đối soát"),
      field("created_at", "datetime", "Thời điểm tạo bản ghi đối soát", { sortable: true }),
      field("has_evidence", "boolean", "True nếu có chứng từ đối soát đính kèm"),
      field("reason", "string", "Ghi chú / lý do đối soát (nhạy cảm: chỉ trả khi yêu cầu tường minh trong fields)", {
        sensitive: true,
        sensitivity_class: "free_text",
      }),
    ],
    measures: [],
    dimensions: [],
    filters: [
      {
        field: "vendor_id",
        type: "string",
        allowed_operators: ["eq"],
        required: true,
        description: "Mã Vendor cần xem lịch sử đối soát (bắt buộc).",
      },
      {
        field: "project_id",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo mã dự án của sổ phụ.",
      },
      {
        field: "accountant_ref",
        type: "string",
        allowed_operators: ["eq"],
        description: "Lọc theo UUID kế toán phụ trách hoặc 'LEGACY_UNALLOCATED'.",
      },
      {
        field: "as_of_date",
        type: "date",
        allowed_operators: ["eq", "gte", "lte"],
        description: "Lọc theo ngày chốt đối soát YYYY-MM-DD.",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "vendor_finance_monthly_report",
        local_field: "vendor_id",
        target_field: "vendor_id",
        cardinality: "many_to_one",
        description: "Xem báo cáo tháng tương ứng.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [
      "Bắt buộc truyền filter vendor_id.",
      "Đối soát được thực hiện độc lập trên từng sổ phụ (Dự án + Kế toán phụ trách + Vendor).",
    ],
  },

  // =========================================================================
  // 6. DATA QUALITY DOMAIN (Chất lượng dữ liệu)
  // =========================================================================
  {
    dataset: "data_quality_pipeline",
    domain: "data_quality",
    title: "Chất lượng Dữ liệu & Trạng thái Đồng bộ Nguồn (Pipeline Health)",
    description:
      "Trạng thái các nguồn dữ liệu (data_sources), lần đồng bộ gần nhất (sync_runs), độ mới dữ liệu, số dòng hợp lệ/cảnh báo/từ chối và danh sách mã lỗi đồng bộ (sync_errors, không kèm raw payload PII).",
    grain: "1 dòng trên mỗi nguồn dữ liệu (source_id).",
    canonical_source: {
      name: "reporting.pipeline_check",
      kind: "read_model",
      underlying_objects: [
        "public.data_sources",
        "public.sync_runs",
        "public.sync_errors",
        "public.daily_recruitment_breakdown",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "last_successful_sync_at",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Phản ánh trạng thái đồng bộ mới nhất tại thời điểm truy vấn.",
    },
    fields: [
      field("source_id", "string", "UUID nguồn dữ liệu", { filterable: true }),
      field("drive_file_id", "string", "Mã tệp Google Drive nguồn", { filterable: true, sortable: true }),
      field("file_name", "string", "Tên tệp nguồn dữ liệu", { sortable: true }),
      field("sheet_name", "string", "Tên sheet dữ liệu"),
      field("active", "boolean", "Trạng thái kích hoạt của nguồn", {
        filterable: true,
        sortable: true,
      }),
      field("last_seen_at", "datetime", "Thời điểm phát hiện nguồn gần nhất"),
      field("last_successful_sync_at", "datetime", "Thời điểm đồng bộ thành công gần nhất", {
        sortable: true,
      }),
      field("latest_run_id", "string", "UUID lần chạy đồng bộ gần nhất"),
      field("latest_run_status", "string", "Trạng thái lần chạy gần nhất: succeeded | partial | failed | running", {
        filterable: true,
        sortable: true,
      }),
      field("latest_run_finished_at", "datetime", "Thời điểm hoàn tất lần đồng bộ gần nhất", {
        sortable: true,
      }),
      field("rows_read", "integer", "Số dòng đọc từ nguồn trong lần chạy gần nhất"),
      field("rows_valid", "integer", "Số dòng hợp lệ trong lần chạy gần nhất"),
      field("rows_warned", "integer", "Số dòng có cảnh báo trong lần chạy gần nhất"),
      field("rows_rejected", "integer", "Số dòng bị từ chối trong lần chạy gần nhất"),
      field("recent_error_count", "integer", "Số lỗi đồng bộ gần nhất ghi nhận cho nguồn này", {
        sortable: true,
      }),
      field("recent_error_codes", "json", "Danh sách mã lỗi đồng bộ gần nhất (đã loại bỏ raw_payload)"),
    ],
    measures: [
      {
        name: "active_source_count",
        type: "integer",
        label: "Số nguồn dữ liệu hoạt động",
        formula: "COUNT(*) WHERE active = true",
        description: "Tổng số nguồn dữ liệu đang hoạt động.",
        business_limits: "Tính trên các nguồn chính thức.",
      },
      {
        name: "recent_sync_error_count",
        type: "integer",
        label: "Số lượng lỗi đồng bộ gần nhất",
        formula: "COUNT(sync_errors) trong tập giám sát gần nhất",
        description: "Số dòng lỗi đồng bộ ghi nhận gần nhất.",
        business_limits: "Giới hạn tối đa 25 lỗi gần nhất trên read model.",
      },
    ],
    dimensions: [
      { name: "drive_file_id", label: "Nguồn dữ liệu", description: "Theo mã tệp nguồn đồng bộ.", catalog_dataset: null },
      { name: "latest_run_status", label: "Trạng thái đồng bộ", description: "Trạng thái lần đồng bộ cuối.", catalog_dataset: null },
    ],
    filters: [
      { field: "drive_file_id", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo mã tệp nguồn dữ liệu." },
      { field: "active", type: "boolean", allowed_operators: ["eq"], description: "Lọc theo trạng thái kích hoạt nguồn." },
      { field: "latest_run_status", type: "string", allowed_operators: ["eq"], description: "Lọc theo trạng thái lần chạy đồng bộ gần nhất." },
    ],
    allowed_relations: [],
    pagination: {
      strategy: "cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [
      "Không bao giờ trả raw_payload của sync_errors để tránh lộ dữ liệu cá nhân trong các dòng lỗi.",
    ],
  },
  {
    dataset: "data_quality_cccd_reconciliation",
    domain: "data_quality",
    title: "Chất lượng Dữ liệu & Hàng đợi Đối soát QR CCCD",
    description:
      "Thống kê và danh sách các hồ sơ đợt làm việc cần đối soát hoặc bị lệch giữa thông tin CCCD nhập tay và dữ liệu giải mã từ mã QR trên ảnh CCCD (direct_entry_list_cccd_review_queue).",
    grain: "1 dòng trên mỗi đợt làm việc (entry_id) trong hàng đợi đối soát CCCD.",
    canonical_source: {
      name: "public.direct_entry_list_cccd_review_queue",
      kind: "rpc",
      underlying_objects: [
        "public.direct_entry_list_cccd_review_queue",
        "public.direct_entry_cccd_reconciliations",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "first_work_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Phản ánh trạng thái đối soát QR CCCD hiện hành, sắp xếp theo thời điểm cập nhật.",
    },
    fields: [
      field("entry_id", "string", "UUID đợt làm việc", { filterable: true }),
      field("submission_id", "string", "UUID lô nộp"),
      field("submission_state", "string", "Trạng thái lô nộp"),
      field("employee_code", "string", "Mã nhân viên", { filterable: true, sortable: true }),
      field("display_name", "string", "Họ và tên nhập trên hồ sơ", {
        filterable: true,
        sortable: true,
      }),
      field("project_id", "string", "Mã dự án", { filterable: true, sortable: true }),
      field("project_name", "string", "Tên dự án", { sortable: true }),
      field("recruiter_id", "string", "UUID người tuyển", { filterable: true }),
      field("recruiter_name", "string", "Tên người tuyển", { sortable: true }),
      field("team_id", "string", "UUID nhóm tuyển dụng", { filterable: true }),
      field("team_name", "string", "Tên nhóm tuyển dụng", { sortable: true }),
      field("provider_type", "string", "Kênh cung ứng ('hrp' | 'vendor')", {
        filterable: true,
      }),
      field("labor_type", "string", "Mã loại lao động", { filterable: true }),
      field("first_work_date", "date", "Ngày vào làm", { filterable: true, sortable: true }),
      field("reconciliation_status", "string", "Trạng thái đối soát: MISMATCH | QR_UNREADABLE | PENDING | MATCHED_INITIAL | RESOLVED_FROM_QR | RESOLVED_KEEP_ENTERED | RESOLVED_MANUAL", {
        filterable: true,
        sortable: true,
      }),
      field("qr_status", "string", "Trạng thái bóc tách QR: SUCCEEDED | NO_QR_FOUND | FAILED | PENDING", {
        filterable: true,
      }),
      field("qr_error_code", "string", "Mã lỗi bóc tách QR (nếu có)"),
      field("entered_national_id_masked", "string", "Số CCCD nhập tay đã che (••••••••1234)"),
      field("qr_national_id_masked", "string", "Số CCCD đọc từ QR đã che (••••••••1234)"),
      field("entered_national_id", "string", "Số CCCD nhập tay đầy đủ (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_national_id",
      }),
      field("qr_national_id", "string", "Số CCCD đọc từ QR đầy đủ (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_national_id",
      }),
      field("entered_phone", "string", "Số điện thoại nhập tay (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_phone",
      }),
      field("entered_address", "string", "Địa chỉ nhập tay (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_personal",
      }),
      field("qr_display_name", "string", "Họ và tên đọc từ mã QR"),
      field("qr_address", "string", "Địa chỉ đọc từ mã QR (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "pii_personal",
      }),
      field("resolved_action", "string", "Hành động xử lý đối soát (nếu đã xử lý)"),
      field("resolved_at", "datetime", "Thời điểm xử lý đối soát"),
      field("resolution_reason", "string", "Ghi chú lý do xử lý (nhạy cảm: chỉ trả khi yêu cầu tường minh)", {
        sensitive: true,
        sensitivity_class: "free_text",
      }),
      field("updated_at", "datetime", "Thời điểm cập nhật gần nhất", { sortable: true }),
    ],
    measures: [
      {
        name: "total_count",
        type: "integer",
        label: "Tổng số hồ sơ có đối soát CCCD",
        formula: "summary.total_count từ public.direct_entry_list_cccd_review_queue",
        description: "Tổng số hồ sơ trong phạm vi theo dõi đối soát QR CCCD.",
        business_limits: "Tính trên phạm vi toàn miền BoD.",
      },
      {
        name: "needs_review_count",
        type: "integer",
        label: "Số hồ sơ cần rà soát CCCD (MISMATCH + QR_UNREADABLE)",
        formula: "summary.needs_review_count",
        description: "Tổng số hồ sơ bị lệch thông tin CCCD hoặc ảnh không đọc được QR.",
        business_limits: "Tương ứng với bộ lọc status_filter = 'NEEDS_REVIEW'.",
      },
      {
        name: "mismatch_count",
        type: "integer",
        label: "Số hồ sơ lệch CCCD giữa nhập tay và QR",
        formula: "summary.mismatch_count",
        description: "Số hồ sơ đọc được QR nhưng lệch với thông tin nhập tay.",
        business_limits: "Tương ứng với status_filter = 'MISMATCH'.",
      },
      {
        name: "qr_unreadable_count",
        type: "integer",
        label: "Số hồ sơ không đọc được mã QR CCCD",
        formula: "summary.qr_unreadable_count",
        description: "Số hồ sơ đã tải ảnh CCCD nhưng không giải mã được QR.",
        business_limits: "Tương ứng với status_filter = 'QR_UNREADABLE'.",
      },
    ],
    dimensions: [
      { name: "reconciliation_status", label: "Trạng thái đối soát CCCD", description: "Phân loại kết quả đối soát QR.", catalog_dataset: null },
      { name: "project", label: "Dự án", description: "Theo dự án.", catalog_dataset: "catalog_projects" },
      { name: "recruiter", label: "Người tuyển", description: "Theo người tuyển.", catalog_dataset: "catalog_recruiters" },
    ],
    filters: [
      {
        field: "status_filter",
        type: "string",
        allowed_operators: ["eq"],
        description:
          "Bộ lọc trạng thái hàng đợi chuẩn: NEEDS_REVIEW (mặc định) | MISMATCH | QR_UNREADABLE | PENDING | MATCHED_INITIAL | RESOLVED | ALL.",
      },
      { field: "project_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo mã dự án." },
      { field: "recruiter_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID người tuyển." },
      { field: "team_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID nhóm." },
    ],
    allowed_relations: [
      {
        target_dataset: "workers_profile_detail",
        local_field: "entry_id",
        target_field: "entry_id",
        cardinality: "one_to_one",
        description: "Xem chi tiết hồ sơ đợt làm việc.",
      },
    ],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [
      "Mặc định chỉ trả số CCCD đã che (entered_national_id_masked, qr_national_id_masked).",
      "Không trả tệp ảnh CCCD trong /query; chỉ trả trạng thái bóc tách và đối soát.",
    ],
  },

  // =========================================================================
  // 7. BUSINESS CATALOGS DOMAIN (Catalog nghiệp vụ cần để lọc)
  // =========================================================================
  {
    dataset: "catalog_projects",
    domain: "catalogs",
    title: "Danh mục Dự án (Projects Catalog)",
    description:
      "Danh mục dự án chuẩn dùng để tra cứu project_id, tên hiển thị, trạng thái hoạt động và số lượng quản lý dự án hiện hành.",
    grain: "1 dòng trên mỗi dự án (project_id).",
    canonical_source: {
      name: "public.direct_entry_list_projects_admin",
      kind: "rpc",
      underlying_objects: ["public.direct_entry_list_projects_admin"],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: null,
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Danh mục hiện hành tại ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("project_id", "string", "Mã dự án chuẩn", { filterable: true, sortable: true }),
      field("display_name", "string", "Tên hiển thị dự án", {
        filterable: true,
        sortable: true,
      }),
      field("active", "boolean", "Trạng thái đang hoạt động", {
        filterable: true,
        sortable: true,
      }),
      field("version", "integer", "Phiên bản bản ghi dự án"),
      field("current_manager_count", "integer", "Số quản lý dự án đang được phân công hiệu lực", {
        sortable: true,
      }),
      field("current_managers", "json", "Danh sách quản lý dự án hiện hành (recruiter_id, display_name, valid_from)"),
    ],
    measures: [
      {
        name: "total_projects",
        type: "integer",
        label: "Tổng số dự án",
        formula: "COUNT(*) dự án khớp bộ lọc",
        description: "Tổng số dự án trong danh mục.",
        business_limits: "Mặc định bao gồm cả dự án đang hoạt động và ngưng hoạt động nếu include_inactive=true.",
      },
    ],
    dimensions: [],
    filters: [
      { field: "project_id", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo mã dự án." },
      { field: "active", type: "boolean", allowed_operators: ["eq"], description: "Lọc theo trạng thái hoạt động (true | false)." },
      { field: "include_inactive", type: "boolean", allowed_operators: ["eq"], description: "Có lấy dự án không hoạt động hay không (mặc định true)." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm theo tên hoặc mã dự án." },
    ],
    allowed_relations: [
      {
        target_dataset: "catalog_project_team_scopes",
        local_field: "project_id",
        target_field: "project_id",
        cardinality: "one_to_many",
        description: "Tra cứu các nhóm tuyển dụng được phân quyền vào dự án.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 100,
      max_page_size: 200,
    },
    business_rules: [],
  },
  {
    dataset: "catalog_teams",
    domain: "catalogs",
    title: "Danh mục Nhóm Tuyển dụng (Teams Catalog)",
    description: "Danh mục nhóm tuyển dụng chuẩn dùng để tra cứu team_id, mã nhóm (code) và tên hiển thị.",
    grain: "1 dòng trên mỗi nhóm tuyển dụng (team_id).",
    canonical_source: {
      name: "public.direct_entry_list_teams_admin",
      kind: "rpc",
      underlying_objects: ["public.direct_entry_list_teams_admin"],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: null,
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Danh mục nhóm hiện hành tại ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("team_id", "string", "UUID nhóm tuyển dụng", { filterable: true, sortable: true }),
      field("code", "string", "Mã nhóm chuẩn", { filterable: true, sortable: true }),
      field("display_name", "string", "Tên hiển thị của nhóm", {
        filterable: true,
        sortable: true,
      }),
      field("active", "boolean", "Trạng thái hoạt động", { filterable: true, sortable: true }),
      field("version", "integer", "Phiên bản bản ghi"),
      field("revision_count", "integer", "Số lần cập nhật"),
    ],
    measures: [
      {
        name: "total_teams",
        type: "integer",
        label: "Tổng số nhóm",
        formula: "total từ public.direct_entry_list_teams_admin",
        description: "Tổng số nhóm tuyển dụng khớp bộ lọc.",
        business_limits: "Không bao gồm nhóm hệ thống ẩn __system_vendor__.",
      },
    ],
    dimensions: [],
    filters: [
      { field: "team_id", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo UUID nhóm." },
      { field: "code", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo mã nhóm." },
      { field: "active", type: "boolean", allowed_operators: ["eq"], description: "Lọc theo trạng thái hoạt động." },
      { field: "include_inactive", type: "boolean", allowed_operators: ["eq"], description: "Có bao gồm nhóm ngưng hoạt động hay không (mặc định true)." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm kiếm theo tên hoặc mã nhóm." },
    ],
    allowed_relations: [
      {
        target_dataset: "catalog_project_team_scopes",
        local_field: "team_id",
        target_field: "team_id",
        cardinality: "one_to_many",
        description: "Tra cứu các dự án mà nhóm được phép tuyển dụng.",
      },
    ],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [],
  },
  {
    dataset: "catalog_project_team_scopes",
    domain: "catalogs",
    title: "Danh mục Phân quyền Dự án ↔ Nhóm (Project-Team Scopes)",
    description: "Ánh xạ phân quyền giữa Dự án (project_id) và Nhóm tuyển dụng (team_id).",
    grain: "1 dòng trên mỗi ánh xạ phân quyền (mapping_id).",
    canonical_source: {
      name: "public.direct_entry_list_project_team_scopes_admin",
      kind: "rpc",
      underlying_objects: ["public.direct_entry_list_project_team_scopes_admin"],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "valid_from",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Phản ánh trạng thái phân quyền dự án - nhóm tại ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("mapping_id", "string", "UUID bản ghi phân quyền"),
      field("project_id", "string", "Mã dự án", { filterable: true, sortable: true }),
      field("project_display_name", "string", "Tên dự án", { sortable: true }),
      field("project_active", "boolean", "Trạng thái hoạt động của dự án"),
      field("team_id", "string", "UUID nhóm", { filterable: true, sortable: true }),
      field("team_code", "string", "Mã nhóm", { sortable: true }),
      field("team_display_name", "string", "Tên nhóm", { sortable: true }),
      field("team_active", "boolean", "Trạng thái hoạt động của nhóm"),
      field("valid_from", "date", "Ngày bắt đầu hiệu lực", { sortable: true }),
      field("valid_to", "date", "Ngày kết thúc hiệu lực (null nếu không thời hạn)"),
      field("status", "string", "Trạng thái hiệu lực: EFFECTIVE | SCHEDULED | ENDED | REVOKED | INACTIVE_PARENT", {
        filterable: true,
        sortable: true,
      }),
    ],
    measures: [
      {
        name: "total_mappings",
        type: "integer",
        label: "Tổng số ánh xạ Dự án - Nhóm",
        formula: "total từ public.direct_entry_list_project_team_scopes_admin",
        description: "Tổng số bản ghi phân quyền khớp bộ lọc.",
        business_limits: "Mặc định chỉ lấy các bản ghi đang hiệu lực trừ khi đặt include_history=true.",
      },
    ],
    dimensions: [],
    filters: [
      { field: "project_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo mã dự án." },
      { field: "team_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID nhóm." },
      { field: "include_history", type: "boolean", allowed_operators: ["eq"], description: "Có bao gồm lịch sử đã thu hồi/hết hạn hay không (mặc định false)." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm theo tên/mã dự án hoặc nhóm." },
    ],
    allowed_relations: [],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [],
  },
  {
    dataset: "catalog_recruiters",
    domain: "catalogs",
    title: "Danh mục Người tuyển / Nhân sự Tuyển dụng (Recruiters Catalog)",
    description:
      "Danh mục nhân sự tuyển dụng nội bộ HRP dùng để tra cứu recruiter_id, mã nhân viên (personnel_code), chức danh, nhóm trực thuộc và trạng thái hoạt động.",
    grain: "1 dòng trên mỗi nhân sự tuyển dụng (recruiter_id).",
    canonical_source: {
      name: "public.direct_entry_list_personnel_admin",
      kind: "rpc",
      underlying_objects: ["public.direct_entry_list_personnel_admin"],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: null,
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Danh mục nhân sự tuyển dụng tại ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("recruiter_id", "string", "UUID người tuyển", { filterable: true, sortable: true }),
      field("personnel_code", "string", "Mã nhân sự chuẩn", {
        filterable: true,
        sortable: true,
      }),
      field("display_name", "string", "Họ và tên người tuyển", {
        filterable: true,
        sortable: true,
      }),
      field("personnel_position", "string", "Vị trí công việc", {
        filterable: true,
        sortable: true,
      }),
      field("active", "boolean", "Trạng thái hoạt động", { filterable: true, sortable: true }),
      field("provider_type", "string", "Kênh cung ứng ('hrp')"),
      field("provider_valid_from", "date", "Ngày bắt đầu hiệu lực kênh"),
      field("team_names", "json", "Danh sách tên nhóm tuyển dụng đang tham gia"),
      field("version", "integer", "Phiên bản bản ghi"),
    ],
    measures: [
      {
        name: "total_recruiters",
        type: "integer",
        label: "Tổng số nhân sự tuyển dụng",
        formula: "total từ public.direct_entry_list_personnel_admin",
        description: "Tổng số nhân sự tuyển dụng khớp bộ lọc.",
        business_limits: "Chỉ bao gồm nhân sự tuyển dụng HRP (Vendor nằm ở catalog_vendors).",
      },
    ],
    dimensions: [],
    filters: [
      { field: "recruiter_id", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo UUID người tuyển." },
      { field: "personnel_code", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo mã nhân sự." },
      { field: "personnel_position", type: "string", allowed_operators: ["eq"], description: "Lọc theo vị trí công việc." },
      { field: "active", type: "boolean", allowed_operators: ["eq"], description: "Lọc theo trạng thái hoạt động." },
      { field: "include_inactive", type: "boolean", allowed_operators: ["eq"], description: "Có bao gồm nhân sự ngưng hoạt động hay không (mặc định true)." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm theo tên hoặc mã nhân sự." },
    ],
    allowed_relations: [],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [],
  },
  {
    dataset: "catalog_vendors",
    domain: "catalogs",
    title: "Danh mục Nhà cung ứng Lao động (Vendors Catalog)",
    description:
      "Danh mục Vendor dùng để tra cứu vendor_id, tên hiển thị, trạng thái hoạt động và recruiter_id đại diện trên hệ thống Direct Entry.",
    grain: "1 dòng trên mỗi Vendor (vendor_id).",
    canonical_source: {
      name: "public.direct_entry_list_vendors_admin",
      kind: "rpc",
      underlying_objects: ["public.direct_entry_list_vendors_admin"],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: null,
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Danh mục Vendor hiện hành tại ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("vendor_id", "string", "Mã Vendor chuẩn", { filterable: true, sortable: true }),
      field("display_name", "string", "Tên hiển thị của Vendor", {
        filterable: true,
        sortable: true,
      }),
      field("active", "boolean", "Trạng thái hoạt động", { filterable: true, sortable: true }),
      field("recruiter_id", "string", "UUID bản ghi recruiter đại diện cho Vendor trong bảng đợt làm việc", {
        filterable: true,
      }),
      field("version", "integer", "Phiên bản bản ghi"),
      field("revision_count", "integer", "Số lần cập nhật"),
    ],
    measures: [
      {
        name: "total_vendors",
        type: "integer",
        label: "Tổng số Vendor",
        formula: "total từ public.direct_entry_list_vendors_admin",
        description: "Tổng số Vendor khớp bộ lọc.",
        business_limits: "Không bao gồm bản ghi hệ thống __system_vendor__.",
      },
    ],
    dimensions: [],
    filters: [
      { field: "vendor_id", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo mã Vendor." },
      { field: "active", type: "boolean", allowed_operators: ["eq"], description: "Lọc theo trạng thái hoạt động." },
      { field: "include_inactive", type: "boolean", allowed_operators: ["eq"], description: "Có bao gồm Vendor ngưng hoạt động hay không (mặc định true)." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm theo tên hoặc mã Vendor." },
    ],
    allowed_relations: [
      {
        target_dataset: "vendor_finance_subledgers",
        local_field: "vendor_id",
        target_field: "vendor_id",
        cardinality: "one_to_many",
        description: "Tra cứu các sổ phụ tài chính của Vendor.",
      },
    ],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [],
  },
  {
    dataset: "catalog_labor_types",
    domain: "catalogs",
    title: "Danh mục Loại hình Lao động (Labor Types Catalog)",
    description:
      "Danh mục loại hình lao động chuẩn dùng để lọc và giải nghĩa labor_type_key, reporting_key và thứ tự hiển thị.",
    grain: "1 dòng trên mỗi loại hình lao động (labor_type_key).",
    canonical_source: {
      name: "public.direct_entry_list_labor_types_admin",
      kind: "rpc",
      underlying_objects: ["public.direct_entry_list_labor_types_admin"],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: null,
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Danh mục loại hình lao động tại ngày nghiệp vụ authorization_date.",
    },
    fields: [
      field("labor_type_key", "string", "Mã loại hình lao động", {
        filterable: true,
        sortable: true,
      }),
      field("reporting_key", "string", "Khóa chuẩn hóa trên báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("display_name", "string", "Tên hiển thị loại hình lao động", {
        filterable: true,
        sortable: true,
      }),
      field("active", "boolean", "Trạng thái hoạt động", { filterable: true, sortable: true }),
      field("sort_order", "integer", "Thứ tự sắp xếp", { sortable: true }),
      field("version", "integer", "Phiên bản bản ghi"),
      field("revision_count", "integer", "Số lần cập nhật"),
    ],
    measures: [
      {
        name: "total_labor_types",
        type: "integer",
        label: "Tổng số loại hình lao động",
        formula: "total từ public.direct_entry_list_labor_types_admin",
        description: "Tổng số loại hình lao động khớp bộ lọc.",
        business_limits: "Bao gồm cả loại hình ngưng hoạt động khi include_inactive=true.",
      },
    ],
    dimensions: [],
    filters: [
      { field: "labor_type_key", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo mã loại lao động." },
      { field: "active", type: "boolean", allowed_operators: ["eq"], description: "Lọc theo trạng thái hoạt động." },
      { field: "include_inactive", type: "boolean", allowed_operators: ["eq"], description: "Có bao gồm loại lao động ngưng hoạt động hay không (mặc định true)." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm theo tên hoặc mã loại lao động." },
    ],
    allowed_relations: [],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [],
  },

  // =========================================================================
  // 8. WORK REPORTS DOMAIN (Báo cáo công việc)
  // =========================================================================
  {
    dataset: "work_reports_templates",
    domain: "work_reports",
    title: "Danh mục Mẫu Báo cáo Công việc (Work Report Templates)",
    description:
      "Danh mục mẫu báo cáo công việc (template_id, template_code, display_name, tần suất mặc định và trạng thái phát hành) dùng để tra cứu trước khi lọc giao việc, bài nộp hoặc phân tích KPI báo cáo công việc.",
    grain: "1 dòng trên mỗi mẫu báo cáo công việc (template_id).",
    canonical_source: {
      name: "public.work_report_list_templates",
      kind: "rpc",
      underlying_objects: [
        "public.work_report_list_templates",
        "public.work_report_templates",
      ],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: null,
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Danh mục mẫu báo cáo hiện hành tại ngày nghiệp vụ.",
    },
    fields: [
      field("template_id", "string", "UUID mẫu báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("template_code", "string", "Mã mẫu báo cáo chuẩn", {
        filterable: true,
        sortable: true,
      }),
      field("display_name", "string", "Tên hiển thị mẫu báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("description", "string", "Mô tả mẫu báo cáo"),
      field("default_frequency", "string", "Tần suất mặc định: DAILY | WEEKLY | MONTHLY | ONCE", {
        filterable: true,
        sortable: true,
      }),
      field("status", "string", "Trạng thái mẫu: DRAFT | ACTIVE | ARCHIVED", {
        filterable: true,
        sortable: true,
      }),
      field("current_published_version_id", "string", "UUID phiên bản đã phát hành hiện hành"),
      field("draft_version_id", "string", "UUID phiên bản nháp (nếu có)"),
      field("version", "integer", "Phiên bản bản ghi mẫu"),
      field("updated_at", "datetime", "Thời điểm cập nhật gần nhất", {
        sortable: true,
      }),
    ],
    measures: [
      {
        name: "total_templates",
        type: "integer",
        label: "Tổng số mẫu báo cáo",
        formula: "COUNT(*) mẫu báo cáo khớp bộ lọc",
        description: "Tổng số mẫu báo cáo công việc.",
        business_limits: "Tính trên toàn bộ mẫu báo cáo trong hệ thống.",
      },
      {
        name: "active_templates",
        type: "integer",
        label: "Số mẫu báo cáo đang ACTIVE",
        formula: "COUNT(*) FILTER (WHERE status = 'ACTIVE')",
        description: "Số mẫu báo cáo đang hoạt động.",
        business_limits: "Chỉ tính mẫu có status = 'ACTIVE'.",
      },
    ],
    dimensions: [
      { name: "status", label: "Trạng thái mẫu", description: "Theo trạng thái DRAFT/ACTIVE/ARCHIVED.", catalog_dataset: null },
      { name: "default_frequency", label: "Tần suất mặc định", description: "Theo tần suất DAILY/WEEKLY/MONTHLY/ONCE.", catalog_dataset: null },
    ],
    filters: [
      { field: "template_id", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo UUID mẫu báo cáo." },
      { field: "template_code", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo mã mẫu báo cáo." },
      { field: "status", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo trạng thái DRAFT | ACTIVE | ARCHIVED." },
      { field: "default_frequency", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo tần suất DAILY | WEEKLY | MONTHLY | ONCE." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm theo tên hoặc mã mẫu báo cáo." },
    ],
    allowed_relations: [
      {
        target_dataset: "work_reports_assignments",
        local_field: "template_id",
        target_field: "template_id",
        cardinality: "one_to_many",
        description: "Tra cứu các đợt giao báo cáo của mẫu này.",
      },
      {
        target_dataset: "work_reports_submissions",
        local_field: "template_id",
        target_field: "template_id",
        cardinality: "one_to_many",
        description: "Tra cứu danh sách bài nộp của mẫu này.",
      },
      {
        target_dataset: "work_reports_analytics",
        local_field: "template_id",
        target_field: "template_id",
        cardinality: "one_to_many",
        description: "Phân tích tỷ lệ tuân thủ và KPI của mẫu này.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 50,
      max_page_size: 200,
    },
    business_rules: [
      "Hãy tra cứu template_id từ work_reports_templates trước khi gọi work_reports_analytics.",
    ],
  },
  {
    dataset: "work_reports_assignments",
    domain: "work_reports",
    title: "Giao Báo cáo & Tiến độ Nghĩa vụ (Work Report Assignments & Obligations)",
    description:
      "Danh sách các quy tắc giao báo cáo công việc (theo cá nhân, nhóm tuyển dụng, tập người dùng hoặc nhóm báo cáo) kèm thống kê nghĩa vụ (tổng nghĩa vụ, đã nộp, chưa bắt đầu, quá hạn, bị từ chối, miễn trừ) và chi tiết tiến độ từng người khi lọc theo assignment_id.",
    grain: "1 dòng trên mỗi đợt giao báo cáo (assignment_id).",
    canonical_source: {
      name: "public.work_report_list_assignments + public.work_report_get_assignment_detail",
      kind: "rpc",
      underlying_objects: [
        "public.work_report_list_assignments",
        "public.work_report_get_assignment_detail",
        "public.work_report_assignments",
        "public.work_report_obligations",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "effective_from",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description: "Lọc theo ngày bắt đầu hiệu lực (effective_from) của giao việc.",
    },
    fields: [
      field("assignment_id", "string", "UUID bản ghi giao báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("template_id", "string", "UUID mẫu báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("template_code", "string", "Mã mẫu báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("template_name", "string", "Tên mẫu báo cáo", { sortable: true }),
      field("target_kind", "string", "Loại đối tượng nhận: USER | TEAM | USER_SET | GROUP", {
        filterable: true,
        sortable: true,
      }),
      field("target_group_id", "string", "UUID nhóm báo cáo (nếu target_kind = GROUP)", {
        filterable: true,
      }),
      field("target_label", "string", "Nhãn hiển thị đối tượng nhận giao việc", {
        sortable: true,
      }),
      field("target_member_count", "integer", "Số lượng thành viên thuộc đối tượng giao việc", {
        sortable: true,
      }),
      field("frequency", "string", "Tần suất báo cáo: DAILY | WEEKLY | MONTHLY | ONCE", {
        filterable: true,
        sortable: true,
      }),
      field("is_mandatory", "boolean", "Có bắt buộc nộp hay không", {
        filterable: true,
      }),
      field("due_day_offset", "integer", "Số ngày cộng thêm vào hạn nộp"),
      field("due_time_local", "string", "Giờ hạn nộp theo múi giờ Asia/Ho_Chi_Minh"),
      field("exclude_sundays", "boolean", "Có loại trừ Chủ nhật khi sinh nghĩa vụ DAILY hay không"),
      field("effective_from", "date", "Ngày bắt đầu hiệu lực", {
        filterable: true,
        sortable: true,
      }),
      field("effective_to", "date", "Ngày kết thúc hiệu lực (null nếu không thời hạn)"),
      field("state", "string", "Trạng thái giao việc: ACTIVE | PAUSED | REVOKED", {
        filterable: true,
        sortable: true,
      }),
      field("version", "integer", "Phiên bản bản ghi"),
      field("created_at", "datetime", "Thời điểm tạo", { sortable: true }),
      field("obligation_total", "integer", "Tổng số nghĩa vụ đã materialize", {
        sortable: true,
      }),
      field("submitted_count", "integer", "Số nghĩa vụ đã nộp", {
        sortable: true,
      }),
      field("not_started_count", "integer", "Số nghĩa vụ chưa bắt đầu", {
        sortable: true,
      }),
      field("draft_count", "integer", "Số nghĩa vụ đang lưu nháp", {
        sortable: true,
      }),
      field("overdue_count", "integer", "Số nghĩa vụ quá hạn", {
        sortable: true,
      }),
      field("rejected_count", "integer", "Số nghĩa vụ bị từ chối rà soát", {
        sortable: true,
      }),
      field("exempted_count", "integer", "Số nghĩa vụ được miễn trừ", {
        sortable: true,
      }),
      field("cancelled_count", "integer", "Số nghĩa vụ đã hủy", {
        sortable: true,
      }),
      field(
        "assignee_progress",
        "json",
        "Danh sách chi tiết tiến độ nghĩa vụ từng cá nhân (trả về khi lọc theo assignment_id)",
      ),
    ],
    measures: [
      {
        name: "total_assignments",
        type: "integer",
        label: "Tổng số quy tắc giao báo cáo",
        formula: "COUNT(*) assignment khớp bộ lọc",
        description: "Tổng số đợt giao báo cáo.",
        business_limits: "Tính trên phạm vi toàn miền (hoặc theo team_id nếu lọc).",
      },
      {
        name: "obligation_total_sum",
        type: "integer",
        label: "Tổng số nghĩa vụ",
        formula: "SUM(obligation_total)",
        description: "Tổng số nghĩa vụ đã sinh của các đợt giao việc khớp bộ lọc.",
        business_limits: "Chỉ tính các nghĩa vụ đã materialize.",
      },
      {
        name: "submitted_count_sum",
        type: "integer",
        label: "Tổng số nghĩa vụ đã nộp",
        formula: "SUM(submitted_count)",
        description: "Tổng số nghĩa vụ đã hoàn thành nộp.",
        business_limits: "Bao gồm COMPLETED, PENDING_REVIEW và APPROVED.",
      },
      {
        name: "overdue_count_sum",
        type: "integer",
        label: "Tổng số nghĩa vụ quá hạn",
        formula: "SUM(overdue_count)",
        description: "Tổng số nghĩa vụ quá hạn chưa hoàn thành.",
        business_limits: "Tính theo giờ hạn nộp Asia/Ho_Chi_Minh.",
      },
    ],
    dimensions: [
      { name: "template", label: "Mẫu báo cáo", description: "Theo mẫu báo cáo.", catalog_dataset: "work_reports_templates" },
      { name: "target_kind", label: "Loại đối tượng", description: "USER / TEAM / USER_SET / GROUP.", catalog_dataset: null },
      { name: "state", label: "Trạng thái giao việc", description: "ACTIVE / PAUSED / REVOKED.", catalog_dataset: null },
    ],
    filters: [
      { field: "assignment_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID đợt giao báo cáo (kích hoạt tải chi tiết assignee_progress)." },
      { field: "template_id", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo UUID mẫu báo cáo." },
      { field: "team_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID nhóm tuyển dụng." },
      { field: "target_kind", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo loại đối tượng: USER | TEAM | USER_SET | GROUP." },
      { field: "state", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo trạng thái: ACTIVE | PAUSED | REVOKED." },
      { field: "frequency", type: "string", allowed_operators: ["eq", "in"], description: "Lọc theo tần suất: DAILY | WEEKLY | MONTHLY | ONCE." },
      { field: "search", type: "string", allowed_operators: ["contains", "eq"], description: "Tìm kiếm theo tên/mã mẫu hoặc nhãn đối tượng nhận." },
    ],
    allowed_relations: [
      {
        target_dataset: "work_reports_templates",
        local_field: "template_id",
        target_field: "template_id",
        cardinality: "many_to_one",
        description: "Liên kết tới mẫu báo cáo.",
      },
    ],
    pagination: {
      strategy: "cursor",
      default_page_size: 50,
      max_page_size: 200,
    },
    business_rules: [
      "Khi truyền filter assignment_id (eq), adapter sẽ gọi thêm work_report_get_assignment_detail để đính kèm tiến độ từng nghĩa vụ trong trường assignee_progress.",
    ],
  },
  {
    dataset: "work_reports_submissions",
    domain: "work_reports",
    title: "Danh sách Bài nộp Báo cáo Công việc (Work Report Readable Submissions)",
    description:
      "Danh sách các bài nộp báo cáo công việc đã nộp (COMPLETED, PENDING_REVIEW, APPROVED, REJECTED) trên toàn miền, bao gồm trạng thái trễ hạn (is_late), chỉnh sửa sau hạn (has_post_deadline_amendment) và số lần sửa (current_revision_no).",
    grain: "1 dòng trên mỗi bài nộp báo cáo (submission_id / obligation_id).",
    canonical_source: {
      name: "public.work_report_list_readable_submissions",
      kind: "rpc",
      underlying_objects: [
        "public.work_report_list_readable_submissions",
        "public.work_report_submissions",
        "public.work_report_obligations",
      ],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "period_start_date",
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description:
        "date_range lọc theo ngày bắt đầu kỳ báo cáo (period_start_date, YYYY-MM-DD theo lịch Asia/Ho_Chi_Minh).",
    },
    fields: [
      field("obligation_id", "string", "UUID nghĩa vụ báo cáo", {
        filterable: true,
      }),
      field("submission_id", "string", "UUID bài nộp báo cáo", {
        filterable: true,
      }),
      field("template_id", "string", "UUID mẫu báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("template_name", "string", "Tên mẫu báo cáo", { sortable: true }),
      field("template_version_id", "string", "UUID phiên bản mẫu báo cáo", {
        filterable: true,
      }),
      field("template_version_no", "integer", "Số thứ tự phiên bản mẫu", {
        sortable: true,
      }),
      field("assignee_app_user_id", "string", "UUID người được giao nộp báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("assignee_display_name", "string", "Họ tên người nộp báo cáo", {
        sortable: true,
      }),
      field("team_id", "string", "UUID nhóm của người nộp tại kỳ báo cáo", {
        filterable: true,
        sortable: true,
      }),
      field("team_display_name", "string", "Tên nhóm của người nộp", {
        sortable: true,
      }),
      field("period_key", "string", "Mã kỳ báo cáo (ví dụ 2026-04-20 hoặc 2026-W16)", {
        filterable: true,
        sortable: true,
      }),
      field("period_start_date", "date", "Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)", {
        filterable: true,
        sortable: true,
      }),
      field("period_end_date", "date", "Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)", {
        sortable: true,
      }),
      field("state", "string", "Trạng thái bài nộp: COMPLETED | PENDING_REVIEW | APPROVED | REJECTED", {
        filterable: true,
        sortable: true,
      }),
      field("latest_submitted_at", "datetime", "Thời điểm nộp gần nhất", {
        sortable: true,
      }),
      field("is_late", "boolean", "Bài nộp bị trễ hạn hay không", {
        filterable: true,
        sortable: true,
      }),
      field(
        "has_post_deadline_amendment",
        "boolean",
        "Có chỉnh sửa lại sau thời điểm hạn nộp hay không",
        { filterable: true },
      ),
      field("current_revision_no", "integer", "Số lần nộp/cập nhật của bài nộp", {
        sortable: true,
      }),
    ],
    measures: [
      {
        name: "returned_submissions",
        type: "integer",
        label: "Số bài nộp trong trang trả về",
        formula: "COUNT(*) bài nộp trong trang hiện tại",
        description: "Số dòng bài nộp trả về trong trang hiện tại.",
        business_limits: "Sử dụng next_cursor để duyệt tiếp nếu has_more = true.",
      },
      {
        name: "late_count",
        type: "integer",
        label: "Số bài nộp trễ hạn trong trang",
        formula: "COUNT(*) FILTER (WHERE is_late = true)",
        description: "Số bài nộp bị đánh dấu trễ hạn trong tập trả về.",
        business_limits: "Để xem tổng hợp toàn kỳ, hãy dùng dataset work_reports_analytics.",
      },
      {
        name: "amended_count",
        type: "integer",
        label: "Số bài nộp sửa sau hạn trong trang",
        formula: "COUNT(*) FILTER (WHERE has_post_deadline_amendment = true)",
        description: "Số bài nộp có chỉnh sửa sau hạn trong tập trả về.",
        business_limits: "Tính trên trang hiện tại.",
      },
    ],
    dimensions: [
      { name: "template", label: "Mẫu báo cáo", description: "Theo mẫu báo cáo.", catalog_dataset: "work_reports_templates" },
      { name: "team", label: "Nhóm", description: "Theo nhóm.", catalog_dataset: "catalog_teams" },
      { name: "state", label: "Trạng thái bài nộp", description: "COMPLETED / PENDING_REVIEW / APPROVED / REJECTED.", catalog_dataset: null },
    ],
    filters: [
      { field: "template_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID mẫu báo cáo." },
      { field: "version_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID phiên bản mẫu báo cáo." },
      { field: "team_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID nhóm." },
      { field: "assignee_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID người nộp (app_user_id)." },
      { field: "state", type: "string", allowed_operators: ["eq"], description: "Lọc theo trạng thái: COMPLETED | PENDING_REVIEW | APPROVED | REJECTED." },
      { field: "is_late", type: "boolean", allowed_operators: ["eq"], description: "Lọc bài nộp trễ hạn (true | false)." },
    ],
    allowed_relations: [
      {
        target_dataset: "work_reports_templates",
        local_field: "template_id",
        target_field: "template_id",
        cardinality: "many_to_one",
        description: "Liên kết tới mẫu báo cáo.",
      },
      {
        target_dataset: "catalog_teams",
        local_field: "team_id",
        target_field: "team_id",
        cardinality: "many_to_one",
        description: "Liên kết tới nhóm tuyển dụng.",
      },
      {
        target_dataset: "work_reports_submission_detail",
        local_field: "obligation_id",
        target_field: "obligation_id",
        cardinality: "one_to_one",
        description:
          "Tra cứu chi tiết nội dung câu trả lời (latest_payload_json, revisions, latest_review_event) của một bài nộp cụ thể.",
      },
    ],
    pagination: {
      strategy: "keyset_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [
      "Không trả payload_json / draft_payload_json thô trong danh sách hàng loạt để bảo đảm giới hạn băng thông và bảo mật nội dung tự do.",
      "Để đọc nội dung câu trả lời nhân viên đã nhập cho một bài nộp cụ thể, hãy gọi dataset work_reports_submission_detail với filter obligation_id (hoặc submission_id) và chọn trường latest_payload_json / revisions.",
    ],
  },
  {
    dataset: "work_reports_submission_detail",
    domain: "work_reports",
    title: "Chi tiết Nội dung Bài nộp Báo cáo Công việc (Single Work Report Submission Detail)",
    description:
      "Chi tiết một nghĩa vụ và bài nộp báo cáo công việc cụ thể theo obligation_id (hoặc submission_id), bao gồm cấu trúc biểu mẫu (template_schema_json), nội dung câu trả lời đã nộp mới nhất (latest_payload_json), lịch sử các lần nộp (revisions) và kết quả duyệt mới nhất (latest_review_event). Không bao giờ trả bản nháp chưa nộp (draft_payload_json).",
    grain: "1 dòng duy nhất cho mỗi obligation_id / submission_id được tra cứu.",
    canonical_source: {
      name: "public.work_report_get_submission",
      kind: "rpc",
      underlying_objects: [
        "public.work_report_get_submission",
        "public.work_report_obligations",
        "public.work_report_submissions",
        "public.work_report_submission_revisions",
        "public.work_report_review_events",
      ],
    },
    supported_modes: ["detail", "both"],
    default_mode: "detail",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: "period_start_date",
      supports_date_range: false,
      supports_as_of_date: false,
      cutoff_date: null,
      description:
        "Tra cứu trực tiếp trạng thái và nội dung các lần đã nộp của một bài nộp cụ thể.",
    },
    fields: [
      field("obligation_id", "string", "UUID nghĩa vụ báo cáo", {
        filterable: true,
      }),
      field("submission_id", "string", "UUID bài nộp báo cáo (null nếu chưa nộp)", {
        filterable: true,
      }),
      field("template_id", "string", "UUID mẫu báo cáo"),
      field("template_code", "string", "Mã mẫu báo cáo"),
      field("template_display_name", "string", "Tên hiển thị mẫu báo cáo"),
      field(
        "template_schema_json",
        "json",
        "Schema cấu trúc các mục/trường câu hỏi của phiên bản mẫu báo cáo",
      ),
      field("assignee_app_user_id", "string", "UUID nhân sự được giao báo cáo"),
      field("snapshot_team_id", "string", "UUID nhóm tại thời điểm sinh nghĩa vụ"),
      field("snapshot_team_code", "string", "Mã nhóm tại thời điểm sinh nghĩa vụ"),
      field(
        "snapshot_team_display_name",
        "string",
        "Tên nhóm tại thời điểm sinh nghĩa vụ",
      ),
      field("period_key", "string", "Mã kỳ báo cáo"),
      field("period_start_date", "date", "Ngày bắt đầu kỳ báo cáo (YYYY-MM-DD)"),
      field("period_end_date", "date", "Ngày kết thúc kỳ báo cáo (YYYY-MM-DD)"),
      field("due_at", "datetime", "Thời điểm hạn nộp (ISO-8601)"),
      field(
        "obligation_status",
        "string",
        "Trạng thái nghĩa vụ: ACTIVE | EXEMPTED | CANCELLED",
      ),
      field("reopened_until", "datetime", "Thời điểm gia hạn mở lại (nếu có)"),
      field("is_overdue", "boolean", "Nghĩa vụ đang quá hạn chưa hoàn thành hay không"),
      field(
        "submission_state",
        "string",
        "Trạng thái bài nộp: NOT_STARTED | DRAFT | COMPLETED | PENDING_REVIEW | APPROVED | REJECTED",
      ),
      field("first_submitted_at", "datetime", "Thời điểm nộp lần đầu"),
      field("latest_submitted_at", "datetime", "Thời điểm nộp gần nhất"),
      field("is_late", "boolean", "Bài nộp bị trễ hạn hay không"),
      field(
        "has_post_deadline_amendment",
        "boolean",
        "Có chỉnh sửa lại sau thời điểm hạn nộp hay không",
      ),
      field("current_revision_id", "string", "UUID phiên bản bài nộp hiện hành"),
      field("current_revision_no", "integer", "Số thứ tự lần nộp mới nhất"),
      field("revision_count", "integer", "Tổng số lần đã nộp (revisions)"),
      field(
        "latest_payload_json",
        "json",
        "Nội dung câu trả lời đã nộp ở revision mới nhất (nhạy cảm free_text: chỉ trả khi liệt kê tường minh trong fields)",
        {
          sensitive: true,
          sensitivity_class: "free_text",
        },
      ),
      field(
        "revisions",
        "json",
        "Danh sách lịch sử các lần nộp kèm payload_json từng lần (nhạy cảm free_text: chỉ trả khi liệt kê tường minh trong fields)",
        {
          sensitive: true,
          sensitivity_class: "free_text",
        },
      ),
      field(
        "latest_review_event",
        "json",
        "Kết quả phê duyệt/từ chối gần nhất kèm lý do (nhạy cảm free_text: chỉ trả khi liệt kê tường minh trong fields)",
        {
          sensitive: true,
          sensitivity_class: "free_text",
        },
      ),
    ],
    measures: [
      {
        name: "revision_count",
        type: "integer",
        label: "Số lần đã nộp của bài báo cáo",
        formula: "COUNT(revisions)",
        description: "Tổng số revision đã nộp của nghĩa vụ báo cáo này.",
        business_limits: "Bằng 0 nếu nghĩa vụ chưa được nộp lần nào.",
      },
    ],
    dimensions: [],
    filters: [
      {
        field: "obligation_id",
        type: "string",
        allowed_operators: ["eq"],
        description:
          "UUID nghĩa vụ báo cáo cần xem chi tiết (bắt buộc truyền obligation_id hoặc submission_id).",
      },
      {
        field: "submission_id",
        type: "string",
        allowed_operators: ["eq"],
        description:
          "UUID bài nộp báo cáo cần xem chi tiết (có thể truyền thay cho obligation_id).",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "work_reports_templates",
        local_field: "template_id",
        target_field: "template_id",
        cardinality: "many_to_one",
        description: "Liên kết tới mẫu báo cáo.",
      },
      {
        target_dataset: "work_reports_submissions",
        local_field: "obligation_id",
        target_field: "obligation_id",
        cardinality: "one_to_one",
        description: "Liên kết tới dòng bài nộp trong danh sách bài nộp.",
      },
    ],
    pagination: {
      strategy: "none",
      default_page_size: 1,
      max_page_size: 1,
    },
    business_rules: [
      "Bắt buộc truyền filter obligation_id (eq) hoặc submission_id (eq) để truy vấn đúng 1 bài nộp cụ thể; không hỗ trợ tải hàng loạt.",
      "Không bao giờ trả draft_payload_json chưa nộp; chỉ trả các nội dung đã thực sự submit trong latest_payload_json và revisions.",
      "Các trường latest_payload_json, revisions và latest_review_event thuộc phân loại nhạy cảm free_text nên cần liệt kê tường minh trong QuerySpec.fields khi cần đọc nội dung câu trả lời.",
    ],
  },
  {
    dataset: "work_reports_analytics",
    domain: "work_reports",
    title: "Phân tích Tuân thủ & KPI Báo cáo Công việc (Work Report Analytics Overview & Breakdown)",
    description:
      "Tổng hợp tỷ lệ hoàn thành báo cáo đúng hạn/trễ hạn/quá hạn, các chỉ số metric số học (sum, avg, min, max) và tỷ lệ trọng số (weighted ratios) của một mẫu báo cáo, kèm bảng phân rã (breakdown) theo nhóm (team), cá nhân (assignee) hoặc kỳ báo cáo (period).",
    grain: "Summary toàn miền cho template_id + 1 dòng trên mỗi nhóm phân rã (team | assignee | period).",
    canonical_source: {
      name: "public.work_report_analytics_overview + public.work_report_analytics_breakdown",
      kind: "rpc",
      underlying_objects: [
        "public.work_report_analytics_overview",
        "public.work_report_analytics_breakdown",
        "public.work_report_submission_metric_values",
      ],
    },
    supported_modes: ["aggregate", "detail", "both"],
    default_mode: "both",
    time_semantics: {
      timezone: N8N_BOD_BUSINESS_TIMEZONE,
      business_date_field: null,
      supports_date_range: true,
      supports_as_of_date: false,
      cutoff_date: null,
      description:
        "date_range lọc theo khoảng ngày bắt đầu kỳ báo cáo (period_start_date từ from đến to).",
    },
    fields: [
      field("group_by", "string", "Chiều phân rã: team | assignee | period", {
        filterable: true,
      }),
      field("group_id", "string", "ID của nhóm/cá nhân/kỳ phân rã (null nếu chưa gán nhóm)", {
        filterable: true,
        sortable: true,
      }),
      field("group_label", "string", "Tên hiển thị của nhóm/cá nhân/kỳ báo cáo", {
        sortable: true,
      }),
      field("due_count", "integer", "Số nghĩa vụ đến hạn", { sortable: true }),
      field("completed_count", "integer", "Số nghĩa vụ đã hoàn thành", {
        sortable: true,
      }),
      field("on_time_count", "integer", "Số nghĩa vụ nộp đúng hạn", {
        sortable: true,
      }),
      field("late_submitted_count", "integer", "Số nghĩa vụ nộp trễ hạn", {
        sortable: true,
      }),
      field("pending_due_count", "integer", "Số nghĩa vụ chưa tới hạn và chưa nộp", {
        sortable: true,
      }),
      field("overdue_missing_count", "integer", "Số nghĩa vụ đã quá hạn nhưng chưa nộp", {
        sortable: true,
      }),
      field("exempted_count", "integer", "Số nghĩa vụ được miễn trừ", {
        sortable: true,
      }),
      field("pending_review_count", "integer", "Số bài nộp đang chờ duyệt", {
        sortable: true,
      }),
      field("completion_rate", "number", "Tỷ lệ hoàn thành (%)", {
        sortable: true,
      }),
      field(
        "metrics",
        "json",
        "Mảng các chỉ số định lượng đã tổng hợp (metric_key, label, unit, sum_value, avg_value, min_value, max_value, count_valid, missing_value_count)",
      ),
    ],
    measures: [
      {
        name: "due_count",
        type: "integer",
        label: "Tổng nghĩa vụ tính tuân thủ",
        formula: "compliance.due_count từ public.work_report_analytics_overview",
        description: "Tổng số nghĩa vụ thuộc mẫu số tính tỷ lệ hoàn thành.",
        business_limits: "Không bao gồm nghĩa vụ đã miễn trừ (EXEMPTED) hoặc đã hủy (CANCELLED).",
      },
      {
        name: "completed_count",
        type: "integer",
        label: "Tổng nghĩa vụ đã hoàn thành",
        formula: "compliance.completed_count",
        description: "Tổng số nghĩa vụ đã hoàn thành theo chế độ finality đã chọn.",
        business_limits:
          "Khi finality = 'final' (mặc định), chỉ tính COMPLETED (nếu mẫu không cần duyệt) hoặc APPROVED (nếu mẫu cần duyệt). Khi finality = 'provisional_included', tính thêm PENDING_REVIEW.",
      },
      {
        name: "on_time_count",
        type: "integer",
        label: "Số nghĩa vụ hoàn thành đúng hạn",
        formula: "compliance.on_time_count",
        description: "Số nghĩa vụ hoàn thành trước hoặc đúng due_at.",
        business_limits: "Tính theo finality đã chọn.",
      },
      {
        name: "late_submitted_count",
        type: "integer",
        label: "Số nghĩa vụ hoàn thành trễ hạn",
        formula: "compliance.late_submitted_count",
        description: "Số nghĩa vụ hoàn thành nhưng nộp sau due_at.",
        business_limits: "Tính theo finality đã chọn.",
      },
      {
        name: "overdue_missing_count",
        type: "integer",
        label: "Số nghĩa vụ quá hạn chưa nộp",
        formula: "compliance.overdue_missing_count",
        description: "Số nghĩa vụ đã quá hạn mà chưa có bài nộp hợp lệ.",
        business_limits: "Tính tại thời điểm as_of.",
      },
      {
        name: "completion_rate",
        type: "number",
        label: "Tỷ lệ hoàn thành (%)",
        formula: "ROUND((completed_count::numeric / NULLIF(due_count, 0)) * 100, 2)",
        description: "Phần trăm nghĩa vụ hoàn thành trên tổng nghĩa vụ đến hạn.",
        business_limits: "Trả null khi due_count = 0.",
      },
    ],
    dimensions: [
      { name: "team", label: "Nhóm", description: "Phân rã theo nhóm (group_by = 'team').", catalog_dataset: "catalog_teams" },
      { name: "assignee", label: "Người được giao", description: "Phân rã theo cá nhân (group_by = 'assignee').", catalog_dataset: null },
      { name: "period", label: "Kỳ báo cáo", description: "Phân rã theo kỳ (group_by = 'period').", catalog_dataset: null },
    ],
    filters: [
      {
        field: "template_id",
        type: "string",
        allowed_operators: ["eq"],
        required: true,
        description: "UUID mẫu báo cáo cần phân tích (BẮT BUỘC — tra cứu từ work_reports_templates).",
      },
      { field: "version_id", type: "string", allowed_operators: ["eq"], description: "UUID phiên bản mẫu báo cáo (tùy chọn)." },
      { field: "team_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID nhóm." },
      { field: "assignee_id", type: "string", allowed_operators: ["eq"], description: "Lọc theo UUID người nộp." },
      {
        field: "group_by",
        type: "string",
        allowed_operators: ["eq"],
        description: "Chiều phân rã dòng chi tiết: 'team' (mặc định) | 'assignee' | 'period'.",
      },
      {
        field: "finality",
        type: "string",
        allowed_operators: ["eq"],
        description: "Chế độ chốt số liệu: 'final' (mặc định) | 'provisional_included'.",
      },
    ],
    allowed_relations: [
      {
        target_dataset: "work_reports_templates",
        local_field: "template_id",
        target_field: "template_id",
        cardinality: "many_to_one",
        description: "Liên kết tới mẫu báo cáo.",
      },
    ],
    pagination: {
      strategy: "page_cursor",
      default_page_size: 50,
      max_page_size: 100,
    },
    business_rules: [
      "Bắt buộc truyền filter template_id (op: 'eq').",
      "Chỉ cộng gộp các metric cùng compatible_group theo đúng metric_contract_json của mẫu báo cáo.",
    ],
  },
]);

const PENDING_DATASETS: readonly N8nPendingDatasetSpec[] = Object.freeze([]);

const DATASET_BY_NAME = new Map<string, N8nDatasetSpec>(
  DATASETS.map((item) => [item.dataset, item]),
);

const PENDING_DATASET_BY_NAME = new Map<string, N8nPendingDatasetSpec>(
  PENDING_DATASETS.map((item) => [item.dataset, item]),
);

export function listActiveN8nDatasetNames(): readonly string[] {
  return DATASETS.map((item) => item.dataset);
}

export function findN8nDatasetSpec(datasetName: string): N8nDatasetSpec | null {
  return DATASET_BY_NAME.get(datasetName) ?? null;
}

export function findN8nPendingDatasetSpec(
  datasetName: string,
): N8nPendingDatasetSpec | null {
  return PENDING_DATASET_BY_NAME.get(datasetName) ?? null;
}

export function getN8nBodCatalog(
  options: { now?: Date } = {},
): N8nBodCatalog {
  const now = options.now ?? new Date();
  return {
    catalog_version: N8N_BOD_CATALOG_VERSION,
    generated_at: now.toISOString(),
    principal: N8N_BOD_READONLY_PRINCIPAL,
    scope: N8N_BOD_READONLY_SCOPE,
    business_timezone: N8N_BOD_BUSINESS_TIMEZONE,
    business_date: currentHoChiMinhBusinessDate(now),
    query_contract: {
      endpoint: "/api/integrations/n8n/v1/query",
      method: "POST",
      supported_operators: [
        "eq",
        "neq",
        "in",
        "gte",
        "lte",
        "between",
        "contains",
        "is_null",
      ],
      max_page_size_ceiling: 500,
      max_request_body_bytes: 65536,
      max_response_bytes: 1048576,
      query_timeout_ms: 15000,
      arbitrary_sql_allowed: false,
      client_authority_fields_allowed: false,
      sensitive_field_policy:
        "Các trường có sensitive=true (CCCD, SĐT, tọa độ GPS, số tài khoản, địa chỉ, ngày sinh, ghi chú/lý do tự do) bị ẩn mặc định và chỉ được trả về khi liệt kê tường minh trong QuerySpec.fields.",
      media_policy:
        "METADATA_ONLY_NO_BULK_MEDIA: Ảnh CCCD, ảnh chân dung, ảnh chấm công và tệp chứng từ tài chính không bao giờ được trả hàng loạt trong /query; chỉ trả các cờ/đếm metadata.",
      multi_query_guidance: [
        "Để trả lời câu hỏi theo tên dự án, nhóm, người tuyển hoặc Vendor khi chưa biết ID, hãy gọi catalog_projects / catalog_teams / catalog_recruiters / catalog_vendors trước để lấy ID chuẩn, sau đó gọi dataset nghiệp vụ.",
        "Để trả lời câu hỏi về Báo cáo công việc (work_reports), hãy gọi work_reports_templates hoặc work_reports_assignments trước để biết template_id, sau đó gọi work_reports_analytics hoặc work_reports_submissions. Khi cần đọc nội dung câu trả lời chi tiết của một bài nộp cụ thể, hãy gọi work_reports_submission_detail theo obligation_id (hoặc submission_id) và chọn trường latest_payload_json / revisions.",
        "Để trả lời câu hỏi liên domain (ví dụ: so sánh tuyển dụng, lực lượng lao động đang ON và chi phí Vendor của cùng một dự án), hãy thực hiện nhiều truy vấn /query độc lập với cùng project_id rồi tổng hợp theo khóa dự án.",
        "Khi phân tích tài chính Vendor cho BoD, luôn giữ nguyên ngữ cảnh Dự án + Kế toán phụ trách (project_id + responsible_accountant_user_id); tuyệt đối không tự cộng bù trừ số dư dương của kế toán này với số dư âm của kế toán khác.",
      ],
    },
    domains: [
      {
        domain: "recruitment",
        title: "Tuyển dụng (Recruitment)",
        status: "ACTIVE",
        description:
          "Số liệu tuyển dụng từ Direct Entry sau cutover, dữ liệu legacy Google Sheets trước cutover và bảng đối soát chống cộng trùng.",
      },
      {
        domain: "workforce",
        title: "Lực lượng lao động (Workforce)",
        status: "ACTIVE",
        description:
          "Snapshot trạng thái lao động, biến động ON/OFF/UNCONFIRMED, cân đối kỳ, chờ việc, thâm niên, retention D7/D30/D90, lý do nghỉ và danh sách nghỉ việc >= 3 ngày.",
      },
      {
        domain: "workers",
        title: "Hồ sơ Người lao động (Workers)",
        status: "ACTIVE",
        description:
          "Danh bạ đợt làm việc SUBMITTED, hồ sơ chi tiết, lịch sử các đợt làm việc và báo cáo trùng CCCD trong phạm vi BoD.",
      },
      {
        domain: "attendance",
        title: "Chấm công (Attendance)",
        status: "ACTIVE",
        description:
          "Tổng quan chấm công, lượt chấm công chi tiết, xác minh thời gian, tọa độ GPS, khoảng cách tới HQ và ghi chú.",
      },
      {
        domain: "vendor_finance",
        title: "Tài chính Vendor (Vendor Finance)",
        status: "ACTIVE",
        description:
          "Báo cáo tháng, danh sách sổ phụ, bút toán sổ cái và đối soát công nợ theo đúng nguyên tắc sổ phụ Dự án + Kế toán phụ trách + Vendor.",
      },
      {
        domain: "data_quality",
        title: "Chất lượng dữ liệu (Data Quality)",
        status: "ACTIVE",
        description:
          "Trạng thái đồng bộ các nguồn dữ liệu, độ mới, lỗi đồng bộ và hàng đợi đối soát QR CCCD.",
      },
      {
        domain: "catalogs",
        title: "Catalog nghiệp vụ (Business Catalogs)",
        status: "ACTIVE",
        description:
          "Danh mục chuẩn về Dự án, Nhóm, Phân quyền Dự án-Nhóm, Người tuyển, Vendor và Loại hình lao động dùng để lọc và liên kết.",
      },
      {
        domain: "work_reports",
        title: "Báo cáo công việc (Work Reports)",
        status: "ACTIVE",
        description:
          "Danh mục mẫu báo cáo, quy tắc giao báo cáo & nghĩa vụ, danh sách bài nộp toàn miền và phân tích tỷ lệ tuân thủ / KPI theo mẫu báo cáo.",
      },
    ],
    datasets: DATASETS,
    pending_datasets: PENDING_DATASETS,
  };
}
