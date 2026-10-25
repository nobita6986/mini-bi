import { isRealCalendarDate } from "../../analytics/identity/identity-shared.mjs";

import {
  findN8nDatasetSpec,
  findN8nPendingDatasetSpec,
  listActiveN8nDatasetNames,
  type N8nDatasetSpec,
  type N8nFilterOperator,
  type N8nQueryMode,
} from "./catalog.ts";

export type N8nQueryFilter = {
  field: string;
  op: N8nFilterOperator;
  value?: unknown;
};

export type N8nQuerySort = {
  field: string;
  direction: "asc" | "desc";
};

export type N8nDateRange = {
  from: string;
  to: string;
};

export type ValidatedN8nQuerySpec = {
  dataset: string;
  datasetSpec: N8nDatasetSpec;
  mode: N8nQueryMode;
  fields: readonly string[];
  explicitFieldsRequested: boolean;
  requestedFieldsSet: ReadonlySet<string>;
  requestedSensitiveFields: readonly string[];
  redactedSensitiveFields: readonly string[];
  measures: readonly string[];
  dimensions: readonly string[];
  filters: readonly N8nQueryFilter[];
  date_range: N8nDateRange | null;
  as_of_date: string | null;
  sort: readonly N8nQuerySort[];
  page_size: number;
  cursor: N8nDecodedCursor | null;
};

export type N8nDecodedCursor = {
  v: 1;
  dataset: string;
  kind: "offset" | "page" | "token";
  offset?: number;
  page?: number;
  token?: string | null;
  sub_offset?: number;
  batch_page_size?: number;
};

export type N8nQueryValidationErrorCode =
  | "INVALID_JSON_BODY"
  | "PAYLOAD_TOO_LARGE"
  | "CLIENT_AUTHORITY_FORBIDDEN"
  | "ARBITRARY_SQL_FORBIDDEN"
  | "UNKNOWN_QUERY_PROPERTY"
  | "DATASET_REQUIRED"
  | "DATASET_PENDING_CONTRACT"
  | "DATASET_NOT_SUPPORTED"
  | "INVALID_QUERY_MODE"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_MEASURE"
  | "UNKNOWN_DIMENSION"
  | "UNKNOWN_FILTER_FIELD"
  | "DISALLOWED_FILTER_OPERATOR"
  | "INVALID_FILTER_VALUE"
  | "MISSING_REQUIRED_FILTER"
  | "DATE_RANGE_NOT_SUPPORTED"
  | "INVALID_DATE_RANGE"
  | "AS_OF_DATE_NOT_SUPPORTED"
  | "INVALID_AS_OF_DATE"
  | "INVALID_SORT"
  | "INVALID_PAGE_SIZE"
  | "INVALID_CURSOR";

export type N8nQueryValidationResult =
  | {
      ok: true;
      spec: ValidatedN8nQuerySpec;
    }
  | {
      ok: false;
      status: 400 | 413 | 422;
      code: N8nQueryValidationErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "dataset",
  "mode",
  "fields",
  "measures",
  "dimensions",
  "filters",
  "date_range",
  "as_of_date",
  "sort",
  "page_size",
  "cursor",
]);

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "actor",
  "actor_id",
  "actorid",
  "auth_subject",
  "authsubject",
  "app_user",
  "app_user_id",
  "appuserid",
  "role",
  "roles",
  "scope",
  "scopes",
  "scope_kind",
  "scopekind",
  "team_id",
  "teamid",
  "capability",
  "capabilities",
  "permissions",
  "principal",
  "service_role",
]);

const FORBIDDEN_SQL_KEYS = new Set([
  "sql",
  "raw_sql",
  "query_sql",
  "where_sql",
  "having_sql",
  "order_by_sql",
  "group_by_sql",
  "expression",
  "raw_query",
]);

