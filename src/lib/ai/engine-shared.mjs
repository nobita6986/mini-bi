/**
 * P1.5-W03 — Shared runtime thuần cho deterministic analytics feature engine.
 *
 * Module .mjs có chủ đích (giống P1.5-W02): module .ts của engine import bằng specifier có
 * extension ("./engine-shared.mjs") nên Node chạy test trực tiếp được mà không cần
 * allowImportingTsExtensions (không sửa tsconfig).
 *
 * Thuần + deterministic: không DB, không mạng, không AI, không secret, không `Date.now()`.
 * Mọi thời điểm đều do caller truyền vào (as_of_date / generated_at).
 */

export const FEATURE_ENGINE_VERSION = "feature-engine/0.1";
export const TIMEZONE = "Asia/Ho_Chi_Minh";

/** @type {readonly ["week", "month", "quarter", "custom"]} */
export const PERIOD_TYPES = ["week", "month", "quarter", "custom"];
/** @type {readonly ["complete", "period_to_date"]} */
export const PERIOD_STATUS = ["complete", "period_to_date"];
/** @type {readonly ["project", "recruiter", "team", "provider", "employment"]} */
export const DIMENSIONS = ["project", "recruiter", "team", "provider", "employment"];
/** @type {readonly ["day", "week"]} */
export const SERIES_GRANULARITY = ["day", "week"];
/** @type {readonly ["covered", "incomplete", "stale_snapshot", "never_succeeded", "running", "no_run"]} */
export const SOURCE_STATUSES = ["covered", "incomplete", "stale_snapshot", "never_succeeded", "running", "no_run"];
/** @type {readonly ["ok", "partial", "failed", "unknown"]} */
export const QUALITY_STATUS = ["ok", "partial", "failed", "unknown"];
/** @type {readonly ["met", "not_met", "unknown"]} */
export const SUFFICIENCY_STATUS = ["met", "not_met", "unknown"];
/** @type {readonly ["up", "down", "flat", "unknown"]} */
export const TREND_DIRECTIONS = ["up", "down", "flat", "unknown"];
/** @type {readonly ["low", "medium", "high", "unknown"]} */
export const VOLATILITY_LEVELS = ["low", "medium", "high", "unknown"];
/** @type {readonly ["mapped", "unmapped", "ambiguous"]} */
export const IDENTITY_CLASSIFICATIONS = ["mapped", "unmapped", "ambiguous"];
/** @type {readonly ["available", "partial", "unavailable", "ambiguous"]} */
export const TEAM_AVAILABILITY = ["available", "partial", "unavailable", "ambiguous"];
/** @type {readonly ["ok", "unknown", "invalid"]} */
export const DIMENSION_QUALITY = ["ok", "unknown", "invalid"];

/** Sentinel dùng chung với ingestion contract v0.2. */
export const UNKNOWN_DIMENSION_KEY = "__unknown__";
export const INVALID_DIMENSION_KEY = "__invalid__";

/** Danh mục đóng của provider/employment (cột J/L). */
export const PROVIDER_FACT_KEYS = ["hrp", "vendor", UNKNOWN_DIMENSION_KEY, INVALID_DIMENSION_KEY];
export const EMPLOYMENT_FACT_KEYS = ["thời vụ", "chính thức", UNKNOWN_DIMENSION_KEY, INVALID_DIMENSION_KEY];

/** Ref opaque cho provider/employment + catalog_key tương ứng (khớp contract 0.1). */
export const PROVIDER_SUBJECTS = {
  hrp: { ref: "provider_hrp", catalog_key: "hrp" },
  vendor: { ref: "provider_vendor", catalog_key: "vendor" },
  [UNKNOWN_DIMENSION_KEY]: { ref: "provider_unknown", catalog_key: UNKNOWN_DIMENSION_KEY },
  [INVALID_DIMENSION_KEY]: { ref: "provider_invalid", catalog_key: INVALID_DIMENSION_KEY },
};
export const EMPLOYMENT_SUBJECTS = {
  "thời vụ": { ref: "employment_seasonal", catalog_key: "thời vụ" },
  "chính thức": { ref: "employment_official", catalog_key: "chính thức" },
  [UNKNOWN_DIMENSION_KEY]: { ref: "employment_unknown", catalog_key: UNKNOWN_DIMENSION_KEY },
  [INVALID_DIMENSION_KEY]: { ref: "employment_invalid", catalog_key: INVALID_DIMENSION_KEY },
};

