import type { AnalysisView } from "./report-contract";

export const REPORT_EXPORT_VERSION = "ai-report-export/1.0" as const;

export type ReportExportPoint = { label: string; value: number };
export type ReportExportDimensionChart = {
  key: "project" | "recruiter" | "team" | "provider" | "employment";
  title: string;
  items: ReportExportPoint[];
};
export type ReportExportMixRow = { label: string; total: number; hrp: number; vendor: number; other: number };
export type ReportExportData = {
  version: typeof REPORT_EXPORT_VERSION;
  period: { ref: string; start: string; end: string; generated_at: string };
  totals: { current: number; comparable: number | null; delta: number | null };
  trend: ReportExportPoint[];
  dimensions: ReportExportDimensionChart[];
  project_provider_mix: ReportExportMixRow[];
};

type ExportHtmlInput = {
  title: string;
  reportCode: string;
  lifecycleLabel: string;
  revisionCreatedAt: string;
  analysis: AnalysisView;
  exportData: ReportExportData;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIMENSION_KEYS = ["project", "recruiter", "team", "provider", "employment"] as const;
const DIMENSION_TITLES: Record<(typeof DIMENSION_KEYS)[number], string> = {
  project: "Tuyển dụng theo dự án",
  recruiter: "Tuyển dụng theo người tuyển",
  team: "Tuyển dụng theo nhóm",
  provider: "Cơ cấu HRP/Vendor",
  employment: "Cơ cấu loại hình lao động",
};
const CATEGORY_LABELS: Record<string, string> = {
  trend: "Xu hướng",
  driver: "Yếu tố tác động",
  strength: "Điểm mạnh",
  risk: "Rủi ro",
  concentration: "Tập trung",
  provider_mix: "Phụ thuộc Vendor",
  time_pattern: "Thời điểm",
  data_quality: "Chất lượng dữ liệu",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function parsePoints(raw: unknown, maxItems: number): ReportExportPoint[] | null {
  if (!Array.isArray(raw) || raw.length > maxItems) return null;
  const points: ReportExportPoint[] = [];
  for (const item of raw) {
    if (!isRecord(item) || !safeLabel(item.label) || !finiteNonNegative(item.value)) return null;
    points.push({ label: item.label, value: item.value });
  }
  return points;
}

/** Strict client projection: export data sai shape không được dùng để tạo file. */
export function projectReportExportData(raw: unknown): ReportExportData | null {
  if (!isRecord(raw) || raw.version !== REPORT_EXPORT_VERSION) return null;
  if (!isRecord(raw.period) || typeof raw.period.ref !== "string" || raw.period.ref.length > 120) return null;
  if (!ISO_DATE_RE.test(String(raw.period.start)) || !ISO_DATE_RE.test(String(raw.period.end))) return null;
  if (typeof raw.period.generated_at !== "string" || Number.isNaN(Date.parse(raw.period.generated_at))) return null;
  if (!isRecord(raw.totals) || !finiteNonNegative(raw.totals.current)) return null;
  if (raw.totals.comparable !== null && !finiteNonNegative(raw.totals.comparable)) return null;
  if (raw.totals.delta !== null && (typeof raw.totals.delta !== "number" || !Number.isFinite(raw.totals.delta))) return null;
  const trend = parsePoints(raw.trend, 400);
  if (!trend || !Array.isArray(raw.dimensions) || raw.dimensions.length > 5) return null;
  const dimensions: ReportExportDimensionChart[] = [];
  const seen = new Set<string>();
  for (const chart of raw.dimensions) {
    if (!isRecord(chart) || !(DIMENSION_KEYS as readonly unknown[]).includes(chart.key) || !safeLabel(chart.title)) return null;
    if (seen.has(String(chart.key))) return null;
    const items = parsePoints(chart.items, 20);
    if (!items) return null;
    seen.add(String(chart.key));
    dimensions.push({ key: chart.key as ReportExportDimensionChart["key"], title: chart.title, items });
  }
  if (!Array.isArray(raw.project_provider_mix) || raw.project_provider_mix.length > 20) return null;
  const mix: ReportExportMixRow[] = [];
  for (const row of raw.project_provider_mix) {
    if (!isRecord(row) || !safeLabel(row.label)) return null;
    const { total, hrp, vendor, other } = row;
    if (!finiteNonNegative(total) || !finiteNonNegative(hrp) || !finiteNonNegative(vendor) || !finiteNonNegative(other)) return null;
    if (total !== hrp + vendor + other) return null;
    mix.push({ label: row.label, total, hrp, vendor, other });
  }
  return {
    version: REPORT_EXPORT_VERSION,
    period: { ref: raw.period.ref, start: String(raw.period.start), end: String(raw.period.end), generated_at: raw.period.generated_at },
    totals: { current: raw.totals.current, comparable: raw.totals.comparable, delta: raw.totals.delta },
    trend,
    dimensions,
    project_provider_mix: mix,
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function barChart(title: string, items: ReportExportPoint[]): string {
  if (items.length === 0) return "";
  const max = Math.max(1, ...items.map((item) => item.value));
  return `<section class="chart"><h3>${escapeHtml(title)}</h3><div class="bars">${items
    .map(
      (item) => `<div class="bar-row"><span class="bar-label">${escapeHtml(item.label)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(1, (item.value / max) * 100).toFixed(2)}%"></span></span><strong>${escapeHtml(item.value)}</strong></div>`
    )
    .join("")}</div></section>`;
}

function trendChart(points: ReportExportPoint[]): string {
  if (points.length === 0) return "";
  const width = 760;
  const height = 230;
  const left = 42;
  const top = 18;
  const plotWidth = width - left - 18;
  const plotHeight = height - top - 42;
  const max = Math.max(1, ...points.map((point) => point.value));
  const coords = points.map((point, index) => {
    const x = left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const y = top + plotHeight - (point.value / max) * plotHeight;
    return { ...point, x, y };
  });
  const polyline = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const dots = coords.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"><title>${escapeHtml(point.label)}: ${escapeHtml(point.value)}</title></circle>`).join("");
  const first = points[0]?.label ?? "";
  const last = points.at(-1)?.label ?? "";
  return `<section class="chart wide"><h3>Xu hướng tuyển dụng</h3><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Xu hướng tuyển dụng theo thời gian"><line x1="${left}" y1="${top + plotHeight}" x2="${width - 18}" y2="${top + plotHeight}" class="axis"/><line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" class="axis"/><polyline points="${polyline}" class="trend-line"/>${dots}<text x="${left}" y="${height - 10}" class="axis-label">${escapeHtml(first)}</text><text x="${width - 18}" y="${height - 10}" text-anchor="end" class="axis-label">${escapeHtml(last)}</text><text x="${left - 8}" y="${top + 4}" text-anchor="end" class="axis-label">${escapeHtml(max)}</text></svg></section>`;
}

function mixChart(rows: ReportExportMixRow[]): string {
  if (rows.length === 0) return "";
  return `<section class="chart wide"><h3>Tỷ lệ HRP/Vendor theo dự án</h3><div class="legend"><span><i class="hrp"></i>HRP</span><span><i class="vendor"></i>Vendor</span><span><i class="other"></i>Khác</span></div><div class="mix">${rows
    .map((row) => {
      const total = Math.max(1, row.total);
      return `<div class="mix-row"><span class="bar-label">${escapeHtml(row.label)}</span><span class="mix-track"><i class="hrp" style="width:${((row.hrp / total) * 100).toFixed(2)}%"></i><i class="vendor" style="width:${((row.vendor / total) * 100).toFixed(2)}%"></i><i class="other" style="width:${((row.other / total) * 100).toFixed(2)}%"></i></span><strong>${escapeHtml(row.total)}</strong></div>`;
    })
    .join("")}</div></section>`;
}

export function buildReportExportHtml(input: ExportHtmlInput): string {
  const charts = [
    trendChart(input.exportData.trend),
    ...input.exportData.dimensions.map((chart) => barChart(chart.title || DIMENSION_TITLES[chart.key], chart.items)),
    mixChart(input.exportData.project_provider_mix),
  ].filter(Boolean).join("");
  const findings = input.analysis.findings.map((finding) => `<article class="finding"><div class="finding-head"><h3>${escapeHtml(finding.headline)}</h3><span>${escapeHtml(CATEGORY_LABELS[finding.category] ?? finding.category)} · ${escapeHtml(finding.confidence)}</span></div><p>${escapeHtml(finding.analysis)}</p>${finding.recommended_action ? `<p class="action"><strong>Đề xuất:</strong> ${escapeHtml(finding.recommended_action)}</p>` : ""}${finding.limitations.length ? `<p class="muted"><strong>Giới hạn:</strong> ${finding.limitations.map(escapeHtml).join(" · ")}</p>` : ""}<p class="evidence">Minh chứng: ${finding.evidence_refs.map(escapeHtml).join(", ")}</p></article>`).join("");
  const limitations = input.analysis.overall_limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const comparable = input.exportData.totals.comparable === null ? "Chưa khả dụng" : String(input.exportData.totals.comparable);
  const delta = input.exportData.totals.delta === null ? "Chưa khả dụng" : String(input.exportData.totals.delta);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>
  :root{color-scheme:light;--ink:#172033;--muted:#64748b;--line:#dbe3ee;--surface:#fff;--primary:#078461;--secondary:#0ea5e9;--accent:#f59e0b}*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:var(--ink);font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.page{max-width:1100px;margin:24px auto;padding:0 20px 40px}.hero,.card,.chart,.finding{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 24px rgba(15,23,42,.05)}.hero{padding:26px;background:linear-gradient(120deg,#e8fff7,#fff 55%,#eaf8ff)}.eyebrow{color:var(--primary);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{font-size:28px;line-height:1.2;margin:5px 0 8px}h2{font-size:20px;margin:0 0 14px}h3{font-size:15px;margin:0}.meta{display:flex;flex-wrap:wrap;gap:8px 20px;color:var(--muted)}.toolbar{display:flex;justify-content:flex-end;margin:12px 0}.print{border:0;border-radius:9px;background:var(--primary);color:white;padding:10px 16px;font-weight:700;cursor:pointer}.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}.kpi{padding:15px}.kpi strong{display:block;font-size:24px}.kpi span{color:var(--muted)}.card{padding:20px;margin:16px 0}.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.chart{padding:18px;break-inside:avoid}.chart.wide{grid-column:1/-1}.chart svg{display:block;width:100%;height:auto}.axis{stroke:#cbd5e1;stroke-width:1}.trend-line{fill:none;stroke:var(--primary);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}.chart circle{fill:var(--primary)}.axis-label{fill:var(--muted);font-size:11px}.bars,.mix{display:grid;gap:9px;margin-top:14px}.bar-row,.mix-row{display:grid;grid-template-columns:minmax(90px,1.2fr) minmax(120px,3fr) 42px;gap:10px;align-items:center}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-track,.mix-track{display:flex;height:13px;border-radius:999px;background:#e8eef5;overflow:hidden}.bar-fill{display:block;border-radius:999px;background:linear-gradient(90deg,var(--primary),var(--secondary))}.mix-track i,.legend i{display:block}.hrp{background:#078461}.vendor{background:#f59e0b}.other{background:#94a3b8}.legend{display:flex;gap:16px;margin-top:10px;color:var(--muted)}.legend span{display:flex;align-items:center;gap:6px}.legend i{width:10px;height:10px;border-radius:3px}.finding{padding:16px;margin:10px 0;break-inside:avoid}.finding-head{display:flex;justify-content:space-between;gap:12px}.finding-head span,.muted,.evidence{color:var(--muted);font-size:12px}.action{border-left:3px solid var(--primary);padding-left:10px}.limitations{margin:0;padding-left:20px}.footer{margin-top:20px;color:var(--muted);font-size:12px}.badge{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:3px 9px;background:#fff}.executive{font-size:16px;white-space:pre-wrap}@media(max-width:700px){.page{padding:0 12px}.kpis,.charts{grid-template-columns:1fr}.chart.wide{grid-column:auto}.bar-row,.mix-row{grid-template-columns:90px 1fr 36px}h1{font-size:22px}}@media print{body{background:#fff}.page{max-width:none;margin:0;padding:0}.toolbar{display:none}.hero,.card,.chart,.finding{box-shadow:none}.charts{display:block}.chart{margin:12px 0;page-break-inside:avoid}}
  </style></head><body><main class="page"><header class="hero"><div class="eyebrow">HR Partner · Báo cáo điều hành</div><h1>${escapeHtml(input.title)}</h1><div class="meta"><span class="badge">${escapeHtml(input.lifecycleLabel)}</span><span>Kỳ: ${escapeHtml(input.exportData.period.start)} → ${escapeHtml(input.exportData.period.end)}</span><span>Tạo lúc: ${escapeHtml(formatDateTime(input.revisionCreatedAt))}</span><span>Mã: ${escapeHtml(input.reportCode)}</span></div></header><div class="toolbar"><button class="print" onclick="window.print()">In / Lưu PDF</button></div><section class="kpis"><div class="card kpi"><span>Kỳ hiện tại</span><strong>${escapeHtml(input.exportData.totals.current)}</strong></div><div class="card kpi"><span>Kỳ so sánh</span><strong>${escapeHtml(comparable)}</strong></div><div class="card kpi"><span>Chênh lệch</span><strong>${escapeHtml(delta)}</strong></div></section><section class="card"><h2>Tóm tắt điều hành</h2><p class="executive">${escapeHtml(input.analysis.executive_analysis)}</p><p class="muted">Kỳ báo cáo: ${escapeHtml(input.analysis.period_ref)}</p></section>${charts ? `<section><h2>Biểu đồ dữ liệu tương ứng</h2><div class="charts">${charts}</div></section>` : ""}<section class="card"><h2>Nhận định và đề xuất</h2>${findings || "<p>Không có nhận định chi tiết.</p>"}</section>${limitations ? `<section class="card"><h2>Cảnh báo dữ liệu</h2><ul class="limitations">${limitations}</ul></section>` : ""}<footer class="footer">Biểu đồ được dựng từ snapshot dữ liệu đã đóng băng cùng báo cáo. Nhãn dự án/người tuyển/nhóm được ẩn danh trong bản xuất. File HTML tự chứa, có thể mở ngoại tuyến hoặc in thành PDF.</footer></main></body></html>`;
}

export function reportExportFileName(title: string, createdAt: string): string {
  const base = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "bao-cao-ai";
  const date = /^\d{4}-\d{2}-\d{2}/.exec(createdAt)?.[0] ?? "export";
  return `${base}-${date}.html`;
}