const VALID_OPERATORS = new Set<N8nFilterOperator>([
  "eq",
  "neq",
  "in",
  "gte",
  "lte",
  "between",
  "contains",
  "is_null",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKeyName(key: string): string {
  return key.trim().toLowerCase();
}

function findForbiddenNestedKey(
  value: unknown,
  keySet: ReadonlySet<string>,
  depth = 0,
): string | null {
  if (depth > 8 || value === null || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenNestedKey(item, keySet, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    const normalized = normalizeKeyName(k);
    if (keySet.has(normalized)) {
      return k;
    }
    const nestedHit = findForbiddenNestedKey(v, keySet, depth + 1);
    if (nestedHit) return nestedHit;
  }
  return null;
}

export function encodeN8nCursor(cursor: Omit<N8nDecodedCursor, "v">): string {
  const payload: N8nDecodedCursor = {
    v: 1,
    ...cursor,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeN8nCursor(
  rawCursor: string,
  expectedDataset: string,
): N8nDecodedCursor | null {
  if (typeof rawCursor !== "string") return null;
  const trimmed = rawCursor.trim();
  if (trimmed.length < 4 || trimmed.length > 1024) return null;
  try {
    const jsonText = Buffer.from(trimmed, "base64url").toString("utf8");
    const parsed = JSON.parse(jsonText);
    if (!isRecord(parsed)) return null;
    if (parsed.v !== 1 || parsed.dataset !== expectedDataset) return null;

    let subOffset: number | undefined;
    if (parsed.sub_offset !== undefined) {
      if (
        typeof parsed.sub_offset !== "number" ||
        !Number.isSafeInteger(parsed.sub_offset) ||
        parsed.sub_offset < 0 ||
        parsed.sub_offset > 100000
      ) {
        return null;
      }
      subOffset = parsed.sub_offset;
    }

    let batchPageSize: number | undefined;
    if (parsed.batch_page_size !== undefined) {
      if (
        typeof parsed.batch_page_size !== "number" ||
        !Number.isSafeInteger(parsed.batch_page_size) ||
        parsed.batch_page_size < 1 ||
        parsed.batch_page_size > 500
      ) {
        return null;
      }
      batchPageSize = parsed.batch_page_size;
    }

    const extraFields: { sub_offset?: number; batch_page_size?: number } = {};
    if (subOffset !== undefined) extraFields.sub_offset = subOffset;
    if (batchPageSize !== undefined) extraFields.batch_page_size = batchPageSize;

    if (parsed.kind === "offset") {
      if (
        typeof parsed.offset !== "number" ||
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < 0 ||
        parsed.offset > 100000
      ) {
        return null;
      }
      return {
        v: 1,
        dataset: expectedDataset,
        kind: "offset",
        offset: parsed.offset,
        ...extraFields,
      };
    }
    if (parsed.kind === "page") {
      if (
        typeof parsed.page !== "number" ||
        !Number.isSafeInteger(parsed.page) ||
        parsed.page < 1 ||
        parsed.page > 10000
      ) {
        return null;
      }
      return {
        v: 1,
        dataset: expectedDataset,
        kind: "page",
        page: parsed.page,
        ...extraFields,
      };
    }
    if (parsed.kind === "token") {
      const isNonEmptyStringToken =
        typeof parsed.token === "string" &&
        parsed.token.trim().length >= 1 &&
        parsed.token.length <= 512;
      const isInitialBatchSubOffsetToken =
        parsed.token === null && typeof subOffset === "number" && subOffset > 0;
      if (!isNonEmptyStringToken && !isInitialBatchSubOffsetToken) {
        return null;
      }
      return {
        v: 1,
        dataset: expectedDataset,
        kind: "token",
        token: parsed.token as string | null,
        ...extraFields,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function validateScalarByType(
  value: unknown,
  expectedType: N8nDatasetSpec["fields"][number]["type"],
): boolean {
  switch (expectedType) {
    case "string":
      return (
        typeof value === "string" &&
        value.trim().length >= 1 &&
        value.length <= 256 &&
        !/[\x00-\x1F\x7F]/.test(value)
      );
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "date":
      return typeof value === "string" && isRealCalendarDate(value);
    case "datetime":
      return (
        typeof value === "string" &&
        value.trim().length >= 10 &&
        value.length <= 64 &&
        !Number.isNaN(Date.parse(value))
      );
    case "json":
      return value !== undefined;
    default:
      return false;
  }
}

export function parseAndValidateN8nQuerySpec(
  body: unknown,
): N8nQueryValidationResult {
  if (!isRecord(body)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_JSON_BODY",
      message: "Body truy vấn phải là một JSON object theo cấu trúc QuerySpec.",
    };
  }

  // 1. Check forbidden SQL keys at any nesting level first.
  const sqlKeyHit = findForbiddenNestedKey(body, FORBIDDEN_SQL_KEYS);
  if (sqlKeyHit) {
    return {
      ok: false,
      status: 400,
      code: "ARBITRARY_SQL_FORBIDDEN",
      message: `Không cho phép gửi hoặc thực thi SQL tùy ý (${sqlKeyHit}). Hãy dùng QuerySpec có cấu trúc theo catalog.`,
      details: { forbidden_field: sqlKeyHit },
    };
  }

  // 2. Check forbidden client/AI authority keys at any nesting level.
  const authorityKeyHit = findForbiddenNestedKey(body, FORBIDDEN_AUTHORITY_KEYS);
  if (authorityKeyHit) {
    return {
      ok: false,
      status: 400,
      code: "CLIENT_AUTHORITY_FORBIDDEN",
      message: `Không cho phép truyền trường tự khai quyền/danh tính (${authorityKeyHit}). Principal cố định là n8n_bod_readonly.`,
      details: { forbidden_field: authorityKeyHit },
    };
  }

  // 3. Check top-level unknown keys.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return {
        ok: false,
        status: 400,
        code: "UNKNOWN_QUERY_PROPERTY",
        message: `Trường không hợp lệ trong QuerySpec: ${key}.`,
        details: {
          unknown_property: key,
          allowed_properties: [...ALLOWED_TOP_LEVEL_KEYS],
        },
      };
    }
  }

  // 4. Dataset lookup & pending dataset handling.
  if (typeof body.dataset !== "string" || body.dataset.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      code: "DATASET_REQUIRED",
      message: "QuerySpec bắt buộc phải có trường dataset (string).",
      details: { supported_datasets: listActiveN8nDatasetNames() },
    };
  }

  const datasetName = body.dataset.trim();
  const pendingSpec = findN8nPendingDatasetSpec(datasetName);
  if (pendingSpec) {
    return {
      ok: false,
      status: 422,
      code: "DATASET_PENDING_CONTRACT",
      message: pendingSpec.reason,
      details: {
        dataset: pendingSpec.dataset,
        domain: pendingSpec.domain,
        status: pendingSpec.status,
        guidance:
          "Hãy thông báo rõ cho BoD rằng module Báo cáo công việc (work_reports) đang chờ T1A chốt contract nên chưa truy vấn được trong phiên bản này; tuyệt đối không tự suy đoán số liệu.",
      },
    };
  }

  const datasetSpec = findN8nDatasetSpec(datasetName);
  if (!datasetSpec) {
    return {
      ok: false,
      status: 400,
      code: "DATASET_NOT_SUPPORTED",
      message: `Dataset '${datasetName}' không tồn tại trong catalog. Không được tự suy đoán; hãy kiểm tra GET /api/integrations/n8n/v1/catalog.`,
      details: {
        requested_dataset: datasetName,
        supported_datasets: listActiveN8nDatasetNames(),
      },
    };
  }

  // 5. Mode validation.
  let mode: N8nQueryMode = datasetSpec.default_mode;
  if (body.mode !== undefined) {
    if (
      body.mode !== "aggregate" &&
      body.mode !== "detail" &&
      body.mode !== "both"
    ) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_QUERY_MODE",
        message: "mode phải là 'aggregate', 'detail' hoặc 'both'.",
      };
    }
    if (!datasetSpec.supported_modes.includes(body.mode)) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_QUERY_MODE",
        message: `Dataset '${datasetName}' không hỗ trợ mode '${body.mode}'. Các mode hỗ trợ: ${datasetSpec.supported_modes.join(", ")}.`,
      };
    }
    mode = body.mode;
  }

  // 6. Fields validation & sensitivity classification.
  const fieldMap = new Map(datasetSpec.fields.map((f) => [f.name, f]));
  const explicitFieldsRequested =
    Array.isArray(body.fields) && body.fields.length > 0;
  const requestedFields: string[] = [];

  if (body.fields !== undefined) {
    if (!Array.isArray(body.fields) || body.fields.length > 100) {
      return {
        ok: false,
        status: 400,
        code: "UNKNOWN_FIELD",
        message: "fields phải là mảng tên trường hợp lệ trong dataset.",
      };
    }
    for (const rawField of body.fields) {
      if (typeof rawField !== "string") {
        return {
          ok: false,
          status: 400,
          code: "UNKNOWN_FIELD",
          message: "Mỗi phần tử trong fields phải là tên trường kiểu string.",
        };
      }
      const fSpec = fieldMap.get(rawField);
      if (!fSpec || !fSpec.selectable) {
        return {
          ok: false,
          status: 400,
          code: "UNKNOWN_FIELD",
          message: `Trường '${rawField}' không tồn tại hoặc không thể chọn trong dataset '${datasetName}'.`,
          details: {
            dataset: datasetName,
            invalid_field: rawField,
            allowed_fields: datasetSpec.fields
              .filter((f) => f.selectable)
              .map((f) => f.name),
          },
        };
      }
      if (!requestedFields.includes(rawField)) {
        requestedFields.push(rawField);
      }
    }
  }

  const finalFields = explicitFieldsRequested
    ? requestedFields
    : datasetSpec.fields
        .filter((f) => f.selectable && !f.sensitive)
        .map((f) => f.name);

  const requestedFieldsSet = new Set(finalFields);
  const allSensitiveFieldNames = datasetSpec.fields
    .filter((f) => f.sensitive)
    .map((f) => f.name);
  const requestedSensitiveFields = allSensitiveFieldNames.filter((name) =>
    requestedFieldsSet.has(name),
  );
  const redactedSensitiveFields = allSensitiveFieldNames.filter(
    (name) => !requestedFieldsSet.has(name),
  );

  // 7. Measures validation.
  const measureMap = new Map(datasetSpec.measures.map((m) => [m.name, m]));
  const measures: string[] = [];
  if (body.measures !== undefined) {
    if (!Array.isArray(body.measures) || body.measures.length > 50) {
      return {
        ok: false,
        status: 400,
        code: "UNKNOWN_MEASURE",
        message: "measures phải là mảng tên measure hợp lệ.",
      };
    }
    for (const rawMeasure of body.measures) {
      if (typeof rawMeasure !== "string" || !measureMap.has(rawMeasure)) {
        return {
          ok: false,
          status: 400,
          code: "UNKNOWN_MEASURE",
          message: `Measure '${String(rawMeasure)}' không hợp lệ cho dataset '${datasetName}'.`,
          details: {
            dataset: datasetName,
            invalid_measure: rawMeasure,
            allowed_measures: datasetSpec.measures.map((m) => m.name),
          },
        };
      }
      if (!measures.includes(rawMeasure)) {
        measures.push(rawMeasure);
      }
    }
  } else {
    for (const m of datasetSpec.measures) {
      measures.push(m.name);
    }
  }

  // 8. Dimensions validation.
  const dimensionMap = new Map(datasetSpec.dimensions.map((d) => [d.name, d]));
  const dimensions: string[] = [];
  if (body.dimensions !== undefined) {
    if (!Array.isArray(body.dimensions) || body.dimensions.length > 20) {
      return {
        ok: false,
        status: 400,
        code: "UNKNOWN_DIMENSION",
        message: "dimensions phải là mảng tên dimension hợp lệ.",
      };
    }
    for (const rawDim of body.dimensions) {
      if (typeof rawDim !== "string" || !dimensionMap.has(rawDim)) {
        return {
          ok: false,
          status: 400,
          code: "UNKNOWN_DIMENSION",
          message: `Dimension '${String(rawDim)}' không hợp lệ cho dataset '${datasetName}'.`,
          details: {
            dataset: datasetName,
            invalid_dimension: rawDim,
            allowed_dimensions: datasetSpec.dimensions.map((d) => d.name),
          },
        };
      }
      if (!dimensions.includes(rawDim)) {
        dimensions.push(rawDim);
      }
    }
  }

  // 9. Filters validation.
  const filterSpecMap = new Map(datasetSpec.filters.map((f) => [f.field, f]));
  const filters: N8nQueryFilter[] = [];
  if (body.filters !== undefined) {
    if (!Array.isArray(body.filters) || body.filters.length > 30) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_FILTER_VALUE",
        message: "filters phải là mảng điều kiện lọc (tối đa 30 điều kiện).",
      };
    }
    for (const rawFilter of body.filters) {
      if (!isRecord(rawFilter)) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_FILTER_VALUE",
          message: "Mỗi phần tử trong filters phải là object { field, op, value }.",
        };
      }
      for (const k of Object.keys(rawFilter)) {
        if (k !== "field" && k !== "op" && k !== "value") {
          return {
            ok: false,
            status: 400,
            code: "UNKNOWN_QUERY_PROPERTY",
            message: `Thuộc tính không hợp lệ trong filter: ${k}.`,
          };
        }
      }
      const fieldName = rawFilter.field;
      const op = rawFilter.op;
      if (typeof fieldName !== "string") {
        return {
          ok: false,
          status: 400,
          code: "UNKNOWN_FILTER_FIELD",
          message: "filter.field phải là string.",
        };
      }

      const declaredFilter = filterSpecMap.get(fieldName);
      const declaredField = fieldMap.get(fieldName);
      if (!declaredFilter && (!declaredField || !declaredField.filterable)) {
        return {
          ok: false,
          status: 400,
          code: "UNKNOWN_FILTER_FIELD",
          message: `Trường '${fieldName}' không được phép lọc trong dataset '${datasetName}'.`,
          details: {
            dataset: datasetName,
            invalid_filter_field: fieldName,
            allowed_filters: datasetSpec.filters.map((f) => f.field),
          },
        };
      }

      if (typeof op !== "string" || !VALID_OPERATORS.has(op as N8nFilterOperator)) {
        return {
          ok: false,
          status: 400,
          code: "DISALLOWED_FILTER_OPERATOR",
          message: `Toán tử lọc '${String(op)}' không hợp lệ.`,
        };
      }
      const typedOp = op as N8nFilterOperator;
      if (
        declaredFilter &&
        !declaredFilter.allowed_operators.includes(typedOp)
      ) {
        return {
          ok: false,
          status: 400,
          code: "DISALLOWED_FILTER_OPERATOR",
          message: `Trường '${fieldName}' chỉ hỗ trợ các toán tử: ${declaredFilter.allowed_operators.join(", ")}.`,
          details: {
            field: fieldName,
            operator: typedOp,
            allowed_operators: declaredFilter.allowed_operators,
          },
        };
      }

      const valueType =
        declaredFilter?.type ?? declaredField?.type ?? "string";
      const val = rawFilter.value;

      if (typedOp === "is_null") {
        if (val !== undefined && typeof val !== "boolean") {
          return {
            ok: false,
            status: 400,
            code: "INVALID_FILTER_VALUE",
            message: `Filter '${fieldName}' với op 'is_null' chỉ nhận value boolean (hoặc bỏ trống).`,
          };
        }
      } else if (typedOp === "in") {
        if (
          !Array.isArray(val) ||
          val.length < 1 ||
          val.length > 50 ||
          !val.every((item) => validateScalarByType(item, valueType))
        ) {
          return {
            ok: false,
            status: 400,
            code: "INVALID_FILTER_VALUE",
            message: `Filter '${fieldName}' với op 'in' phải có value là mảng 1..50 giá trị kiểu ${valueType}.`,
          };
        }
      } else if (typedOp === "between") {
        if (
          !Array.isArray(val) ||
          val.length !== 2 ||
          !validateScalarByType(val[0], valueType) ||
          !validateScalarByType(val[1], valueType)
        ) {
          return {
            ok: false,
            status: 400,
            code: "INVALID_FILTER_VALUE",
            message: `Filter '${fieldName}' với op 'between' phải có value là mảng 2 phần tử [min, max] kiểu ${valueType}.`,
          };
        }
      } else if (!validateScalarByType(val, valueType)) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_FILTER_VALUE",
          message: `Giá trị filter cho trường '${fieldName}' không đúng kiểu ${valueType}.`,
        };
      }

      filters.push({
        field: fieldName,
        op: typedOp,
        value: val,
      });
    }
  }

  // Check required filters declared on the dataset.
  for (const reqFilter of datasetSpec.filters) {
    if (reqFilter.required) {
      const present = filters.some((f) => f.field === reqFilter.field);
      if (!present) {
        return {
          ok: false,
          status: 400,
          code: "MISSING_REQUIRED_FILTER",
          message: `Dataset '${datasetName}' bắt buộc phải có filter '${reqFilter.field}'.`,
          details: {
            dataset: datasetName,
            required_filter: reqFilter.field,
          },
        };
      }
    }
  }

  // Special rule for workers_episodes_lookup: requires national_id or employee_code.
  if (datasetName === "workers_episodes_lookup") {
    const hasLookupKey = filters.some(
      (f) =>
        (f.field === "national_id" || f.field === "employee_code") &&
        f.op === "eq",
    );
    if (!hasLookupKey) {
      return {
        ok: false,
        status: 400,
        code: "MISSING_REQUIRED_FILTER",
        message:
          "Dataset 'workers_episodes_lookup' bắt buộc phải truyền filter eq trên 'national_id' (12 chữ số) hoặc 'employee_code'.",
        details: {
          dataset: datasetName,
          required_any_of: ["national_id", "employee_code"],
        },
      };
    }
  }

  // 10. date_range validation.
  let dateRange: N8nDateRange | null = null;
  if (body.date_range !== undefined && body.date_range !== null) {
    if (!datasetSpec.time_semantics.supports_date_range) {
      return {
        ok: false,
        status: 400,
        code: "DATE_RANGE_NOT_SUPPORTED",
        message: `Dataset '${datasetName}' không hỗ trợ lọc theo date_range.`,
      };
    }
    if (!isRecord(body.date_range)) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_DATE_RANGE",
        message: "date_range phải là object { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }.",
      };
    }
    for (const k of Object.keys(body.date_range)) {
      if (k !== "from" && k !== "to") {
        return {
          ok: false,
          status: 400,
          code: "INVALID_DATE_RANGE",
          message: `Thuộc tính không hợp lệ trong date_range: ${k}.`,
        };
      }
    }
    const { from, to } = body.date_range;
    if (
      typeof from !== "string" ||
      typeof to !== "string" ||
      !isRealCalendarDate(from) ||
      !isRealCalendarDate(to) ||
      from > to
    ) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_DATE_RANGE",
        message:
          "date_range.from và date_range.to phải là ngày thực YYYY-MM-DD và from <= to.",
      };
    }
    dateRange = { from, to };
  }

  // 11. as_of_date validation.
  let asOfDate: string | null = null;
  if (body.as_of_date !== undefined && body.as_of_date !== null) {
    if (!datasetSpec.time_semantics.supports_as_of_date) {
      return {
        ok: false,
        status: 400,
        code: "AS_OF_DATE_NOT_SUPPORTED",
        message: `Dataset '${datasetName}' không hỗ trợ tham số as_of_date.`,
      };
    }
    if (typeof body.as_of_date !== "string" || !isRealCalendarDate(body.as_of_date)) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_AS_OF_DATE",
        message: "as_of_date phải là ngày thực định dạng YYYY-MM-DD.",
      };
    }
    asOfDate = body.as_of_date;
  }

  // 12. sort validation.
  const sortList: N8nQuerySort[] = [];
  if (body.sort !== undefined && body.sort !== null) {
    if (!Array.isArray(body.sort) || body.sort.length > 5) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_SORT",
        message: "sort phải là mảng tối đa 5 tiêu chí sắp xếp.",
      };
    }
    for (const rawSort of body.sort) {
      if (!isRecord(rawSort) || typeof rawSort.field !== "string") {
        return {
          ok: false,
          status: 400,
          code: "INVALID_SORT",
          message: "Mỗi phần tử trong sort phải có { field, direction?: 'asc' | 'desc' }.",
        };
      }
      const fSpec = fieldMap.get(rawSort.field);
      if (!fSpec || !fSpec.sortable) {
        return {
          ok: false,
          status: 400,
          code: "INVALID_SORT",
          message: `Trường '${rawSort.field}' không hỗ trợ sắp xếp trong dataset '${datasetName}'.`,
        };
      }
      const direction = rawSort.direction ?? "desc";
      if (direction !== "asc" && direction !== "desc") {
        return {
          ok: false,
          status: 400,
          code: "INVALID_SORT",
          message: "sort.direction phải là 'asc' hoặc 'desc'.",
        };
      }
      sortList.push({ field: rawSort.field, direction });
    }
  }

  // 13. page_size validation.
  let pageSize = datasetSpec.pagination.default_page_size;
  if (body.page_size !== undefined && body.page_size !== null) {
    if (
      typeof body.page_size !== "number" ||
      !Number.isSafeInteger(body.page_size) ||
      body.page_size < 1 ||
      body.page_size > datasetSpec.pagination.max_page_size
    ) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_PAGE_SIZE",
        message: `page_size cho dataset '${datasetName}' phải là số nguyên từ 1 đến ${datasetSpec.pagination.max_page_size}.`,
        details: {
          dataset: datasetName,
          max_page_size: datasetSpec.pagination.max_page_size,
        },
      };
    }
    pageSize = body.page_size;
  }

  // 14. cursor validation.
  let decodedCursor: N8nDecodedCursor | null = null;
  if (body.cursor !== undefined && body.cursor !== null) {
    if (typeof body.cursor !== "string") {
      return {
        ok: false,
        status: 400,
        code: "INVALID_CURSOR",
        message: "cursor phải là chuỗi token phân trang hợp lệ.",
      };
    }
    decodedCursor = decodeN8nCursor(body.cursor, datasetName);
    if (!decodedCursor) {
      return {
        ok: false,
        status: 400,
        code: "INVALID_CURSOR",
        message: `cursor không hợp lệ hoặc không thuộc về dataset '${datasetName}'.`,
      };
    }
  }

  return {
    ok: true,
    spec: {
      dataset: datasetName,
      datasetSpec,
      mode,
      fields: finalFields,
      explicitFieldsRequested,
      requestedFieldsSet,
      requestedSensitiveFields,
      redactedSensitiveFields,
      measures,
      dimensions,
      filters,
      date_range: dateRange,
      as_of_date: asOfDate,
      sort: sortList,
      page_size: pageSize,
      cursor: decodedCursor,
    },
  };
}