/** Baseline an toàn (khớp SUFFICIENCY_REQUIREMENTS của contract 0.1 — KHÔNG tự hạ ngưỡng). */
export const BASELINE_REQUIREMENTS = {
  trend_weekly: 4,
  trend_monthly: 3,
  trend_quarterly: 4,
  day_of_week: 8,
  consistency: 4,
};
/** @type {readonly ["trend_weekly", "trend_monthly", "trend_quarterly", "day_of_week", "consistency"]} */
export const SUFFICIENCY_KEYS = ["trend_weekly", "trend_monthly", "trend_quarterly", "day_of_week", "consistency"];

export const STABILITY_FORMULA = "population_stddev / mean";
export const STABILITY_FORMULA_VERSION = "cv-population/1.0";
export const VOLATILITY_LOW_MAX = 0.25;
export const VOLATILITY_MEDIUM_MAX = 0.5;
export const STABILITY_MIN_POINTS = 4;

export const MAX_PERIOD_DAYS = 400;
export const MAX_SERIES_POINTS = 400;
export const MAX_BASELINE_WEEKS = 12;
export const MAX_BASELINE_MONTHS = 12;
export const MAX_BASELINE_QUARTERS = 12;
export const MAX_STABILITY_POINTS = 12;
export const MAX_DAY_OF_WEEK_WEEKS = 52;
/** Trần subject mỗi dimension = trần của contract 0.1; vượt ⇒ fail-closed (không cắt âm thầm). */
export const MAX_DRIVER_SUBJECTS = 500;
export const MAX_EVIDENCE_RECORDS = 500;

/**
 * Central formula registry — engine KHÔNG rải string công thức tuỳ ý.
 * formula phải khớp FORMULA_RE của contract 0.1 (chữ thường, không dấu hai chấm).
 * formula_version phải khớp ^[a-z0-9_.-]{1,20}$.
 */
export const FORMULA_REGISTRY = {
  recruited_total: { formula: "sum(recruited_count)", formula_version: "v0.1" },
  recruited_total_comparable: { formula: "sum(recruited_count) comparable window", formula_version: "v0.1" },
  recruited_delta: { formula: "current - comparable", formula_version: "v0.1" },
  recruited_delta_pct: { formula: "(current - comparable) / comparable", formula_version: "v0.1" },
  driver_current: { formula: "sum(recruited_count) by subject", formula_version: "v0.1" },
  driver_comparable: { formula: "sum(recruited_count) by subject comparable window", formula_version: "v0.1" },
  driver_delta: { formula: "subject_current - subject_comparable", formula_version: "v0.1" },
  driver_delta_contribution_share: {
    formula: "abs(subject_delta) / sum(abs(subject_delta)) same dimension",
    formula_version: "v0.1",
  },
  driver_share_of_current: { formula: "subject_current / totals.current", formula_version: "v0.1" },
  breakdown_remainder: { formula: "totals.current - sum(dimension subject_current)", formula_version: "v0.1" },
  concentration_top1_share: { formula: "max(subject_current) / totals.current", formula_version: "v0.1" },
  concentration_top3_share: { formula: "sum(top3 subject_current) / totals.current", formula_version: "v0.1" },
  stability_mean: { formula: "sum(period_point_values) / period_points", formula_version: "cv-population-1.0" },
  stability_stddev: {
    formula: "sqrt(sum((x - mean) * (x - mean)) / period_points)",
    formula_version: "cv-population-1.0",
  },
  stability_cv: { formula: "population_stddev / mean", formula_version: "cv-population-1.0" },
  project_total: { formula: "sum(recruited_count) by project", formula_version: "v0.1" },
  project_hrp_count: { formula: "sum(recruited_count) by project where provider hrp", formula_version: "v0.1" },
  project_vendor_count: { formula: "sum(recruited_count) by project where provider vendor", formula_version: "v0.1" },
  project_unknown_count: { formula: "sum(recruited_count) by project where provider unknown", formula_version: "v0.1" },
  project_invalid_count: { formula: "sum(recruited_count) by project where provider invalid", formula_version: "v0.1" },
  project_known_total: { formula: "hrp_count + vendor_count", formula_version: "v0.1" },
  project_hrp_share: { formula: "hrp_count / known_total", formula_version: "v0.1" },
  project_vendor_share: { formula: "vendor_count / known_total", formula_version: "v0.1" },
  project_known_coverage: { formula: "(hrp_count + vendor_count) / project_total", formula_version: "v0.1" },
  data_quality_source_coverage: {
    formula: "sources_with_current_facts / expected_sources",
    formula_version: "v0.1",
  },
  /** unknown/invalid là hai chỉ số ĐỘC LẬP (grain vừa unknown vừa invalid tính vào cả hai). */
  data_quality_unknown_count: {
    formula: "sum(recruited_count) grain has any unknown dimension",
    formula_version: "v0.1",
  },
  data_quality_invalid_count: {
    formula: "sum(recruited_count) grain has any invalid dimension",
    formula_version: "v0.1",
  },
  data_quality_unknown_invalid_overlap_count: {
    formula: "sum(recruited_count) grain has both unknown and invalid dimension",
    formula_version: "v0.1",
  },
  comparison_unavailable_ptd_equal_window: {
    formula: "1 if comparable null because equal window unavailable else 0",
    formula_version: "v0.1",
  },
  comparison_unavailable_incomplete_window: {
    formula: "1 if comparable null because comparison window not fully covered else 0",
    formula_version: "v0.1",
  },
  scope_filter_active: {
    formula: "1 if scope filter present on dimension else 0",
    formula_version: "v0.1",
  },
  series_point_value: { formula: "sum(recruited_count) by series bucket", formula_version: "v0.1" },
};

