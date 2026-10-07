/**
 * P2 Direct Entry reporting dimension classification hotfix - shared repair plan.
 *
 * Root cause proven read-only against Production: the 17 imported facts carry a
 * canonical stored provider_type (6 hrp / 11 vendor) and a recruiter_id, but
 *   * recruiter_provider_memberships.valid_from = 2026-10-06 is AFTER their
 *     first_work_date (2026-10-02..2026-10-05), so
 *     direct_entry_reporting_recruiter_provider_key() finds no effective row;
 *   * recruiter_aliases has no row at all for those recruiters, so
 *     direct_entry_reporting_recruiter_alias_key() finds no reporting key.
 * Both helpers therefore return the '__unknown__' sentinel and the Dashboard
 * groups the rows under "Không xác định".
 *
 * This module derives the correction from evidence that already exists in the
 * database - never from an assumption:
 *   * provider: the single membership row per recruiter must carry the same
 *     provider_type as every stored fact of that recruiter, and only its
 *     valid_from is re-dated to the earliest non-deleted entry work date;
 *   * recruiter key: HRP uses recruiters.personnel_code, Vendor uses
 *     recruiter_provider_memberships.vendor_id, written into the designed
 *     reporting vocabulary table recruiter_aliases.
 * A recruiter whose metadata is missing, ambiguous or contradictory is REFUSED,
 * so genuinely unmapped rows keep resolving to '__unknown__'.
 *
 * The module is pure except for SQL text: the CLI script and the DB regression
 * test execute the exact same statements.
 */

export const REPAIR_ACTION = "p2_de_reporting_dimension_repair";
export const REPAIR_CAPABILITY = "recruiter_master_manage";
export const REPAIR_CONFIRM_ENV = "P2_DE_DIM_REPAIR_CONFIRM";
export const REPAIR_CONFIRM_TOKEN = "P2_DE_DIM_REPAIR_APPLY";

// Business reporting codes look like `tu.vd` / `anhhn.td`: lowercase, dotted,
// no spaces. Anything else is refused instead of being copied into the
// vocabulary table.
export const REPORTING_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One row per recruiter that owns at least one fact in the reporting window.
 * Every guard input is aggregated in SQL so the decision in deriveRepairPlan()
 * is made from one consistent snapshot; callers only ever print counts.
 */
export const REPAIR_PLAN_SQL = [
  "with facts as (" +
  "  select e.entry_id, e.recruiter_id, e.provider_type, e.first_work_date" +
  "    from public.direct_entries e" +
  "    join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
  "   where s.state = 'SUBMITTED' and e.deleted_at is null" +
  "     and e.first_work_date >= public.direct_entry_reporting_cutoff())," +
  " owners as (" +
  "  select f.recruiter_id," +
  "    count(*)::int as facts," +
  "    count(distinct f.provider_type)::int as stored_providers," +
  "    min(f.provider_type) as stored_provider," +
  "    min(f.first_work_date) as fact_from," +
  "    max(f.first_work_date) as fact_to," +
  "    count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(" +
  "      f.recruiter_id, f.first_work_date) = '__unknown__')::int as facts_unknown_provider," +
  "    count(*) filter (where public.direct_entry_reporting_recruiter_alias_key(" +
  "      f.recruiter_id, f.first_work_date) = '__unknown__')::int as facts_unknown_alias" +
  "    from facts f group by f.recruiter_id)," +
  " targets as (" +
  "  select e.recruiter_id, min(e.first_work_date) as target_from" +
  "    from public.direct_entries e where e.deleted_at is null group by e.recruiter_id)" +
  " select o.recruiter_id::text as recruiter_id, o.facts, o.stored_providers," +
  "   o.stored_provider, o.fact_from::text as fact_from, o.fact_to::text as fact_to," +
  "   o.facts_unknown_provider, o.facts_unknown_alias, t.target_from::text as target_from," +
  "   (select count(*)::int from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id) as membership_rows," +
  "   (select m.membership_id::text from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_id," +
  "   (select m.provider_type from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_provider," +
  "   (select m.valid_from::text from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_from," +
  "   (select m.valid_to::text from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_to," +
  "   (select m.vendor_id from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id order by m.valid_from limit 1) as membership_vendor_id," +
  "   (select count(*)::int from public.recruiter_provider_memberships m" +
  "     where m.recruiter_id = o.recruiter_id and m.provider_type <> o.stored_provider)" +
  "     as contradicting_memberships," +
  "   (select count(*)::int from public.recruiter_aliases al" +
  "     where al.recruiter_id = o.recruiter_id) as alias_rows," +
  "   (select count(*)::int from public.recruiter_aliases al" +
  "     where al.recruiter_id = o.recruiter_id" +
  "       and (al.valid_to is null or t.target_from < al.valid_to))" +
  "     as alias_rows_touching_target," +
  "   (select nullif(btrim(r.personnel_code), '') from public.recruiters r" +
  "     where r.recruiter_id = o.recruiter_id) as personnel_code" +
  "  from owners o join targets t on t.recruiter_id = o.recruiter_id" +
  " order by o.facts desc, o.recruiter_id",
].join("\n");

