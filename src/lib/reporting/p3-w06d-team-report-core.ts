import type { ReportingFact } from "./p1-reporting.ts";
import { P2_W04A_DIRECT_ENTRY_SOURCE_ID } from "./p2-w04a-cutover.ts";
import { decodeTeamBucketKey } from "./p2-w05b-team-drill-down-parser.ts";

/**
 * P3-W06D-R2 - pure core of the team-scoped report read.
 *
 * No IO: the server module feeds it the DB-resolved audience and the actor's
 * already-authorized fact set, and it decides whether the requested bucket is
 * allowed, which facts belong to it, and the sanitized detail page. Kept pure
 * so the scope/denial rules and the pagination are unit-testable without a DB.
 */

export type TeamFactRow = ReportingFact & {
  first_work_date?: string | null;
  entry_id?: string | null;
  submission_id?: string | null;
  cutoff_date?: string | null;
};

export type AudienceKind = "all" | "team" | "own";

export type DecodedBucket = { kind: "unknown" } | { kind: "team"; code: string };

export type BucketAuthorization = "ok" | "denied" | "invalid";

export type TeamReportRow = {
  business_date: string;
  project_display: string;
  recruiter_display: string;
  provider_type_display: string;
  employment_type_display: string;
  recruited_count: number;
  first_work_date: string;
};

export type TeamReportDetail = {
  rows: TeamReportRow[];
  nextCursor: string | null;
  total: number;
  legacy_aggregate_total: {
    recruited_count: number;
    from: string | null;
    to: string | null;
    cutover_date: string;
  } | null;
};

type CursorFields = { recruiter_display: string; business_date: string; entry_id: string };

/** Decode a canonical bucket key (validated at the wire by the shared parser). */
export function decodeBucket(value: string): DecodedBucket | null {
  return decodeTeamBucketKey(value);
}

/** Facts that belong to the requested bucket, inside the authorized set. */
export function selectBucketFacts(facts: readonly TeamFactRow[], decoded: DecodedBucket): TeamFactRow[] {
  return decoded.kind === "unknown"
    ? facts.filter((f) => f.team_code === null || f.team_code === undefined)
    : facts.filter((f) => f.team_code === decoded.code);
}

/**
 * Server-side authority for a requested bucket, derived ONLY from the
 * DB-resolved audience kind and whether the bucket has any fact inside the
 * actor's authorized fact set.
 *
 *   - `own`            -> denied (no team report);
 *   - `unknown` bucket -> allowed for `all` only;
 *   - team bucket      -> `all` may read any team that has facts; a `team`
 *                         audience may read only a team present in its
 *                         authorized facts (i.e. inside its granted scope);
 *                         `all` with no matching fact is an invalid bucket.
 */
export function authorizeBucket(
  dbKind: AudienceKind | null,
  decoded: DecodedBucket,
  hasBucketFacts: boolean,
): BucketAuthorization {
  if (dbKind === null || dbKind === "own") return "denied";
  if (decoded.kind === "unknown") return dbKind === "all" ? "ok" : "denied";
  if (!hasBucketFacts) return dbKind === "team" ? "denied" : "invalid";
  return "ok";
}

export function decodeCursor(cursor: string): CursorFields | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.recruiter_display !== "string" || record.recruiter_display === "") return null;
    if (typeof record.business_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.business_date)) return null;
    if (typeof record.entry_id !== "string" || record.entry_id === "") return null;
    return {
      recruiter_display: record.recruiter_display,
      business_date: record.business_date,
      entry_id: record.entry_id,
    };
  } catch {
    return null;
  }
}

function encodeCursor(fields: CursorFields): string {
  return Buffer.from(
    JSON.stringify({
      recruiter_display: fields.recruiter_display,
      business_date: fields.business_date,
      entry_id: fields.entry_id,
    }),
    "utf8",
  ).toString("base64url");
}

type RowWithId = TeamReportRow & { entry_id: string };

/** Sort + cursor ordering shared with the drill-down: recruiter asc, date desc, entry asc. */
function compareRows(a: RowWithId, b: RowWithId): number {
  if (a.recruiter_display !== b.recruiter_display) return a.recruiter_display < b.recruiter_display ? -1 : 1;
  if (a.business_date !== b.business_date) return a.business_date > b.business_date ? -1 : 1;
  return a.entry_id < b.entry_id ? -1 : a.entry_id > b.entry_id ? 1 : 0;
}

function isAfterCursor(row: RowWithId, cursor: CursorFields): boolean {
  if (row.recruiter_display !== cursor.recruiter_display) return row.recruiter_display > cursor.recruiter_display;
  if (row.business_date !== cursor.business_date) return row.business_date < cursor.business_date;
  return row.entry_id > cursor.entry_id;
}

function toDetailRow(fact: TeamFactRow): RowWithId {
  return {
    business_date: fact.business_date,
    project_display: fact.project_display,
    recruiter_display: fact.recruiter_display,
    provider_type_display: fact.provider_type_display,
    employment_type_display: fact.employment_type_display,
    recruited_count: fact.recruited_count,
    first_work_date: fact.first_work_date ?? "",
    entry_id: fact.entry_id ?? "",
  };
}

function toPublicRow(row: RowWithId): TeamReportRow {
  return {
    business_date: row.business_date,
    project_display: row.project_display,
    recruiter_display: row.recruiter_display,
    provider_type_display: row.provider_type_display,
    employment_type_display: row.employment_type_display,
    recruited_count: row.recruited_count,
    first_work_date: row.first_work_date,
  };
}

/**
 * Build the sanitized detail for a bucket from Direct Entry rows only. A cursor
 * beyond the last row yields an empty page with `nextCursor = null`, never an error.
 */
export function buildTeamDetail(input: {
  facts: readonly TeamFactRow[];
  cursor: string | null;
  limit: number;
}): TeamReportDetail {
  const deFacts = input.facts.filter((f) => f.source_id === P2_W04A_DIRECT_ENTRY_SOURCE_ID);
  const sorted = deFacts.map(toDetailRow).sort(compareRows);
  const cursorFields = input.cursor === null ? null : decodeCursor(input.cursor);
  const after = cursorFields === null ? sorted : sorted.filter((row) => isAfterCursor(row, cursorFields));
  const page = after.slice(0, input.limit);
  const hasMore = after.length > page.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ recruiter_display: last.recruiter_display, business_date: last.business_date, entry_id: last.entry_id })
    : null;

  return {
    rows: page.map(toPublicRow),
    nextCursor,
    total: sorted.length,
    legacy_aggregate_total: null,
  };
}