// ---------------------------------------------------------------------------
// Date / period math (thuần, chuỗi YYYY-MM-DD, UTC nội bộ)
// ---------------------------------------------------------------------------

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value) {
  return typeof value === "string" && ISO_DATE_RE.test(value);
}

/** Ngày lịch thật (loại 2026-02-30). */
export function isRealCalendarDate(value) {
  if (!isIsoDate(value)) return false;
  const parts = value.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return dt.getUTCFullYear() === parts[0] && dt.getUTCMonth() === parts[1] - 1 && dt.getUTCDate() === parts[2];
}

const DAY_MS = 86400000;

export function toUtcMs(date) {
  const parts = date.split("-").map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

export function fromUtcMs(ms) {
  const d = new Date(ms);
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

export function addDays(date, days) {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Số ngày của khoảng bao gồm cả hai đầu. */
export function inclusiveDays(start, end) {
  return Math.round((toUtcMs(end) - toUtcMs(start)) / DAY_MS) + 1;
}

export function enumerateDates(start, end) {
  const out = [];
  const last = toUtcMs(end);
  for (let ms = toUtcMs(start); ms <= last; ms += DAY_MS) out.push(fromUtcMs(ms));
  return out;
}

/** Thứ trong tuần theo ISO: Thứ Hai = 1 ... Chủ Nhật = 7. */
export function isoDayOfWeek(date) {
  const dow = new Date(toUtcMs(date)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Tuần ISO 8601 (thứ Hai → Chủ Nhật) chứa ngày. */
export function isoWeekOf(date) {
  const ms = toUtcMs(date);
  const dow = isoDayOfWeek(date);
  const thursday = ms + (4 - dow) * DAY_MS;
  const thursdayDate = new Date(thursday);
  const isoYear = thursdayDate.getUTCFullYear();
  const jan4 = Date.UTC(isoYear, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  const week1Monday = jan4 - (jan4Dow - 1) * DAY_MS;
  const week = Math.round((thursday - week1Monday) / (7 * DAY_MS)) + 1;
  return { year: isoYear, week };
}

/** Thứ Hai của tuần ISO (year, week). */
export function isoWeekStart(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = new Date(jan4).getUTCDay() || 7;
  const week1Monday = jan4 - (jan4Dow - 1) * DAY_MS;
  return fromUtcMs(week1Monday + (week - 1) * 7 * DAY_MS);
}

export function isoWeekRef(year, week) {
  return "week:" + String(year).padStart(4, "0") + "-W" + String(week).padStart(2, "0");
}

export function monthRef(year, month) {
  return "month:" + String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0");
}

export function monthBounds(year, month) {
  const start = fromUtcMs(Date.UTC(year, month - 1, 1));
  const end = fromUtcMs(Date.UTC(year, month, 0));
  return { start, end };
}

export function quarterRef(year, quarter) {
  return "quarter:" + String(year).padStart(4, "0") + "-Q" + String(quarter);
}

export function quarterBounds(year, quarter) {
  const startMonth = (quarter - 1) * 3 + 1;
  const start = fromUtcMs(Date.UTC(year, startMonth - 1, 1));
  const end = fromUtcMs(Date.UTC(year, startMonth + 2, 0));
  return { start, end };
}

export function quarterOf(date) {
  const month = Number(date.slice(5, 7));
  return { year: Number(date.slice(0, 4)), quarter: Math.floor((month - 1) / 3) + 1 };
}

/** Kỳ hoàn tất liền trước (cùng loại). */
export function previousPeriodWindow(type, start) {
  if (type === "week") {
    const prev = addDays(start, -1);
    const { year, week } = isoWeekOf(prev);
    const s = isoWeekStart(year, week);
    return { period_ref: isoWeekRef(year, week), start: s, end: addDays(s, 6) };
  }
  if (type === "month") {
    const y = Number(start.slice(0, 4));
    const m = Number(start.slice(5, 7));
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    const b = monthBounds(prevY, prevM);
    return { period_ref: monthRef(prevY, prevM), start: b.start, end: b.end };
  }
  if (type === "quarter") {
    const y = Number(start.slice(0, 4));
    const q = Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1;
    const prevY = q === 1 ? y - 1 : y;
    const prevQ = q === 1 ? 4 : q - 1;
    const b = quarterBounds(prevY, prevQ);
    return { period_ref: quarterRef(prevY, prevQ), start: b.start, end: b.end };
  }
  return null;
}

/**
 * Kế hoạch kỳ: current window + comparable + status PTD.
 * Input đã được validate (type/ngày) trước khi gọi.
 */
export function buildPeriodPlan(period) {
  const asOf = period.as_of_date;
  let type = period.type;
  let periodRef;
  let start;
  let end;

  if (type === "week") {
    const { year, week } = isoWeekOf(asOf);
    start = isoWeekStart(year, week);
    end = addDays(start, 6);
    periodRef = isoWeekRef(year, week);
  } else if (type === "month") {
    const y = Number(asOf.slice(0, 4));
    const m = Number(asOf.slice(5, 7));
    const b = monthBounds(y, m);
    start = b.start;
    end = b.end;
    periodRef = monthRef(y, m);
  } else if (type === "quarter") {
    const { year, quarter } = quarterOf(asOf);
    const b = quarterBounds(year, quarter);
    start = b.start;
    end = b.end;
    periodRef = quarterRef(year, quarter);
  } else {
    start = period.custom_from;
    end = period.custom_to;
    periodRef = "custom:" + start + "/" + end;
  }

  const complete = end <= asOf;
  const effectiveEnd = complete ? end : asOf;
  const elapsedDays = inclusiveDays(start, effectiveEnd);
  const status = complete ? "complete" : "period_to_date";

  /**
   * PTD equal-window: chỉ so khi kỳ liền trước ĐỦ số ngày đã trôi qua.
   * Kỳ trước ngắn hơn (tháng 2, quý ngắn hơn) ⇒ comparable = null (KHÔNG cắt bớt rồi so
   * 30/31 ngày với 28/29 ngày) và ghi reason code deterministic.
   */
  let comparable = null;
  let comparableUnavailableReason = null;
  if (type === "custom") {
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -(elapsedDays - 1));
    comparable = { period_ref: "custom:" + prevStart + "/" + prevEnd, start: prevStart, end: prevEnd, elapsed_days: elapsedDays };
  } else {
    const prev = previousPeriodWindow(type, start);
    if (complete) {
      comparable = { period_ref: prev.period_ref, start: prev.start, end: prev.end, elapsed_days: inclusiveDays(prev.start, prev.end) };
    } else if (inclusiveDays(prev.start, prev.end) < elapsedDays) {
      comparable = null;
      comparableUnavailableReason = "PTD_EQUAL_WINDOW_UNAVAILABLE";
    } else {
      comparable = {
        period_ref: prev.period_ref,
        start: prev.start,
        end: addDays(prev.start, elapsedDays - 1),
        elapsed_days: elapsedDays,
      };
    }
  }

  return {
    type,
    period_ref: periodRef,
    start,
    end,
    status,
    period_to_date: !complete,
    elapsed_days: elapsedDays,
    effective_end: effectiveEnd,
    comparable,
    comparable_unavailable_reason: comparableUnavailableReason,
  };
}

/** Danh sách kỳ hoàn tất liền trước, dừng ngay khi vượt khỏi vùng có dữ liệu. */
export function buildBaselineWindows(type, start, dataStart, maxCount) {
  const out = [];
  if (!dataStart) return out;
  let cursor = start;
  for (let i = 0; i < maxCount; i++) {
    const prev = type === "week" ? previousPeriodWindow("week", cursor) : type === "month" ? previousPeriodWindow("month", cursor) : previousPeriodWindow("quarter", cursor);
    if (!prev) break;
    if (prev.start < dataStart) break;
    out.push(prev);
    cursor = prev.start;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canonical JSON + sha256 (self-contained, không phụ thuộc node:crypto)
// ---------------------------------------------------------------------------

/** JSON canonical: sort key đệ quy, số non-finite ⇒ null (để validator contract chặn). */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 hex (64 ký tự) — deterministic, độc lập môi trường. */
export function sha256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const len = bytes.length;
  const totalLen = Math.ceil((len + 9) / 64) * 64;
  const msg = new Uint8Array(totalLen);
  msg.set(bytes);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  const bitLen = len * 8;
  view.setUint32(totalLen - 8, Math.floor(bitLen / 4294967296));
  view.setUint32(totalLen - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, "0");
  return out;
}

/** Hash canonical của một giá trị bất kỳ (dùng cho snapshot/scope hash). */
export function canonicalHash(value) {
  return sha256Hex(canonicalJson(value));
}

// ---------------------------------------------------------------------------
// Thống kê + ref opaque
// ---------------------------------------------------------------------------

export function meanOf(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation (chia cho N, không phải N-1). */
export function populationStddevOf(values) {
  if (values.length === 0) return null;
  const mean = meanOf(values);
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  return Math.sqrt(acc / values.length);
}

export function volatilityBand(cv) {
  if (cv === null) return "unknown";
  if (cv < VOLATILITY_LOW_MAX) return "low";
  if (cv < VOLATILITY_MEDIUM_MAX) return "medium";
  return "high";
}

export function formatOpaqueRef(prefix, ordinal) {
  return prefix + "_" + String(ordinal).padStart(2, "0");
}

/** Map key -> opaque ref, deterministic theo sort tăng dần của key. */
export function buildRefMap(prefix, keys) {
  const map = new Map();
  [...new Set(keys)].sort().forEach((key, i) => map.set(key, formatOpaqueRef(prefix, i + 1)));
  return map;
}

/** Chất lượng của một chiều free text theo sentinel ingestion. */
export function sentinelQualityOf(key) {
  if (key === UNKNOWN_DIMENSION_KEY) return "unknown";
  if (key === INVALID_DIMENSION_KEY) return "invalid";
  return "ok";
}

export function isSentinelKey(key) {
  return key === UNKNOWN_DIMENSION_KEY || key === INVALID_DIMENSION_KEY;
}

// ---------------------------------------------------------------------------
// Privacy: whitelist key/value bị cấm trong packet
// ---------------------------------------------------------------------------

/** Key TUYỆT ĐỐI không được xuất hiện trong packet (mọi cấp). */
export const FORBIDDEN_PACKET_KEYS = [
  "ref_map",
  "server_diagnostics",
  "diagnostics",
  "recruiter_id",
  "team_id",
  "membership_id",
  "alias_id",
  "change_id",
  "provider_membership_type",
  "provider_type",
  "recruiter_key",
  "project_key",
  "employment_type_key",
  "provider_type_key",
  "display",
  "recruiter_display",
  "project_display",
  "provider_type_display",
  "employment_type_display",
  "file_name",
  "drive_file_id",
  "source_id",
  "raw_row",
  "raw_value",
  "rows",
  "prompt",
  "candidate",
  "email",
  "phone",
];

/** Pattern value bị cấm trong packet (opaque ref là dạng duy nhất được phép). */
export const FORBIDDEN_PACKET_VALUE_PATTERNS = [
  { code: "PACKET_STABLE_UUID", re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/ },
  { code: "PACKET_STABLE_ID_PREFIX", re: /\b(?:rcr|team|alias|pm|tm|aud)_[0-9]{3}\b/ },
  { code: "PACKET_EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { code: "PACKET_PHONE_VN", re: /(?:\+84|\b0)\d{9,10}\b/ },
];

/**
 * Quét sâu packet: trả lỗi đầu tiên nếu có key/value bị cấm.
 * Engine self-check trước khi trả packet (defense in depth).
 */
export function scanForbiddenPacketContent(value, path = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scanForbiddenPacketContent(value[i], path + "[" + i + "]");
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_PACKET_KEYS.includes(key)) {
        return { code: "PACKET_FORBIDDEN_KEY", path: path + "." + key, message: "Key bị cấm trong packet: " + key };
      }
      const hit = scanForbiddenPacketContent(value[key], path + "." + key);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "string") {
    for (const { code, re } of FORBIDDEN_PACKET_VALUE_PATTERNS) {
      if (re.test(value)) return { code, path, message: "Value bị cấm trong packet (" + code + ") tại " + path };
    }
  }
  return null;
}