export function findEqFilterString(
  filters: readonly N8nQueryFilter[],
  fieldName: string,
): string | null {
  const found = filters.find((f) => f.field === fieldName && f.op === "eq");
  return found && typeof found.value === "string" ? found.value : null;
}

export function findEqFilterBoolean(
  filters: readonly N8nQueryFilter[],
  fieldName: string,
): boolean | null {
  const found = filters.find((f) => f.field === fieldName && f.op === "eq");
  return found && typeof found.value === "boolean" ? found.value : null;
}

export function findSearchFilterString(
  filters: readonly N8nQueryFilter[],
  fieldName = "search",
): string | null {
  const found = filters.find(
    (f) => f.field === fieldName && (f.op === "contains" || f.op === "eq"),
  );
  return found && typeof found.value === "string" ? found.value : null;
}

export function evaluateRowFilter(
  row: Record<string, unknown>,
  filter: N8nQueryFilter,
): boolean {
  const cellValue = row[filter.field];
  switch (filter.op) {
    case "is_null": {
      const expectNull = filter.value === undefined ? true : Boolean(filter.value);
      return expectNull
        ? cellValue === null || cellValue === undefined
        : cellValue !== null && cellValue !== undefined;
    }
    case "eq":
      if (typeof cellValue === "string" && typeof filter.value === "string") {
        return cellValue.toLowerCase() === filter.value.toLowerCase();
      }
      return cellValue === filter.value;
    case "neq":
      if (typeof cellValue === "string" && typeof filter.value === "string") {
        return cellValue.toLowerCase() !== filter.value.toLowerCase();
      }
      return cellValue !== filter.value;
    case "in":
      if (!Array.isArray(filter.value)) return false;
      return filter.value.some((candidate) =>
        typeof cellValue === "string" && typeof candidate === "string"
          ? cellValue.toLowerCase() === candidate.toLowerCase()
          : cellValue === candidate,
      );
    case "contains":
      if (typeof cellValue !== "string" || typeof filter.value !== "string") {
        return false;
      }
      return cellValue.toLowerCase().includes(filter.value.toLowerCase());
    case "gte":
      if (typeof cellValue === "number" && typeof filter.value === "number") {
        return cellValue >= filter.value;
      }
      if (typeof cellValue === "string" && typeof filter.value === "string") {
        return cellValue >= filter.value;
      }
      return false;
    case "lte":
      if (typeof cellValue === "number" && typeof filter.value === "number") {
        return cellValue <= filter.value;
      }
      if (typeof cellValue === "string" && typeof filter.value === "string") {
        return cellValue <= filter.value;
      }
      return false;
    case "between":
      if (!Array.isArray(filter.value) || filter.value.length !== 2) {
        return false;
      }
      if (
        typeof cellValue === "number" &&
        typeof filter.value[0] === "number" &&
        typeof filter.value[1] === "number"
      ) {
        return cellValue >= filter.value[0] && cellValue <= filter.value[1];
      }
      if (
        typeof cellValue === "string" &&
        typeof filter.value[0] === "string" &&
        typeof filter.value[1] === "string"
      ) {
        return cellValue >= filter.value[0] && cellValue <= filter.value[1];
      }
      return false;
    default:
      return false;
  }
}