/**
 * Post-repair verification over the whole reporting window: no fact may keep an
 * unresolved sentinel for a recruiter the plan claimed to repair.
 */
export const REPAIR_VERIFY_SQL = [
  "select count(*)::int as facts_total," +
  "  count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(" +
  "    e.recruiter_id, e.first_work_date) = '__unknown__')::int as provider_unknown," +
  "  count(*) filter (where public.direct_entry_reporting_recruiter_alias_key(" +
  "    e.recruiter_id, e.first_work_date) = '__unknown__')::int as recruiter_unknown" +
  "  from public.direct_entries e" +
  "  join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
  " where s.state = 'SUBMITTED' and e.deleted_at is null" +
  "   and e.first_work_date >= public.direct_entry_reporting_cutoff()",
].join("\n");

/**
 * Post-repair distribution over the whole reporting window. Grouped exactly like
 * the projection does (key, not display) so it proves the chart buckets and not
 * just a label.
 */
export const REPAIR_DISTRIBUTION_SQL = [
  "select public.direct_entry_reporting_recruiter_provider_key(" +
  "    e.recruiter_id, e.first_work_date) as provider_key," +
  "  public.direct_entry_reporting_recruiter_alias_key(" +
  "    e.recruiter_id, e.first_work_date) as recruiter_key," +
  "  count(*)::int as n" +
  "  from public.direct_entries e" +
  "  join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
  " where s.state = 'SUBMITTED' and e.deleted_at is null" +
  "   and e.first_work_date >= public.direct_entry_reporting_cutoff()" +
  " group by 1, 2 order by 1, 2",
].join("\n");

/** Fold distribution rows into the same shape as summariseRepairPlan(). */
export function foldDistribution(rows) {
  const providerSplit = {};
  const codeSplit = {};
  let facts = 0;
  for (const row of rows) {
    const n = Number(row.n);
    facts += n;
    providerSplit[row.provider_key] = (providerSplit[row.provider_key] ?? 0) + n;
    codeSplit[row.recruiter_key] = (codeSplit[row.recruiter_key] ?? 0) + n;
  }
  return { facts_total: facts, provider_split: providerSplit, reporting_code_split: codeSplit };
}

