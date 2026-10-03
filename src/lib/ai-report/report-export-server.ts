import "server-only";

import { validateAnalysisPacket, type AnalysisPacket } from "@/lib/analytics/contracts/analysis-packet";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import {
  REPORT_EXPORT_VERSION,
  type ReportExportData,
  type ReportExportDimensionChart,
  type ReportExportPoint,
} from "./report-export";

const TITLES: Record<ReportExportDimensionChart["key"], string> = {
  project: "Tuyển dụng theo dự án",
  recruiter: "Tuyển dụng theo người tuyển",
  team: "Tuyển dụng theo nhóm",
  provider: "Cơ cấu HRP/Vendor",
  employment: "Cơ cấu loại hình lao động",
};

const PREFIXES: Record<ReportExportDimensionChart["key"], string> = {
  project: "Dự án",
  recruiter: "Người tuyển",
  team: "Nhóm",
  provider: "Nguồn",
  employment: "Loại hình",
};

const CATALOG_LABELS: Record<string, string> = {
  hrp: "HRP",
  vendor: "Vendor",
  "thời vụ": "Thời vụ",
  "chính thức": "Chính thức",
  __unknown__: "Không xác định",
  __invalid__: "Không hợp lệ",
};

function dimensionPoints(packet: AnalysisPacket, key: ReportExportDimensionChart["key"]): { points: ReportExportPoint[]; labels: Map<string, string> } {
  const catalog = new Map(packet.subjects.map((subject) => [subject.ref, subject.catalog_key]));
  const sorted = [...packet.drivers[key]].sort((a, b) => b.current - a.current || a.subject_ref.localeCompare(b.subject_ref)).slice(0, 10);
  const labels = new Map<string, string>();
  const points = sorted.map((entry, index) => {
    const catalogKey = catalog.get(entry.subject_ref);
    const label = catalogKey ? (CATALOG_LABELS[catalogKey] ?? PREFIXES[key] + " " + (index + 1)) : PREFIXES[key] + " " + (index + 1);
    labels.set(entry.subject_ref, label);
    return { label, value: entry.current };
  });
  return { points, labels };
}

export function projectReportExportFromPacket(raw: unknown): ReportExportData | null {
  const validated = validateAnalysisPacket(raw);
  if (!validated.ok) return null;
  const packet = validated.value;
  const dimensions: ReportExportDimensionChart[] = [];
  const labelMaps = new Map<string, Map<string, string>>();
  for (const key of packet.scope.dimensions) {
    const { points, labels } = dimensionPoints(packet, key);
    labelMaps.set(key, labels);
    if (points.length > 0) dimensions.push({ key, title: TITLES[key], items: points });
  }
  const projectLabels = labelMaps.get("project") ?? dimensionPoints(packet, "project").labels;
  const rankedMix = [...packet.project_provider_mix]
    .sort((a, b) => b.project_total - a.project_total || a.subject_ref.localeCompare(b.subject_ref))
    .slice(0, 10);
  let fallbackProjectIndex = projectLabels.size;
  const mix = rankedMix.map((row) => {
    let label = projectLabels.get(row.subject_ref);
    if (!label) {
      fallbackProjectIndex += 1;
      label = "Dự án " + fallbackProjectIndex;
      projectLabels.set(row.subject_ref, label);
    }
    return {
      label,
      total: row.project_total,
      hrp: row.hrp_count,
      vendor: row.vendor_count,
      other: row.unknown_count + row.invalid_count,
    };
  });
  return {
    version: REPORT_EXPORT_VERSION,
    period: { ref: packet.period.period_ref, start: packet.period.start, end: packet.period.end, generated_at: packet.generated_at },
    totals: { current: packet.totals.current, comparable: packet.totals.comparable, delta: packet.totals.delta },
    trend: packet.series.points.map((point) => ({ label: point.period_start, value: point.value })),
    dimensions,
    project_provider_mix: mix,
  };
}

/** Server-only read; chỉ trả projection aggregate, không trả packet/ref/source/PII ra client. */
export async function loadReportExportData(jobId: string, actorRef: string): Promise<ReportExportData | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || actorRef.trim() === "") return null;
  const client = createServiceSupabaseClient();
  const { data, error } = await client
    .from("ai_report_jobs")
    .select("packet")
    .eq("job_id", jobId)
    .eq("actor_ref", actorRef)
    .maybeSingle();
  if (error || !data) return null;
  return projectReportExportFromPacket((data as { packet?: unknown }).packet);
}
