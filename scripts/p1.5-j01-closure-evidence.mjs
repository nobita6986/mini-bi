#!/usr/bin/env node
/**
 * P1.5-J01-S01 - Thu thap bang chung production (READ-ONLY).
 *
 * - Mo phien DB o che do read-only (default_transaction_read_only = on): khong the mutation.
 * - KHONG goi AI provider, KHONG deploy, KHONG doi env/policy.
 * - Chi in projection da loc: khong packet/request/analysis raw/prompt/secret/PII.
 *
 * Dung: node scripts/p1.5-j01-closure-evidence.mjs
 * Ghi file: dat bien moi truong J01_EVIDENCE_OUT=<duong dan json>.
 */
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import pg from 'pg';

import { loadSupabaseConfig } from './lib/load-supabase-config.mjs';
import { buildSslOptions } from './lib/supabase-tls.mjs';

const MASK_LENGTH = 8;

const REDACT_KEYS = new Set([
  'job_id',
  'revision_id',
  'identity_hash',
  'actor_ref',
  'created_by_ref',
  'approved_by_ref',
  'rejected_by_ref',
  'updated_by_ref',
  'key_fingerprint',
  'key_fingerprint_prefix',
  'lease_owner',
  'lease_token',
  'logical_call_id',
]);

function mask(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text === '') return '';
  if (text.length <= MASK_LENGTH) return '***';
  return text.slice(0, MASK_LENGTH) + '***';
}

function redact(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = REDACT_KEYS.has(key) ? mask(item) : redact(item);
    }
    return out;
  }
  return value;
}

const AI_TABLES = "('ai_report_jobs','ai_report_revisions','ai_report_usage','ai_report_audit_events','ai_provider_configs','ai_provider_config_audit_events')";

