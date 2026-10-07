import "server-only";

import type { DirectEntryActor } from "@/lib/auth/direct-entry-v2";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

import { parseReportingFilters } from "./p1-filter";
import { computeReporting, reportingQueryFailed } from "./p1-reporting";
import type {
  ReportingData,
  ReportingFact,
  ReportingSource,
  RunStatus,
} from "./p1-reporting";
import { resolveReportingAudienceProjection } from "./p3-w05a-audience";
import type { ReportingAudience } from "./p3-w05a-audience";
import { validateAllSourceFilter } from "./p3-w05a-source-filter";
import {
  combineReportingFacts,
  cutoverBlockerError,
  hasCutoverBlocker,
  maskDirectEntryFacts,
  maskLegacyFacts,
  P2_W04A_CUTOVER_BLOCKER_CODE,
  P2_W04A_CUTOVER_DATE,
  P2_W04A_CUTOVER_FAILED_CODE,
  P2_W04A_DIRECT_ENTRY_SOURCE,
  P2_W04A_DIRECT_ENTRY_SOURCE_ID,
} from "./p2-w04a-cutover";
import type {
  CutoverReconciliation,
  DirectEntryReportingFact,
} from "./p2-w04a-cutover";

/**
 * P3-W05A-R1 - DB-authoritative scoped cutover read path.
 *
 * Reads authorized facts AND source metadata through one actor-scoped RPC at
 * the DB boundary. The DB-resolved audience (all > team > own, HCM date) is the
 * single authority for both facts and metadata: no TypeScript/UTC audience
 * inference, no pre-RPC global metadata read (no TOCTOU leak).
 */

type ScopedFactRow = ReportingFact & {
  first_work_date?: string | null;
  entry_id?: string | null;
  submission_id?: string | null;
  cutoff_date?: string | null;
};

type ScopedSourceRow = {
  id: string;
  drive_file_id: string;
  file_name: string;
  active: boolean;
  is_test: boolean;
  last_seen_at: string | null;
  last_successful_sync_at: string | null;
};

export type CutoverFetchResult =
  | { ok: true; data: ReportingData; generatedAt: string; audience: ReportingAudience | null }
  | {
      ok: false;
      code: string;
      message: string;
      reconciliation?: CutoverReconciliation;
    };

function logSafeError(prefix: string, error: unknown) {
  const safeCode =
    error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "unknown";
  console.error("[" + prefix + "] query failed. code=" + safeCode);
}

/**
 * Read the runtime blocker helper ONCE per request (global cutover invariant).
 */
async function fetchCutoverBlockerCount(params: {
  sb: ReturnType<typeof createServiceSupabaseClient>;
}): Promise<
  { count: number } | { error: { code: string; message: string } }
> {
  const res = await params.sb.rpc(
    "direct_entry_reporting_pre_cutover_blocker_count",
  );
  if (res.error) {
    return { error: { code: res.error.code, message: res.error.message } };
  }
  const count = Number((res.data ?? 0) as unknown);
  if (!Number.isFinite(count) || count < 0) {
    return { error: { code: P2_W04A_CUTOVER_FAILED_CODE, message: "blocker count not a non-negative number" } };
  }
  return { count };
}

/**
 * Main read-path entrypoint. `actor` is a mandatory input (the page resolves
 * it once via resolveActorForRequest and passes it server-side).
 */
