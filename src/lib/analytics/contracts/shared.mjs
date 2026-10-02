/**
 * P1.5-W01 (+R1) — Shared constants + scanners cho contract analytics.
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

/** Team mapping availability (R1 decision). */
/** @type {readonly ["available", "partial", "unavailable", "ambiguous"]} */
export const TEAM_AVAILABILITY = ["available", "partial", "unavailable", "ambiguous"];

/** Trạng thái ổn định đã khóa (R1). */
export const STABILITY_FORMULA = "population_stddev / mean";
export const STABILITY_FORMULA_VERSION = "cv-population/1.0";
export const VOLATILITY_LOW_MAX = 0.25; // cv < 0.25 => low
export const VOLATILITY_MEDIUM_MAX = 0.5; // 0.25 <= cv < 0.50 => medium; cv >= 0.50 => high
export const STABILITY_MIN_POINTS = 4;

export const MAX_FINDINGS = 7;
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
export const TEAM_SUBJECT_REF_RE = /^team_[0-9]{2,}$/;
export const EVIDENCE_ID_RE = /^ev_[0-9]{2,}$/;
export const FINDING_ID_RE = /^f_[0-9]{2}$/;
export const METRIC_KEY_RE = /^[a-z][a-z0-9_.\[\]-]{0,63}$/;
export const FORMULA_RE = /^[a-z0-9_.\[\]()+\-*/ ,_=<>!]{1,200}$/;
export const SOURCE_REF_RE = /^source_[0-9]{2,}$/;

// --- period_ref (R1): prefix bắt buộc khớp period.type ----------------------