const QUERIES = [
  ['migrations', 'select version, checksum, applied_at from public.schema_migrations order by version'],
  ['rpc_grants', "select p.proname, pg_get_function_identity_arguments(p.oid) as args, coalesce(array_to_string(p.proconfig, ','), '(none)') as config, has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('ai_report_review_capability', 'ai_report_approve_revision', 'ai_report_reject_revision', 'ai_report_history') order by p.proname"],
  ['rls_tables', "select c.relname as table_name, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in " + AI_TABLES + " order by c.relname"],
  ['audit_constraints', "select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'public.ai_report_audit_events'::regclass order by conname"],
  ['review_triggers', "select t.tgname, t.tgrelid::regclass::text as table_name, t.tgenabled from pg_trigger t where not t.tgisinternal and t.tgrelid in ('public.ai_report_audit_events'::regclass, 'public.ai_report_revisions'::regclass, 'public.ai_report_jobs'::regclass) order by table_name, t.tgname"],
  ['job_recent', 'select job_id, status, attempts, max_attempts, generation_kind, prompt_version, provider_key, model_key, adapter_version, packet_contract_version, output_contract_version, error_code, (revision_id is not null) as has_revision, length(identity_hash) as identity_hash_length, created_at, updated_at, completed_at from public.ai_report_jobs order by created_at desc limit 5'],
  ['job_by_status', 'select status, count(*)::int as jobs from public.ai_report_jobs group by status order by jobs desc'],
  ['job_by_profile', 'select prompt_version, provider_key, model_key, adapter_version, generation_kind, count(*)::int as jobs from public.ai_report_jobs group by 1, 2, 3, 4, 5 order by jobs desc'],
  ['job_identity', 'select count(*)::int as jobs, count(distinct identity_hash)::int as distinct_identity, count(*) filter (where (revision_id is not null))::int as jobs_with_revision from public.ai_report_jobs'],
  ['job_identity_reuse', 'select identity_hash, count(*)::int as jobs from public.ai_report_jobs group by 1 having count(*) > 1 order by jobs desc limit 5'],
  ['revision_recent', "select r.revision_id, r.job_id, r.revision_number, r.lifecycle_status, r.contract_version, r.prompt_version, r.provider_key, r.model_key, (r.approved_at is not null) as approved, (r.rejected_at is not null) as rejected, r.created_at, (select array_agg(k order by k) from jsonb_object_keys(r.analysis) as t(k)) as analysis_keys, jsonb_array_length(coalesce(r.analysis->'findings', '[]'::jsonb)) as findings_count, jsonb_array_length(coalesce(r.analysis->'overall_limitations', '[]'::jsonb)) as limitations_count, jsonb_array_length(coalesce(r.analysis->'executive_evidence_refs', '[]'::jsonb)) as executive_evidence_count from public.ai_report_revisions r order by r.created_at desc limit 5"],
  ['revision_by_lifecycle', 'select lifecycle_status, count(*)::int as revisions from public.ai_report_revisions group by lifecycle_status order by revisions desc'],
  ['finding_categories', "select (f->>'category') as category, count(*)::int as findings, count(*) filter (where coalesce(jsonb_array_length(f->'evidence_refs'), 0) = 0)::int as without_evidence, count(*) filter (where (f->>'confidence') = 'high')::int as high_confidence from public.ai_report_revisions r, jsonb_array_elements(coalesce(r.analysis->'findings', '[]'::jsonb)) f group by 1 order by findings desc"],
  ['finding_shapes', "select distinct (select array_agg(k order by k) from jsonb_object_keys(f) as t(k)) as finding_keys from public.ai_report_revisions r, jsonb_array_elements(coalesce(r.analysis->'findings', '[]'::jsonb)) f"],
  ['revision_limitations', "select count(*)::int as revisions, count(*) filter (where jsonb_array_length(coalesce(analysis->'overall_limitations', '[]'::jsonb)) > 0)::int as with_limitations, count(*) filter (where length(coalesce(analysis->>'executive_analysis', '')) > 0)::int as with_executive from public.ai_report_revisions"],
  ['usage_recent_jobs', 'select job_id, count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens, coalesce(max(retry_count), 0)::int as max_retry, min(latency_ms)::int as min_latency_ms, max(latency_ms)::int as max_latency_ms, min(created_at) as first_call_at, max(created_at) as last_call_at from public.ai_report_usage group by job_id order by max(created_at) desc limit 5'],
  ['usage_outcomes', 'select call_outcome, count(*)::int as calls, coalesce(sum(retry_count), 0)::int as retries, count(*) filter (where cache_hit)::int as cache_hits from public.ai_report_usage group by call_outcome order by calls desc'],
  ['usage_daily', "select (created_at at time zone 'Asia/Ho_Chi_Minh')::date as day, count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens from public.ai_report_usage group by 1 order by 1 desc limit 7"],
  ['audit_event_types', 'select event_type, count(*)::int as events from public.ai_report_audit_events group by event_type order by events desc'],
  ['audit_recent', 'select event_type, job_id, created_at from public.ai_report_audit_events order by event_id desc limit 12'],
  ['provider_configs', 'select config_id, version, pilot_scope, provider_profile, sanitized_host, model, status, verified_at, last_tested_at, optimistic_version, left(key_fingerprint, 4) as key_fingerprint_prefix, created_at, updated_at from public.ai_provider_configs order by config_id, version'],
  ['job_failures', "select job_id, status, error_code, (error_message is not null) as has_error_message, coalesce(length(error_message), 0) as error_message_length, attempts, max_attempts, adapter_version, prompt_version, generation_kind, created_at from public.ai_report_jobs where status like 'failed%' order by created_at desc limit 12"],
  ['job_adapter_mix', 'select adapter_version, provider_key, status, count(*)::int as jobs, min(created_at) as first_at, max(created_at) as last_at from public.ai_report_jobs group by 1, 2, 3 order by last_at desc'],
  ['usage_timeline', 'select job_id, call_outcome, input_tokens, output_tokens, retry_count, latency_ms, created_at from public.ai_report_usage order by created_at'],
  ['audit_review_events', "select event_type, job_id, (reason is null) as has_reason, created_at from public.ai_report_audit_events where event_type in ('revision_approved', 'revision_rejected') order by event_id desc"],
  ['revision_review_meta', 'select revision_number, lifecycle_status, (approved_by_ref is not null) as has_approver, (rejected_at is not null) as rejected, created_at from public.ai_report_revisions order by created_at desc limit 7'],
];

async function main() {
  const { databaseUrl, projectRef } = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  await client.query('set default_transaction_read_only = on');

  const report = {
    step: 'P1.5-J01-S01',
    generated_at: new Date().toISOString(),
    project_ref: projectRef.slice(0, 4) + '***',
    note: 'read-only session; khong packet/request/analysis raw/secret/PII',
    results: {},
  };

  const setting = await client.query("select current_setting('default_transaction_read_only') as read_only, current_user as db_role");
  report.session = setting.rows[0];

  for (const [name, sql] of QUERIES) {
    try {
      const result = await client.query(sql);
      report.results[name] = { row_count: result.rowCount, rows: redact(result.rows) };
    } catch (error) {
      report.results[name] = { error: String(error.message) };
    }
  }

  await client.end();

  const json = JSON.stringify(report, null, 1);
  const out = process.env.J01_EVIDENCE_OUT;
  if (out) {
    await writeFile(out, json, 'utf8');
    console.log('Da ghi bang chung: ' + out);
  } else {
    console.log(json);
  }
}

main().catch((error) => {
  console.error('EVIDENCE LOI: ' + error.message);
  process.exitCode = 1;
});
