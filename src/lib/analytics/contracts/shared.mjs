/**
 * P1.5-W01 — Shared constants + scanners cho contract analytics.
 *
 * Module này là .mjs (không phải .ts) có chủ đích: các module .ts của contract import
 * nó bằng specifier có extension ("./shared.mjs") nên Node chạy test trực tiếp được,
 * đồng thời tsc (allowJs + moduleResolution bundler) vẫn resolve bình thường.
 *
 * KHÔNG chứa secret, KHÔNG gọi mạng, KHÔNG đọc DB.
 */

export const ANALYSIS_PACKET_VERSION = "analysis-packet/0.1";
export const BUSINESS_ANALYSIS_VERSION = "business-analysis/0.1";
export const TIMEZONE = "Asia/Ho_Chi_Minh";

/** @type {readonly ["week", "month", "quarter", "custom"]} */
export const PERIOD_TYPES = ["week", "month", "quarter", "custom"];
/** @type {readonly ["complete", "period_to_date"]} */
export const PERIOD_STATUS = ["complete", "period_to_date"];
/** @type {readonly ["project", "recruiter", "team", "provider", "employment"]} */
export const DIMENSIONS = ["project", "recruiter", "team", "provider", "employment"];
/** @type {readonly ["up", "down", "flat", "unknown"]} */
export const TREND_DIRECTIONS = ["up", "down", "flat", "unknown"];
/** @type {readonly ["low", "medium", "high", "unknown"]} */
export const VOLATILITY_LEVELS = ["low", "medium", "high", "unknown"];
/** @type {readonly ["low", "medium", "high"]} */
export const CONFIDENCE_LEVELS = ["low", "medium", "high"];
/** @type {readonly ["trend", "driver", "strength", "risk", "concentration", "provider_mix", "time_pattern", "data_quality"]} */
export const FINDING_CATEGORIES = [
  "trend",
  "driver",
  "strength",
  "risk",
  "concentration",
  "provider_mix",
  "time_pattern",
  "data_quality",
];
/** @type {readonly ["people", "percent", "ratio", "count", "days"]} */
export const UNITS = ["people", "percent", "ratio", "count", "days"];
/** @type {readonly ["met", "not_met", "unknown"]} */
export const SUFFICIENCY_STATUS = ["met", "not_met", "unknown"];
/** @type {readonly ["ok", "partial", "failed", "unknown"]} */
export const QUALITY_STATUS = ["ok", "partial", "failed", "unknown"];
/** @type {readonly ["covered", "incomplete", "stale_snapshot", "never_succeeded", "running", "no_run"]} */
export const SOURCE_STATUSES = ["covered", "incomplete", "stale_snapshot", "never_succeeded", "running", "no_run"];
/** @type {readonly ["draft"]} */
export const REPORT_STATUSES = ["draft"];

/** Baseline tối thiểu (số period point hoàn tất) — vượt baseline mới được confidence cao. */
export const SUFFICIENCY_REQUIREMENTS = {
  trend_weekly: 4,
  trend_monthly: 3,
  trend_quarterly: 4,
  day_of_week: 8,
  consistency: 4,
};

/** @type {readonly ["trend_weekly", "trend_monthly", "trend_quarterly", "day_of_week", "consistency"]} */
export const SUFFICIENCY_KEYS = ["trend_weekly", "trend_monthly", "trend_quarterly", "day_of_week", "consistency"];

/** Catalog key đóng của provider/employment (contract ingestion v0.2) — không phải free text. */
/** @type {readonly ["hrp", "vendor", "__unknown__", "__invalid__", "thời vụ", "chính thức"]} */
export const CATALOG_KEYS = ["hrp", "vendor", "__unknown__", "__invalid__", "thời vụ", "chính thức"];

export const MAX_FINDINGS = 7;
export const MIN_FINDINGS_WHEN_SUFFICIENT = 3;
export const MAX_RECOMMENDED_ACTIONS = 3;
export const SCOPE_SUBJECT_REF = "scope";

// ---------------------------------------------------------------------------
// Shape guards (chỉ cho phép dữ liệu có cấu trúc — không free-text tự do)
// ---------------------------------------------------------------------------

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const HASH_RE = /^[a-f0-9]{16,64}$/;
export const OPAQUE_REF_RE = /^(?:project|recruiter|team)_[0-9]{2,}$/;
export const PROVIDER_REF_RE = /^provider_(?:hrp|vendor|unknown|invalid)$/;
export const EMPLOYMENT_REF_RE = /^employment_(?:seasonal|official|unknown|invalid)$/;
export const SUBJECT_REF_RE = /^(?:scope|(?:project|recruiter|team)_[0-9]{2,}|provider_(?:hrp|vendor|unknown|invalid)|employment_(?:seasonal|official|unknown|invalid))$/;
export const EVIDENCE_ID_RE = /^ev_[0-9]{2,}$/;
export const FINDING_ID_RE = /^f_[0-9]{2}$/;
export const PERIOD_REF_RE = /^period_[A-Za-z0-9_:-]{3,40}$/;
export const METRIC_KEY_RE = /^[a-z][a-z0-9_.\[\]-]{0,63}$/;
export const FORMULA_RE = /^[a-z0-9_.\[\]()+\-*/ ,_=<>!]{1,200}$/;
export const SOURCE_REF_RE = /^source_[0-9]{2,}$/;