export function applyResidualFiltersAndSort(
  rows: readonly Record<string, unknown>[],
  spec: ValidatedN8nQuerySpec,
  alreadyPushedFilterFields: ReadonlySet<string> = new Set(),
): Record<string, unknown>[] {
  const residualFilters = spec.filters.filter(
    (f) => !alreadyPushedFilterFields.has(f.field),
  );

  let filtered = rows.filter((row) =>
    residualFilters.every((f) => evaluateRowFilter(row, f)),
  );

  const dateField = spec.datasetSpec.time_semantics.business_date_field;
  if (
    spec.date_range &&
    dateField &&
    !alreadyPushedFilterFields.has(dateField)
  ) {
    filtered = filtered.filter((row) => {
      const v = row[dateField];
      if (typeof v !== "string") return true;
      return v >= spec.date_range!.from && v <= spec.date_range!.to;
    });
  }

  if (spec.sort.length > 0) {
    filtered = [...filtered].sort((a, b) => {
      for (const s of spec.sort) {
        const av = a[s.field];
        const bv = b[s.field];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv));
        return s.direction === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }

  return filtered;
}

/**
 * Projects only the allowed fields and strictly strips any sensitive field
 * (`sensitive: true`) that was not explicitly requested in `QuerySpec.fields`.
 */
export function projectAndRedactRows(
  rows: readonly Record<string, unknown>[],
  spec: ValidatedN8nQuerySpec,
): Record<string, unknown>[] {
  if (spec.mode === "aggregate") {
    return [];
  }
  const sensitiveSet = new Set(
    spec.datasetSpec.fields.filter((f) => f.sensitive).map((f) => f.name),
  );

  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const fieldName of spec.fields) {
      if (
        sensitiveSet.has(fieldName) &&
        !spec.requestedFieldsSet.has(fieldName)
      ) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
        out[fieldName] = row[fieldName];
      } else {
        out[fieldName] = null;
      }
    }
    return out;
  });
}
