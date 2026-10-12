import "server-only";

/**
 * P3.1-HF-R3 - GET /api/direct-entry/duplicate-cccd-report
 *
 * Bao cao doc-only cac ho so co CCCD trung, phan trang theo page/page_size, audience do RPC
 * #74 quyet dinh (Full Admin triple | catalog_master_manage | entry_privileged_edit, kem
 * effective all scope). CCCD duoc che (chi 4 chu so cuoi). Gate DIRECT_ENTRY_API_ENABLED chay
 * TRUOC khi parse query, tao session hay repository; route khong danh gia quyen.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { duplicateCccdReport } from "@/lib/direct-entry/duplicate-cccd-report-api";
import { createDuplicateCccdReportRepository } from "@/lib/direct-entry/duplicate-cccd-report-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return duplicateCccdReport(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createDuplicateCccdReportRepository(),
  });
}
