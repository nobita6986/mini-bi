#!/usr/bin/env node
/**
 * P2 Direct Entry reporting dimension classification hotfix - READ-ONLY evidence.
 *
 * Answers, from Production, why the Dashboard groups imported Direct Entry rows
 * under the "Không xác định" (__unknown__) provider / recruiter buckets:
 *   * direct_entry_reporting_recruiter_provider_key(recruiter_id, first_work_date)
 *     reads recruiter_provider_memberships effective AT the work date;
 *   * direct_entry_reporting_recruiter_alias_key(recruiter_id, first_work_date)
 *     reads recruiter_aliases effective AT the work date.
 * When the membership/alias timeline does not cover the historical work date the
 * key collapses to __unknown__ even though the entry itself stores a canonical
 * provider_type.
 *
 * SAFETY: opens `begin read only`, always rolls back, and prints COUNTS / BOOLEANS
 * / calendar dates / recruiter reporting codes only. It never selects or prints an
 * email, UUID, national id, worker name, address, phone or secret.
 *
 * Usage: node scripts/p2-de-reporting-dimension-hotfix-check.mjs
 */
import process from "node:process";

import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

async function scalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  return res.rows[0];
}

// Effective-window predicate reused by every coverage question so the report and
// the projection cannot drift apart: half-open [valid_from, valid_to).
const EFFECTIVE = "g.valid_from <= e.first_work_date" +
  " and (g.valid_to is null or e.first_work_date < g.valid_to)";

async function reportingWindow(client) {
  const base =
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()";
  const provider = await scalar(client,
    "select count(*)::int as total," +
    " count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) = 'hrp')::int as hrp," +
    " count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) = 'vendor')::int as vendor," +
    " count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) = '__unknown__')::int as unknown" + base);
  const recruiter = await scalar(client,
    "select count(*) filter (where public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date) = '__unknown__')::int as unknown," +
    " count(*) filter (where public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date) <> '__unknown__')::int as resolved" + base);
  const stored = await scalar(client,
    "select count(*) filter (where e.provider_type = 'hrp')::int as stored_hrp," +
    " count(*) filter (where e.provider_type = 'vendor')::int as stored_vendor," +
    " count(*) filter (where e.provider_type not in ('hrp','vendor'))::int as stored_other," +
    " count(*) filter (where e.provider_type in ('hrp','vendor')" +
    "   and public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) = '__unknown__')::int as stored_canonical_but_unknown" + base);
  return {
    facts_total: provider.total,
    provider_key: { hrp: provider.hrp, vendor: provider.vendor, unknown: provider.unknown },
    recruiter_key: { resolved: recruiter.resolved, unknown: recruiter.unknown },
    stored_provider_type: { hrp: stored.stored_hrp, vendor: stored.stored_vendor, other: stored.stored_other },
    stored_canonical_but_unknown: stored.stored_canonical_but_unknown,
  };
}

async function mappingCoverage(client) {
  const base =
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()";
  const memberships = await scalar(client,
    "select count(distinct e.recruiter_id)::int as recruiters," +
    " count(distinct e.recruiter_id) filter (where exists (select 1 from public.recruiter_provider_memberships m where m.recruiter_id = e.recruiter_id))::int as any_provider_membership," +
    " count(distinct e.recruiter_id) filter (where exists (select 1 from public.recruiter_provider_memberships g where g.recruiter_id = e.recruiter_id and " + EFFECTIVE + "))::int as effective_provider_membership," +
    " count(distinct e.recruiter_id) filter (where exists (select 1 from public.recruiter_aliases a where a.recruiter_id = e.recruiter_id))::int as any_alias," +
    " count(distinct e.recruiter_id) filter (where exists (select 1 from public.recruiter_aliases g where g.recruiter_id = e.recruiter_id and " + EFFECTIVE + "))::int as effective_alias" + base);
  const starts = await scalar(client,
    "select count(*)::int as memberships_total," +
    " count(*) filter (where m.valid_from > e.first_work_date)::int as starts_after_work_date," +
    " count(*) filter (where m.valid_to is not null and m.valid_to <= e.first_work_date)::int as ended_before_work_date" +
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " join public.recruiter_provider_memberships m on m.recruiter_id = e.recruiter_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()");
  const aliases = await scalar(client,
    "select count(*)::int as aliases_total," +
    " count(*) filter (where a.valid_from > e.first_work_date)::int as starts_after_work_date" +
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " join public.recruiter_aliases a on a.recruiter_id = e.recruiter_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()");
  return { recruiters_in_window: memberships.recruiters, memberships, membership_rows: starts, alias_rows: aliases };
}