// ---------------------------------------------------------------------------
// Prohibited-content scanners (input packet + output report dùng chung)
// ---------------------------------------------------------------------------

export const PII_PATTERNS = [
  { code: "PII_EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { code: "PII_PHONE_VN", re: /(?:\+84|0)(?:\d[ .-]?){9,10}\b/ },
  { code: "PII_CCCD", re: /\b\d{9}\b|\b\d{12}\b/ },
  { code: "PII_DOB", re: /\b(?:19|20)\d{2}-\d{2}-\d{2}\b.*(?:sinh|birth)/i },
];

export const SECRET_PATTERNS = [
  { code: "SECRET_OPENAI_KEY", re: /sk-[A-Za-z0-9_-]{16,}/ },
  { code: "SECRET_JWT", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/ },
  { code: "SECRET_NAMED_KEY", re: /(?:service_role|anon[ _-]?key|api[ _-]?key|bearer\s+[A-Za-z0-9._-]{20,})/i },
  { code: "SECRET_SUPABASE", re: /supabase\.co|pooler\.supabase\.com/i },
];

export const PROMPT_INJECTION_PATTERNS = [
  { code: "PROMPT_INJECTION_OVERRIDE", re: /ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions/i },
  { code: "PROMPT_INJECTION_SYSTEM", re: /system\s*(?:prompt|message)|you\s+are\s+now|act\s+as\s+(?:an?\s+)?(?:ai|assistant)/i },
  { code: "PROMPT_INJECTION_TEMPLATE", re: /\{\{[^}]{1,80}\}\}|\$\{[^}]{1,80}\}/ },
  { code: "PROMPT_INJECTION_TOOL", re: /<\s*(?:script|iframe|img\s+src)|javascript:/i },
];

export const PROHIBITED_CLAIM_PATTERNS = [
  {
    code: "PROHIBITED_PERFORMANCE_JUDGEMENT",
    re: /kém\s+hiệu\s+quả|hiệu\s+quả\s+kém|năng\s+lực\s+(?:kém|yếu)|yếu\s+kém|kém\s+cỏi|không\s+có\s+năng\s+lực|underperform|incompetent|low\s+performer/i,
  },
  {
    code: "PROHIBITED_DISCIPLINARY_ACTION",
    re: /sa\s+thải|kỷ\s+luật|chấm\s+dứt\s+(?:lao\s+động|hợp\s+đồng)|trừ\s+lương|cắt\s+thưởng|điều\s+chuyển\s+(?:công\s+tác|vị\s+trí)|terminate|fire\s+(?:him|her|them)|demote/i,
  },
  {
    code: "PROHIBITED_CAUSAL_CLAIM",
    re: /chắc\s+chắn\s+(?:là\s+)?do|nguyên\s+nhân\s+(?:chính\s+)?là\s+do\s+(?:thị\s+trường|dịch|kinh\s+tế)|vì\s+(?:thị\s+trường|dịch\s+bệnh)\s+nên/i,
  },
];

const ALL_SCANNERS = [
  ...PII_PATTERNS,
  ...SECRET_PATTERNS,
  ...PROMPT_INJECTION_PATTERNS,
  ...PROHIBITED_CLAIM_PATTERNS,
];

/** Quét mọi string trong một giá trị JSON (đệ quy) và trả về lỗi đầu tiên tìm được. */
export function scanProhibitedContent(value, path = "$") {
  if (typeof value === "string") {
    for (const { code, re } of ALL_SCANNERS) {
      if (re.test(value)) return { code, path, message: "Nội dung bị cấm (" + code + ") tại " + path };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanProhibitedContent(value[i], path + "[" + i + "]");
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const hit = scanProhibitedContent(value[key], path + "." + key);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

/** Trích các token số từ text (dùng cho kiểm tra claim số phải đối chiếu được evidence). */
export function extractNumericTokens(text) {
  const out = [];
  const re = /\d+(?:[.,]\d+)?%?/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

/**
 * Tập số được phép "ground" từ một evidence: value gốc + các dạng percent/ratio/round
 * (claim trong report phải khớp một trong các dạng này, sai số cho phép ở phía validator).
 */
export function groundableNumberSet(evidence) {
  const out = [];
  const add = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return;
    out.push(n, Math.round(n), n * 100, Math.round(n * 100), Math.round(n * 1000) / 10, Math.round(n * 10) / 10);
  };
  add(evidence.value);
  add(Math.abs(evidence.value)); // report thường viết "giảm N" cho delta âm
  return out;
}

/** Claim số có khớp tập ground không (dung sai ±1 hoặc 2%). */
export function isGroundedNumber(num, groundSet) {
  return groundSet.some((a) => Math.abs(a - num) <= Math.max(1, Math.abs(num) * 0.02));
}