export const PERIOD_REF_WEEK_RE = /^week:[0-9]{4}-W(?:0[1-9]|[1-4][0-9]|5[0-3])$/;
export const PERIOD_REF_MONTH_RE = /^month:[0-9]{4}-(?:0[1-9]|1[0-2])$/;
export const PERIOD_REF_QUARTER_RE = /^quarter:[0-9]{4}-Q[1-4]$/;
export const PERIOD_REF_CUSTOM_RE = /^custom:[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export const PERIOD_REF_RE = /^(?:week:[0-9]{4}-W(?:0[1-9]|[1-4][0-9]|5[0-3])|month:[0-9]{4}-(?:0[1-9]|1[0-2])|quarter:[0-9]{4}-Q[1-4]|custom:[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9]{4}-[0-9]{2}-[0-9]{2})$/;
export const PERIOD_REF_RE_BY_TYPE = {
  week: PERIOD_REF_WEEK_RE,
  month: PERIOD_REF_MONTH_RE,
  quarter: PERIOD_REF_QUARTER_RE,
  custom: PERIOD_REF_CUSTOM_RE,
};

/** Prefix (`week`/`month`/`quarter`/`custom`) của một period_ref hợp lệ. */
export function periodRefPrefix(ref) {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const prefix = ref.slice(0, i);
  return PERIOD_TYPES.includes(prefix) ? prefix : null;
}

/** Ngày start/end của custom ref (`custom:YYYY-MM-DD/YYYY-MM-DD`). */
export function customRefRange(ref) {
  if (typeof ref !== "string") return null;
  const m = /^custom:([0-9]{4}-[0-9]{2}-[0-9]{2})\/([0-9]{4}-[0-9]{2}-[0-9]{2})$/.exec(ref);
  return m ? { start: m[1], end: m[2] } : null;
}

// ---------------------------------------------------------------------------
// Prohibited-content scanners (input packet + output report dùng chung)
// ---------------------------------------------------------------------------

export const PII_PATTERNS = [
  { code: "PII_EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { code: "PII_PHONE_VN", re: /(?:\+84|\b0)\d{9,10}\b/ },
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

/** Cụm từ bắt buộc phải có khi report không có finding nào (R1). */
export const LIMITATION_PHRASES = [
  /chưa\s+đủ\s+(?:dữ\s+liệu|baseline)/i,
  /không\s+đủ\s+(?:dữ\s+liệu|baseline|điểm)/i,
  /thiếu\s+(?:dữ\s+liệu|baseline)/i,
  /giới\s+hạn\s+(?:dữ\s+liệu|độ\s+tin\s+cậy|phân\s+tích)/i,
  /chưa\s+thể\s+kết\s+luận/i,
  /không\s+thể\s+kết\s+luận/i,
  /dữ\s+liệu\s+(?:chưa|không)\s+đầy\s+đủ/i,
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

/** Bỏ ISO date khỏi text trước khi trích số (tránh 2026/10/01 thành claim số). */
export function stripIsoDates(text) {
  return String(text).replace(/\d{4}-\d{2}-\d{2}/g, " ");
}

/** Trích các token số (có/không dấu %) từ text; bỏ qua năm 4 chữ số. */
export function extractNumericTokens(text) {
  const out = [];
  const re = /\d+(?:[.,]\d+)?%?/g;
  let m;
  while ((m = re.exec(stripIsoDates(text))) !== null) {
    if (/^(?:19|20)\d{2}$/.test(m[0])) continue;
    out.push(m[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit-aware numeric grounding (R1 — bỏ dung sai ±1/2% và bỏ quy đổi ×100 vô điều kiện)
// ---------------------------------------------------------------------------

export const GROUNDING_RULES_VERSION = "unit-grounding/1.0";

/** Đơn vị "đếm được" — chỉ ground claim số không có dấu % và khớp CHÍNH XÁC giá trị. */
export const COUNT_UNITS = ["people", "count", "days"];
/** Số chữ số thập phân được phép cho từng dạng representation (deterministic, có version). */
export const RATIO_PLAIN_DECIMALS = [2, 3];
export const RATIO_PERCENT_DECIMALS = [0, 1, 2];
export const PERCENT_DECIMALS = [0, 1, 2];

function roundTo(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/** Chuẩn hóa số thành chuỗi ổn định (bỏ -0, bỏ trailing zero của JS String). */
export function canonicalNumber(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const v = Object.is(n, -0) ? 0 : n;
  return String(v);
}

/**
 * Tập token được phép ground từ MỘT evidence, tách theo dạng claim:
 * - `plain`: claim số không có dấu % (theo unit của evidence).
 * - `percent`: claim có dấu % (chỉ ratio/percent).
 * Không có dung sai: claim phải khớp chính xác một representation deterministic.
 */
export function groundingSetsFor(evidence) {
  const plain = new Set();
  const percent = new Set();
  const unit = evidence && evidence.unit;
  const v = evidence && evidence.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return { plain, percent };

  if (COUNT_UNITS.includes(unit)) {
    plain.add(canonicalNumber(v));
    plain.add(canonicalNumber(Math.abs(v))); // "giảm 6" cho delta -6
  } else if (unit === "ratio") {
    plain.add(canonicalNumber(v));
    for (const d of RATIO_PLAIN_DECIMALS) plain.add(canonicalNumber(roundTo(v, d)));
    const p = v * 100;
    percent.add(canonicalNumber(p));
    for (const d of RATIO_PERCENT_DECIMALS) percent.add(canonicalNumber(roundTo(p, d)));
  } else if (unit === "percent") {
    plain.add(canonicalNumber(v));
    for (const d of PERCENT_DECIMALS) plain.add(canonicalNumber(roundTo(v, d)));
    percent.add(canonicalNumber(v));
    for (const d of PERCENT_DECIMALS) percent.add(canonicalNumber(roundTo(v, d)));
  }
  return { plain, percent };
}

/** Chuẩn hóa token claim: bỏ %, đổi ',' thập phân thành '.'. */
export function normalizeNumericToken(token) {
  return String(token).replace("%", "").replace(",", ".");
}

/** Token có ground được bởi tập hợp ground đã gộp không (không dung sai). */
export function isGroundedToken(token, groundSets) {
  const isPercent = String(token).endsWith("%");
  const set = isPercent ? groundSets.percent : groundSets.plain;
  return set.has(normalizeNumericToken(token));
}

/** Gộp ground sets của nhiều evidence. */
export function mergeGroundingSets(evidenceList) {
  const plain = new Set();
  const percent = new Set();
  for (const e of evidenceList) {
    const s = groundingSetsFor(e);
    for (const x of s.plain) plain.add(x);
    for (const x of s.percent) percent.add(x);
  }
  return { plain, percent };
}