async function keyDistribution(client) {
  const base =
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()";
  const providers = await client.query(
    "select public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) as key, count(*)::int as n" + base +
    " group by 1 order by 1");
  const aliases = await client.query(
    "select public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date) as key, count(*)::int as n" + base +
    " group by 1 order by 2 desc, 1");
  return {
    provider_key_counts: Object.fromEntries(providers.rows.map((r) => [r.key, r.n])),
    recruiter_key_counts: Object.fromEntries(aliases.rows.map((r) => [r.key, r.n])),
  };
}

const EXPECTED_CODES = ["tu.vd", "thinhvuong.vd", "anhhn.td", "dhr.vd", "hainq.td", "nhieunt.td", "hao.vd"];
const CODE_LIST = EXPECTED_CODES.map((code) => "'" + code + "'").join(",");

// Which column can legitimately carry the recruiter reporting key? recruiters has
// only display_name, so the check asks whether display_name is code-shaped and
// matches the seven source codes. Only COUNTS are returned - never a name value.
async function classificationEvidence(client) {
  const base =
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " join public.recruiters r on r.recruiter_id = e.recruiter_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()";
  const codes = await scalar(client,
    "select count(distinct r.display_name)::int as distinct_display_names," +
    " count(distinct r.recruiter_id)::int as distinct_recruiters," +
    " count(*) filter (where r.display_name ~ '^[a-z0-9][a-z0-9._-]*$')::int as code_shaped_rows," +
    " count(*) filter (where r.display_name in (" + CODE_LIST + "))::int as expected_code_rows," +
    " count(distinct r.recruiter_id) filter (where r.display_name in (" + CODE_LIST + "))::int as expected_code_recruiters," +
    " min(e.first_work_date)::text as first_work_date_min," +
    " max(e.first_work_date)::text as first_work_date_max" + base);
  const perCode = await client.query(
    "select r.display_name as key, count(*)::int as n" + base +
    " and r.display_name in (" + CODE_LIST + ") group by 1 order by 2 desc, 1");
  const provider = await scalar(client,
    "select count(*)::int as membership_rows," +
    " count(distinct m.recruiter_id)::int as recruiters_with_rows," +
    " count(*) filter (where m.provider_type = e.provider_type)::int as rows_matching_stored_provider," +
    " count(*) filter (where m.provider_type <> e.provider_type)::int as rows_conflicting_with_stored_provider," +
    " min(m.valid_from)::text as membership_valid_from_min," +
    " max(m.valid_from)::text as membership_valid_from_max," +
    " min(m.valid_to)::text as membership_valid_to_min" +
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " join public.recruiter_provider_memberships m on m.recruiter_id = e.recruiter_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()");
  const links = await scalar(client,
    "select count(distinct l.recruiter_id)::int as recruiters_with_verified_link," +
    " count(distinct l.app_user_id)::int as linked_app_users" +
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " join public.direct_entry_app_user_recruiter_links l on l.recruiter_id = e.recruiter_id and l.verified" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()");
  return {
    codes: { ...codes, per_code_counts: Object.fromEntries(perCode.rows.map((r) => [r.key, r.n])) },
    provider_memberships: provider,
    verified_links: links,
  };
}
// Legacy aggregate vocabulary: daily_recruitment_breakdown carries recruiter_key
// (the reporting code) next to recruiter_display. Where that pair maps a canonical
// recruiter 1:1 onto exactly one code it is safe EVIDENCE for a missing alias row;
// an ambiguous display name must fail closed instead of being guessed.
async function legacyAliasEvidence(client) {
  const base =
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " join public.recruiters r on r.recruiter_id = e.recruiter_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()";
  const legacy = await scalar(client,
    "select count(*)::int as legacy_rows," +
    " count(distinct b.recruiter_key)::int as legacy_keys," +
    " count(distinct b.recruiter_key) filter (where b.recruiter_key in (" + CODE_LIST + "))::int as expected_keys_present" +
    " from public.daily_recruitment_breakdown b");
  const mapping = await scalar(client,
    "with candidate as (select distinct b.recruiter_display, b.recruiter_key" +
    " from public.daily_recruitment_breakdown b where b.recruiter_key in (" + CODE_LIST + "))," +
    " resolved as (select r.recruiter_id, min(c.recruiter_key) as reporting_key," +
    " count(distinct c.recruiter_key) as candidate_keys" +
    " from public.recruiters r join candidate c on c.recruiter_display = r.display_name" +
    " group by r.recruiter_id)" +
    " select (select count(*)::int from resolved) as resolvable_recruiters," +
    " (select count(*)::int from resolved where candidate_keys = 1) as unambiguous_recruiters," +
    " (select count(*)::int from resolved where candidate_keys > 1) as ambiguous_recruiters," +
    " (select count(*)::int from public.recruiters r join resolved x on x.recruiter_id = r.recruiter_id" +
    "   join public.direct_entries e on e.recruiter_id = r.recruiter_id" +
    "   join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    "  where s.state = 'SUBMITTED' and e.deleted_at is null" +
    "    and e.first_work_date >= public.direct_entry_reporting_cutoff()) as entries_with_unambiguous_key");
  const perCode = await client.query(
    "with candidate as (select distinct b.recruiter_display, b.recruiter_key" +
    " from public.daily_recruitment_breakdown b where b.recruiter_key in (" + CODE_LIST + "))," +
    " resolved as (select r.recruiter_id, min(c.recruiter_key) as reporting_key" +
    " from public.recruiters r join candidate c on c.recruiter_display = r.display_name" +
    " group by r.recruiter_id having count(distinct c.recruiter_key) = 1)" +
    " select x.reporting_key as key, count(*)::int as n" +
    " from public.direct_entries e" +
    " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    " join resolved x on x.recruiter_id = e.recruiter_id" +
    " where s.state = 'SUBMITTED' and e.deleted_at is null" +
    " and e.first_work_date >= public.direct_entry_reporting_cutoff()" +
    " group by 1 order by 2 desc, 1");
  const projects = await client.query(
    "select p.display_name as project, e.provider_type as provider, count(*)::int as n" + base.replace("join public.recruiters r on r.recruiter_id = e.recruiter_id", "join public.direct_entry_projects p on p.project_id = e.project_id") +
    " group by 1, 2 order by 1, 2");
  return {
    legacy_table: legacy,
    mapping,
    per_code_counts_from_legacy: Object.fromEntries(perCode.rows.map((r) => [r.key, r.n])),
    per_project_provider_counts: projects.rows.map((r) => ({ project: r.project, provider: r.provider, n: r.n })),
  };
}
// Evidence-backed correction preview: for every recruiter that owns a fact in the
// window, show (a) the code derivable from the DB (personnel_code for HRP,
// membership vendor_id for Vendor), (b) the membership window that must cover the
// facts, and (c) whether the stored provider_type agrees with the membership and
// with the code suffix. Rows are identified by an ordinal index - never a UUID.
async function correctionPreview(client) {
  const rows = await client.query(
    "with facts as (" +
    "  select e.recruiter_id, e.provider_type, e.first_work_date" +
    "    from public.direct_entries e" +
    "    join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    "   where s.state = 'SUBMITTED' and e.deleted_at is null" +
    "     and e.first_work_date >= public.direct_entry_reporting_cutoff())," +
    " per_recruiter as (" +
    "  select f.recruiter_id, count(*)::int as facts," +
    "    count(distinct f.provider_type)::int as distinct_stored_providers," +
    "    min(f.first_work_date)::text as first_work_min," +
    "    max(f.first_work_date)::text as first_work_max" +
    "    from facts f group by f.recruiter_id)" +
    " select row_number() over (order by p.first_work_min, p.facts desc) as idx," +
    "   p.facts," +
    "   p.distinct_stored_providers," +
    "   p.first_work_min," +
    "   p.first_work_max," +
    "   (select count(*)::int from public.recruiter_provider_memberships m where m.recruiter_id = p.recruiter_id) as membership_rows," +
    "   (select count(distinct m.provider_type)::int from public.recruiter_provider_memberships m where m.recruiter_id = p.recruiter_id) as membership_providers," +
    "   (select min(m.valid_from)::text from public.recruiter_provider_memberships m where m.recruiter_id = p.recruiter_id) as membership_valid_from," +
    "   (select count(*)::int from public.recruiter_provider_memberships m" +
    "     where m.recruiter_id = p.recruiter_id" +
    "       and not exists (select 1 from facts f2 where f2.recruiter_id = p.recruiter_id and f2.provider_type = m.provider_type)) as memberships_contradicting_facts," +
    "   (select count(*)::int from public.recruiter_aliases a where a.recruiter_id = p.recruiter_id) as alias_rows," +
    "   (select nullif(btrim(rec.personnel_code), '') from public.recruiters rec where rec.recruiter_id = p.recruiter_id) as personnel_code" +
    "  from per_recruiter p");
  const derived = rows.rows.map((row, index) => ({
    index: index + 1,
    facts: row.facts,
    stored_providers: row.distinct_stored_providers,
    first_work_min: row.first_work_min,
    first_work_max: row.first_work_max,
    membership_rows: row.membership_rows,
    membership_providers: row.membership_providers,
    membership_valid_from: row.membership_valid_from,
    memberships_contradicting_facts: row.memberships_contradicting_facts,
    alias_rows: row.alias_rows,
    has_personnel_code: row.personnel_code !== null,
  }));
  const perCode = await client.query(
    "with facts as (" +
    "  select e.recruiter_id, e.provider_type" +
    "    from public.direct_entries e" +
    "    join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
    "   where s.state = 'SUBMITTED' and e.deleted_at is null" +
    "     and e.first_work_date >= public.direct_entry_reporting_cutoff())" +
    " select coalesce(" +
    "   case when f.provider_type = 'hrp' then nullif(btrim(rec.personnel_code), '')" +
    "        else (select m.vendor_id from public.recruiter_provider_memberships m" +
    "               where m.recruiter_id = f.recruiter_id and m.vendor_id is not null" +
    "               order by m.valid_from desc limit 1) end, '(none)') as code," +
    "   count(*)::int as n" +
    "  from facts f join public.recruiters rec on rec.recruiter_id = f.recruiter_id" +
    " group by 1 order by 2 desc, 1");
  return {
    recruiters: derived,
    derived_code_counts: Object.fromEntries(perCode.rows.map((r) => [r.code, r.n])),
  };
}
async function runCheck(client) {
  const cutoff = await scalar(client, "select public.direct_entry_reporting_cutoff()::text as cutoff");
  return {
    mode: "check",
    cutoff: cutoff.cutoff,
    reporting_window: await reportingWindow(client),
    mapping_coverage: await mappingCoverage(client),
    key_distribution: await keyDistribution(client),
    evidence: await classificationEvidence(client),
    legacy_alias_evidence: await legacyAliasEvidence(client),
    correction_preview: await correctionPreview(client),
  };
}

async function main() {
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    await client.query("begin read only");
    try {
      console.log(JSON.stringify(await runCheck(client), null, 2));
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("P2_DE_DIM_CHECK_FAILED " + (error && error.message ? error.message : "UNKNOWN"));
  process.exitCode = 1;
});
