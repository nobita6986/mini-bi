import "server-only";

/**
 * HF Duplicate CCCD Self-Service Actions -
 * POST /api/direct-entry/duplicate-cccd-report/self-withdraw
 *
 * Tu rut trung ho so tren bao cao CCCD trung cho dung nguoi da tao ho so
 * (`direct_entries.created_by_user_id = actor`) khi ho so con nam trong nhom CCCD trung ON
 * dang hoat dong: OCC, idempotency, revision va audit bat bien, giu nguyen lich su kiem toan.
 * Gate DIRECT_ENTRY_API_ENABLED chay TRUOC khi parse body, tao session hay repository.
 */
import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import { duplicateCccdSelfWithdraw } from "@/lib/direct-entry/duplicate-cccd-self-withdraw-api";
import { createDuplicateCccdSelfWithdrawRepository } from "@/lib/direct-entry/duplicate-cccd-self-withdraw-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") {
    return Response.json({ ok: false, code: "NOT_FOUND" }, {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return duplicateCccdSelfWithdraw(request, "true", {
    resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
    repository: createDuplicateCccdSelfWithdrawRepository(),
  });
}
