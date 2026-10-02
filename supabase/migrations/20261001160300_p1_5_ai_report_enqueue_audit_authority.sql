-- P1.5-W04-R4 — Durable audit: job_reused / job_cache_hit nằm TRONG ai_report_enqueue (cùng transaction).
--
-- Root cause: quyết định reuse/cache-hit do RPC trả về nhưng event audit lại do application ghi ⇒ hai authority,
-- và application có thể trả success dù audit insert thất bại.
-- R4: cả ba nhánh (new / reuse / cache-hit) ghi audit NGAY TRONG RPC ⇒ quyết định + audit cùng transaction.
--
-- ROLLBACK: tạo lại ai_report_enqueue bản 20261001160000 (không có 2 insert audit reuse/cache-hit).

create or replace function public.ai_report_enqueue(
  p_identity_hash text,
  p_identity_components jsonb,
  p_request jsonb,
  p_actor_ref text,
  p_access_scope_hash text,
  p_snapshot_hash text,
  p_lineage_ref text,
  p_packet jsonb,
  p_packet_hash text,
  p_packet_contract_version text,
  p_output_contract_version text,
  p_prompt_version text,
  p_provider_key text,
  p_model_key text,
  p_adapter_version text,
  p_max_attempts integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_revision_id uuid;
  v_revision_job uuid;
begin
  if p_identity_hash is null or length(p_identity_hash) < 16 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'identity_hash không hợp lệ');
  end if;

  -- 1) Job đang hoạt động cùng identity ⇒ REUSE (+ audit trong cùng transaction).
  select * into v_job
    from public.ai_report_jobs
   where identity_hash = p_identity_hash
     and status in ('requested','queued','computing','ai_generating','validating')
   order by created_at desc
   limit 1;
  if found then
    insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
    values (v_job.job_id, 'job_reused', p_actor_ref, null, jsonb_build_object('status', v_job.status));
    return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                              'reused', true, 'cache_hit', false, 'revision_id', v_job.revision_id);
  end if;

  -- 2) Đã có revision hợp lệ cùng identity ⇒ CACHE HIT (+ audit trong cùng transaction).
  select r.revision_id, r.job_id into v_revision_id, v_revision_job
    from public.ai_report_revisions r
    join public.ai_report_jobs j on j.job_id = r.job_id
   where j.identity_hash = p_identity_hash
     and r.lifecycle_status in ('draft','approved')
   order by r.created_at desc
   limit 1;
  if v_revision_id is not null then
    insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
    values (v_revision_job, 'job_cache_hit', p_actor_ref, null, jsonb_build_object('revision_id', v_revision_id));
    return jsonb_build_object('ok', true, 'job_id', v_revision_job, 'status', 'draft',
                              'reused', false, 'cache_hit', true, 'revision_id', v_revision_id);
  end if;

  -- 3) Tạo job mới; unique index partial chặn đua ⇒ reuse job thắng.
  begin
    insert into public.ai_report_jobs (
      identity_hash, identity_components, request, actor_ref, access_scope_hash, snapshot_hash, lineage_ref,
      packet, packet_hash, packet_contract_version, output_contract_version,
      prompt_version, provider_key, model_key, adapter_version, status, max_attempts
    ) values (
      p_identity_hash, p_identity_components, p_request, p_actor_ref, p_access_scope_hash, p_snapshot_hash, p_lineage_ref,
      p_packet, p_packet_hash, p_packet_contract_version, p_output_contract_version,
      p_prompt_version, p_provider_key, p_model_key, p_adapter_version, 'queued', greatest(1, least(5, coalesce(p_max_attempts, 3)))
    )
    returning * into v_job;
  exception when unique_violation then
    select * into v_job
      from public.ai_report_jobs
     where identity_hash = p_identity_hash
       and status in ('requested','queued','computing','ai_generating','validating')
     order by created_at desc
     limit 1;
    if not found then
      raise;
    end if;
    insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
    values (v_job.job_id, 'job_reused', p_actor_ref, null, jsonb_build_object('status', v_job.status, 'race', true));
    return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                              'reused', true, 'cache_hit', false, 'revision_id', v_job.revision_id);
  end;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (v_job.job_id, 'job_enqueued', p_actor_ref, null,
          jsonb_build_object('prompt_version', p_prompt_version, 'provider_key', p_provider_key, 'model_key', p_model_key));

  return jsonb_build_object('ok', true, 'job_id', v_job.job_id, 'status', v_job.status,
                            'reused', false, 'cache_hit', false, 'revision_id', null);
end;
$$;

revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) from public;
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) from anon;
revoke all on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) from authenticated;
grant execute on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) to service_role;

comment on function public.ai_report_enqueue(text, jsonb, jsonb, text, text, text, text, jsonb, text, text, text, text, text, text, text, integer) is
  'P1.5-W04-R4 — enqueue-or-reuse với audit (enqueued/reused/cache_hit) trong cùng transaction.';