/** Stable comparison used by the in-transaction acceptance check. */
export function distributionMatches(expected, actual) {
  const same = (a, b) => {
    const left = Object.entries(a ?? {}).sort();
    const right = Object.entries(b ?? {}).sort();
    return JSON.stringify(left) === JSON.stringify(right);
  };
  return {
    ok: same(expected.provider_split, actual.provider_split) &&
      same(expected.reporting_code_split, actual.reporting_code_split),
    provider_split_ok: same(expected.provider_split, actual.provider_split),
    reporting_code_split_ok: same(expected.reporting_code_split, actual.reporting_code_split),
  };
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function refusal(row, reason) {
  return { recruiter_id: row.recruiter_id, facts: Number(row.facts), reason };
}

/**
 * Pure decision function: returns the assignments to apply plus every refusal
 * with its reason, so a caller refuses loudly instead of guessing.
 */
export function deriveRepairPlan(rows) {
  const assignments = [];
  const refusals = [];
  const skipped = [];
  for (const row of rows) {
    const unknownProvider = Number(row.facts_unknown_provider);
    const unknownAlias = Number(row.facts_unknown_alias);
    if (unknownProvider === 0 && unknownAlias === 0) {
      skipped.push({ recruiter_id: row.recruiter_id, facts: Number(row.facts), reason: "already_resolved" });
      continue;
    }
    if (Number(row.stored_providers) !== 1) {
      refusals.push(refusal(row, "facts carry more than one stored provider_type"));
      continue;
    }
    if (Number(row.membership_rows) !== 1) {
      refusals.push(refusal(row, "recruiter must have exactly one provider membership row"));
      continue;
    }
    if (Number(row.contradicting_memberships) !== 0) {
      refusals.push(refusal(row, "membership provider contradicts the stored fact provider"));
      continue;
    }
    if (row.membership_provider !== row.stored_provider) {
      refusals.push(refusal(row, "membership provider does not match the stored fact provider"));
      continue;
    }
    if (isBlank(row.target_from)) {
      refusals.push(refusal(row, "no non-deleted entry work date to anchor the correction"));
      continue;
    }
    if (!isBlank(row.membership_to) && row.membership_to <= row.target_from) {
      refusals.push(refusal(row, "membership window ended before the facts"));
      continue;
    }
    // Only a recruiter with NO alias history may receive a derived reporting key:
    // an existing (even expired) alias history is deliberate vocabulary and must
    // never be extended by guessing what the code was at another date.
    if (Number(row.alias_rows) !== 0) {
      refusals.push(refusal(row, "recruiter already has a reporting alias history"));
      continue;
    }
    let reportingKey = null;
    let keySource = null;
    if (row.stored_provider === "hrp") {
      reportingKey = isBlank(row.personnel_code) ? null : String(row.personnel_code).trim();
      keySource = "recruiters.personnel_code";
    } else if (row.stored_provider === "vendor") {
      reportingKey = isBlank(row.membership_vendor_id) ? null : String(row.membership_vendor_id).trim();
      keySource = "recruiter_provider_memberships.vendor_id";
    } else {
      refusals.push(refusal(row, "stored provider_type is not a canonical hrp/vendor value"));
      continue;
    }
    if (reportingKey === null || !REPORTING_KEY_PATTERN.test(reportingKey)) {
      refusals.push(refusal(row, "no canonical reporting code available for this recruiter"));
      continue;
    }
    assignments.push({
      recruiter_id: row.recruiter_id,
      facts: Number(row.facts),
      stored_provider: row.stored_provider,
      membership_id: row.membership_id,
      membership_from: row.membership_from,
      membership_to: row.membership_to,
      target_from: row.target_from,
      reporting_key: reportingKey,
      reporting_key_source: keySource,
      update_membership: row.membership_from > row.target_from,
      insert_alias: Number(row.alias_rows) === 0,
    });
  }
  // Two recruiters must never be collapsed onto one reporting code.
  const byKey = new Map();
  for (const assignment of assignments) {
    const list = byKey.get(assignment.reporting_key) ?? [];
    list.push(assignment);
    byKey.set(assignment.reporting_key, list);
  }
  const conflicting = new Set();
  for (const [key, list] of byKey) if (list.length > 1) conflicting.add(key);
  const accepted = [];
  for (const assignment of assignments) {
    if (conflicting.has(assignment.reporting_key)) {
      refusals.push({
        recruiter_id: assignment.recruiter_id,
        facts: assignment.facts,
        reason: "reporting code is claimed by more than one recruiter",
      });
      continue;
    }
    accepted.push(assignment);
  }
  return { assignments: accepted, refusals, skipped };
}

/** Counts-only view of a plan - safe to print (no UUID, no name, no PII). */
export function summariseRepairPlan(plan) {
  const membershipUpdates = plan.assignments.filter((a) => a.update_membership).length;
  const aliasInserts = plan.assignments.filter((a) => a.insert_alias).length;
  const byProvider = {};
  const byCode = {};
  let facts = 0;
  for (const assignment of plan.assignments) {
    facts += assignment.facts;
    byProvider[assignment.stored_provider] =
      (byProvider[assignment.stored_provider] ?? 0) + assignment.facts;
    byCode[assignment.reporting_key] = (byCode[assignment.reporting_key] ?? 0) + assignment.facts;
  }
  return {
    recruiters_to_repair: plan.assignments.length,
    facts_covered: facts,
    membership_valid_from_updates: membershipUpdates,
    alias_rows_inserted: aliasInserts,
    provider_split: byProvider,
    reporting_code_split: byCode,
    already_resolved_recruiters: plan.skipped.length,
    refused_recruiters: plan.refusals.length,
    refusal_reasons: [...new Set(plan.refusals.map((r) => r.reason))].sort(),
  };
}

/** Parameterised statements for one assignment (the caller supplies the executor). */
export function assignmentStatements(assignment) {
  const statements = [];
  if (assignment.update_membership) {
    statements.push({
      purpose: "membership_valid_from",
      sql: "update public.recruiter_provider_memberships set valid_from = $2::date" +
        " where membership_id = $1::uuid",
      params: [assignment.membership_id, assignment.target_from],
    });
  }
  if (assignment.insert_alias) {
    statements.push({
      purpose: "recruiter_alias",
      sql: "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from)" +
        " values ($1::uuid, $2::text, $3::date)",
      params: [assignment.recruiter_id, assignment.reporting_key, assignment.target_from],
    });
  }
  return statements;
}

/** Audit rows: one per repaired recruiter, values-free (no PII, no reporting code). */
export function auditStatements(assignment) {
  return [{
    purpose: "audit_event",
    sql: "insert into public.direct_entry_audit_events" +
      " (action, capability, resource_ref, outcome, changed_fields)" +
      " values ($1::text, $2::text, $3::text, 'APPLIED', $4::text[])",
    params: [
      REPAIR_ACTION,
      REPAIR_CAPABILITY,
      assignment.recruiter_id,
      [
        assignment.update_membership ? "provider_membership.valid_from" : "provider_membership.unchanged",
        assignment.insert_alias ? "recruiter_alias.reporting_key" : "recruiter_alias.unchanged",
      ],
    ],
  }];
}
