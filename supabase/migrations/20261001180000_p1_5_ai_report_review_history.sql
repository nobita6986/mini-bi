-- P1.5-W05-S02 — Durable report history + approve/reject lifecycle.
--
-- Khong sua migration da apply: day la migration MOI (timestamp 180000 > 170100), CHUA apply DEV
-- (cho den khi T0 xac nhan T1B ket thuc G3).
--
-- 1) Review lifecycle RPC (approve/reject) — chi revision lifecycle=draft duoc quyet dinh; OCC theo
--    expected_revision_number; approve/reject idempotent co kiem soat; quyet dinh mau thuan/stale fail-closed;
--    reject bat buoc reason; lifecycle + actor + timestamp + audit CUNG transaction; audit insert loi => rollback.
-- 2) ai_report_history — phan trang keyset (created_at desc + job_id tie-break), chi tra projection UI an toan.
-- 3) ai_report_review_capability — de capability route phan anh RPC thuc su kha dung (fail-closed khi chua apply).
--
-- Security: SECURITY DEFINER + search_path co dinh; chi service_role EXECUTE; revoke PUBLIC/anon/authenticated.
-- Khong tra packet/prompt/raw provider output/API config/secret.

-- ---------------------------------------------------------------------------
-- 0) Mo rong tap event_type cua audit (append-only)
-- ---------------------------------------------------------------------------
alter table public.ai_report_audit_events drop constraint if exists ai_report_audit_event_type_check;
alter table public.ai_report_audit_events add constraint ai_report_audit_event_type_check check (event_type in (
  'job_enqueued','job_reused','job_cache_hit','job_claimed','job_stage','job_completed',
  'job_completed_idempotent','job_failed','job_regenerated','job_recovered',
  'revision_approved','revision_rejected'));

-- Defense-in-depth: analysis khong the bi sua truc tiep tu service_role (chi qua RPC definer).
revoke update on table public.ai_report_revisions from service_role;

-- ---------------------------------------------------------------------------
-- 1) Review capability (phan anh RPC thuc su kha dung)
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_review_capability()
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('ok', true, 'approve', true, 'reject', true, 'regenerate', true);
$$;

-- ---------------------------------------------------------------------------
-- 2) Approve draft revision
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_approve_revision(
  p_job_id uuid,
  p_expected_revision_number integer,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_rev public.ai_report_revisions;
begin
  if p_expected_revision_number is null or p_expected_revision_number < 1 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'thiếu expected_revision_number');
  end if;
  if p_actor_ref is null or length(btrim(p_actor_ref)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'thiếu actor');
  end if;

  perform pg_advisory_xact_lock(hashtext('ai_report_review:' || p_job_id::text));

  select * into v_job from public.ai_report_jobs where job_id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_JOB_NOT_FOUND', 'message', 'không tìm thấy job');
  end if;

  select * into v_rev from public.ai_report_revisions where job_id = p_job_id order by revision_number desc limit 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_NOT_READY', 'message', 'job chưa có revision');
  end if;

  if v_rev.revision_number <> p_expected_revision_number then
    return jsonb_build_object('ok', false, 'code', 'AI_VERSION_CONFLICT', 'message', 'revision đã thay đổi (stale)');
  end if;

  if v_rev.analysis is null or jsonb_typeof(v_rev.analysis) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_NOT_READY', 'message', 'revision chưa có analysis hợp lệ');
  end if;
  if v_rev.contract_version <> 'business-analysis/0.1' then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_NOT_READY', 'message', 'revision chưa validate đúng contract');
  end if;

  if v_rev.lifecycle_status = 'approved' then
    return jsonb_build_object('ok', true, 'revision_id', v_rev.revision_id, 'lifecycle_status', 'approved', 'idempotent', true);
  end if;
  if v_rev.lifecycle_status = 'rejected' then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_CONFLICT', 'message', 'revision đã bị từ chối, không thể duyệt');
  end if;

  update public.ai_report_revisions
     set lifecycle_status = 'approved',
         approved_by_ref = btrim(p_actor_ref),
         approved_at = now()
   where revision_id = v_rev.revision_id;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (p_job_id, 'revision_approved', btrim(p_actor_ref), null,
          jsonb_build_object('revision_id', v_rev.revision_id, 'revision_number', v_rev.revision_number));

  return jsonb_build_object('ok', true, 'revision_id', v_rev.revision_id, 'lifecycle_status', 'approved', 'idempotent', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Reject draft revision (reason bat buoc)
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_reject_revision(
  p_job_id uuid,
  p_expected_revision_number integer,
  p_actor_ref text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.ai_report_jobs;
  v_rev public.ai_report_revisions;
  v_reason text;
begin
  if p_expected_revision_number is null or p_expected_revision_number < 1 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'thiếu expected_revision_number');
  end if;
  if p_actor_ref is null or length(btrim(p_actor_ref)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'thiếu actor');
  end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if length(v_reason) < 3 or length(v_reason) > 300 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'reject cần lý do 3..300 ký tự');
  end if;

  perform pg_advisory_xact_lock(hashtext('ai_report_review:' || p_job_id::text));

  select * into v_job from public.ai_report_jobs where job_id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_JOB_NOT_FOUND', 'message', 'không tìm thấy job');
  end if;

  select * into v_rev from public.ai_report_revisions where job_id = p_job_id order by revision_number desc limit 1 for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_NOT_READY', 'message', 'job chưa có revision');
  end if;

  if v_rev.revision_number <> p_expected_revision_number then
    return jsonb_build_object('ok', false, 'code', 'AI_VERSION_CONFLICT', 'message', 'revision đã thay đổi (stale)');
  end if;

  if v_rev.analysis is null or jsonb_typeof(v_rev.analysis) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_NOT_READY', 'message', 'revision chưa có analysis hợp lệ');
  end if;
  if v_rev.contract_version <> 'business-analysis/0.1' then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_NOT_READY', 'message', 'revision chưa validate đúng contract');
  end if;

  if v_rev.lifecycle_status = 'approved' then
    return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_CONFLICT', 'message', 'revision đã được duyệt, không thể từ chối');
  end if;
  if v_rev.lifecycle_status = 'rejected' then
    if v_rev.rejection_reason = v_reason then
      return jsonb_build_object('ok', true, 'revision_id', v_rev.revision_id, 'lifecycle_status', 'rejected', 'idempotent', true);
    else
      return jsonb_build_object('ok', false, 'code', 'AI_REVIEW_CONFLICT', 'message', 'revision đã bị từ chối với lý do khác');
    end if;
  end if;

  update public.ai_report_revisions
     set lifecycle_status = 'rejected',
         rejected_by_ref = btrim(p_actor_ref),
         rejected_at = now(),
         rejection_reason = v_reason
   where revision_id = v_rev.revision_id;

  insert into public.ai_report_audit_events (job_id, event_type, actor_ref, reason, payload)
  values (p_job_id, 'revision_rejected', btrim(p_actor_ref), v_reason,
          jsonb_build_object('revision_id', v_rev.revision_id, 'revision_number', v_rev.revision_number));

  return jsonb_build_object('ok', true, 'revision_id', v_rev.revision_id, 'lifecycle_status', 'rejected', 'idempotent', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) History (phan trang keyset, projection an toan)