export async function fetchCutoverReporting(
  params: Record<string, string | string[] | undefined>,
  actor: DirectEntryActor,
): Promise<CutoverFetchResult> {
  try {
    const sb = createServiceSupabaseClient();

    // 1. Runtime blocker check (one RPC call per request; global invariant).
    const blocker = await fetchCutoverBlockerCount({ sb });
    if ("error" in blocker) {
      return { ok: false, code: blocker.error.code, message: blocker.error.message };
    }

    // 2. Parse filters. Source is validated as a UUID but not against scope
    //    here: the scoped RPC is the authority and applies it only to the
    //    legacy side for a DB-confirmed "all" audience.
    const parsed = parseReportingFilters(params, undefined);
    if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
    const filters = parsed.filters;

    // 3. Actor-scoped facts AND source metadata, both gated by the SAME
    //    DB-resolved audience (no TS/UTC audience inference, no pre-RPC
    //    global metadata read => no TOCTOU leak).
    const factsRes = await sb.rpc("direct_entry_reporting_scoped_facts", {
      p_auth_subject: actor.auth_subject,
      p_app_user_id: actor.app_user_id,
      p_filters: filters,
    });
    if (factsRes.error) {
      logSafeError("p3-w05a-facts", factsRes.error);
      return reportingQueryFailed();
    }
    const payload = (factsRes.data ?? {}) as {
      audience?: unknown;
      facts?: unknown[];
      sources?: ScopedSourceRow[];
      latest_runs?: { source_id: string; status: RunStatus }[];
      presence?: string[];
    };
    const scopedFacts = (payload.facts ?? []) as ScopedFactRow[];

    // Fail closed and keep the scope label inclusive. A successful response
    // without a usable audience must not become facts under a guessed scope, and
    // a team audience resolved from several effective grants must never read as
    // one named team (the DB only labels the first one).
    const audience = resolveReportingAudienceProjection(payload.audience);
    if (audience === null) {
      logSafeError("p3-w05a-audience", "audience payload missing or malformed");
      return reportingQueryFailed();
    }
    const dbKind = audience.kind;
    const dbSources = (payload.sources ?? []) as ScopedSourceRow[];

    // Validate the legacy-only source filter against the DB-authoritative
    // allowlist (active/non-test sources). Only a DB-confirmed "all" audience
    // may filter by source; an unknown / test / inactive source is rejected as
    // INVALID_FILTER (never a silently-empty report). own/team ignore the
    // source filter (R2).
    if (dbKind === "all") {
      const sourceCheck = validateAllSourceFilter({
        source: filters.source,
        allowlist: dbSources.map((s) => s.id),
      });
      if (!sourceCheck.ok) {
        return { ok: false, code: sourceCheck.code, message: sourceCheck.message };
      }
    } else {
      filters.source = undefined;
    }

    // The DB-confirmed audience is the sole authority for metadata scope.
    const rawSources: Omit<ReportingSource, "latest_run_status">[] =
      dbKind === "all" ? dbSources : [];
    const latestBySource = new Map<string, RunStatus>();
    for (const r of payload.latest_runs ?? []) latestBySource.set(r.source_id, r.status);
    const sourcesWithFacts = new Set<string>(payload.presence ?? []);

    // 4. Split + defense-in-depth mask + combine.
    const legacyFactsRaw: ReportingFact[] = [];
    const directEntryFactsRaw: DirectEntryReportingFact[] = [];
    for (const f of scopedFacts) {
      if (f.source_id === P2_W04A_DIRECT_ENTRY_SOURCE_ID) {
        directEntryFactsRaw.push(f as unknown as DirectEntryReportingFact);
      } else {
        legacyFactsRaw.push(f as ReportingFact);
      }
    }
    const maskedDirectEntry = maskDirectEntryFacts(directEntryFactsRaw);
    const legacyFacts = maskLegacyFacts(legacyFactsRaw);

    // 6. Sources for computeReporting: DB-provided legacy sources (all only)
    //    + the Direct Entry synthetic source.
    const sources: ReportingSource[] = rawSources.map((s) => ({
      ...s,
      latest_run_status: latestBySource.get(s.id) ?? null,
    }));
    sources.push(P2_W04A_DIRECT_ENTRY_SOURCE);
    if (maskedDirectEntry.length > 0) sourcesWithFacts.add(P2_W04A_DIRECT_ENTRY_SOURCE_ID);

    // 7. Reconciliation (overlap_blocker is the authoritative global count).
    const legacy_subtotal = legacyFacts.reduce((a, f) => a + f.recruited_count, 0);
    const direct_entry_subtotal = maskedDirectEntry.length;
    const reconciliation: CutoverReconciliation = {
      legacy_subtotal,
      direct_entry_subtotal,
      overlap_blocker: blocker.count,
      combined_total: legacy_subtotal + direct_entry_subtotal,
      cutoff_date: P2_W04A_CUTOVER_DATE,
    };

    if (hasCutoverBlocker(reconciliation)) {
      const err = cutoverBlockerError(reconciliation);
      console.error(
        "[p3-w05a] cutover blocker: overlap=" + err.reconciliation.overlap_blocker +
          " cutoff=" + err.reconciliation.cutoff_date +
          " legacy=" + err.reconciliation.legacy_subtotal + " de=" + err.reconciliation.direct_entry_subtotal,
      );
      return { ok: false, code: err.code, message: err.message, reconciliation };
    }

    // 8. Concatenate WITHOUT grain-dedupe, then compute.
    const combinedFacts = combineReportingFacts(legacyFacts, maskedDirectEntry);
    const data = computeReporting(sources, combinedFacts, filters, sourcesWithFacts);

    return { ok: true, data, generatedAt: new Date().toISOString(), audience };
  } catch (error) {
    logSafeError("p3-w05a-scoped-reporting", error);
    return reportingQueryFailed();
  }
}

/**
 * Offline read-only reconciliation helper (unchanged from W04A/W04B).
 */
export const P2_W04A_RECONCILIATION_SQL = `
  select
    legacy_subtotal,
    direct_entry_subtotal,
    overlap_blocker,
    cutoff_date::text as cutoff_date
  from public.direct_entry_reporting_reconciliation_totals()
`;

export { P2_W04A_CUTOVER_BLOCKER_CODE, P2_W04A_CUTOVER_FAILED_CODE };
export type { ReportingData };