-- ---------------------------------------------------------------------------
create or replace function public.ai_report_history(
  p_actor_ref text,
  p_cursor text,
  p_page_size integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_cursor uuid;
  v_has_more boolean := false;
  v_idx integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_next_cursor text := null;
  v_row record;
begin
  if p_actor_ref is null or length(btrim(p_actor_ref)) = 0 then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'thiếu actor');
  end if;
  v_limit := greatest(1, least(50, coalesce(p_page_size, 20)));

  if p_cursor is not null and btrim(p_cursor) <> '' then
    begin
      v_cursor := p_cursor::uuid;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'cursor không hợp lệ');
    end;
    if not exists (select 1 from public.ai_report_jobs where job_id = v_cursor) then
      return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'cursor không tồn tại');
    end if;
  end if;

  for v_row in
    select j.job_id, j.status, j.created_at, j.completed_at, j.provider_key, j.model_key,
           j.revision_id, r.revision_number, r.lifecycle_status,
           j.request->'period' as period_json,
           j.request->'scope'->'dimensions' as dimensions_json,
           j.request->>'focus' as focus
      from public.ai_report_jobs j
      left join public.ai_report_revisions r on r.revision_id = j.revision_id
     where j.actor_ref = btrim(p_actor_ref)
       and (
         v_cursor is null
         or (j.created_at, j.job_id) < ((select created_at from public.ai_report_jobs where job_id = v_cursor), v_cursor)
       )
     order by j.created_at desc, j.job_id desc
     limit v_limit + 1
  loop
    v_idx := v_idx + 1;
    if v_idx > v_limit then
      v_has_more := true;
      exit;
    end if;
    v_items := v_items || jsonb_build_object(
      'job_id', v_row.job_id,
      'status', v_row.status,
      'created_at', v_row.created_at,
      'completed_at', v_row.completed_at,
      'provider_key', v_row.provider_key,
      'model_key', v_row.model_key,
      'revision_id', v_row.revision_id,
      'revision_number', v_row.revision_number,
      'lifecycle_status', v_row.lifecycle_status,
      'period', v_row.period_json,
      'dimensions', v_row.dimensions_json,
      'focus', v_row.focus
    );
    v_next_cursor := v_row.job_id::text;
  end loop;

  return jsonb_build_object('ok', true, 'items', v_items, 'next_cursor', v_next_cursor, 'has_more', v_has_more);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Grants (chi service_role EXECUTE; revoke PUBLIC/anon/authenticated)
-- ---------------------------------------------------------------------------
revoke all on function public.ai_report_review_capability() from public;
revoke all on function public.ai_report_review_capability() from anon;
revoke all on function public.ai_report_review_capability() from authenticated;
grant execute on function public.ai_report_review_capability() to service_role;

revoke all on function public.ai_report_approve_revision(uuid, integer, text) from public;
revoke all on function public.ai_report_approve_revision(uuid, integer, text) from anon;
revoke all on function public.ai_report_approve_revision(uuid, integer, text) from authenticated;
grant execute on function public.ai_report_approve_revision(uuid, integer, text) to service_role;

revoke all on function public.ai_report_reject_revision(uuid, integer, text, text) from public;
revoke all on function public.ai_report_reject_revision(uuid, integer, text, text) from anon;
revoke all on function public.ai_report_reject_revision(uuid, integer, text, text) from authenticated;
grant execute on function public.ai_report_reject_revision(uuid, integer, text, text) to service_role;

revoke all on function public.ai_report_history(text, text, integer) from public;
revoke all on function public.ai_report_history(text, text, integer) from anon;
revoke all on function public.ai_report_history(text, text, integer) from authenticated;
grant execute on function public.ai_report_history(text, text, integer) to service_role;
