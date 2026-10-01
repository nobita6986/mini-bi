-- =============================================================================
-- P0-T1-G1-R1 — Sửa lỗi ghi log khi từ chối snapshot.
--
-- Phát hiện bởi bộ fixture R1: reject_daily_recruitment_breakdown_snapshot_v02
-- gọi upsert_daily_recruitment_run_v01 với 12 tham số trong khi hàm v01 chỉ có 10.
-- Lời gọi sai arity làm phát sinh exception, bị khối bảo vệ nuốt mất, nên payload
-- bị từ chối KHÔNG được ghi vào sync_runs/sync_errors.
--
-- Sửa: gọi upsert_daily_recruitment_run_v02 (đủ 12 tham số).
-- Forward migration: không sửa file migration đã áp dụng.
-- =============================================================================

create or replace function public.reject_daily_recruitment_breakdown_snapshot_v02(
  p_drive_file_id    text,
  p_run_id           uuid,
  p_trigger_type     text,
  p_snapshot_at      timestamptz,
  p_rows_read        integer,
  p_rows_valid       integer,
  p_rows_rejected    integer,
  p_error_code       text,
  p_sanitized_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_source_id uuid;
  v_reason    text;
  v_logged    boolean := false;
  v_status    text := null;
begin
  v_reason := coalesce(nullif(btrim(coalesce(p_sanitized_reason, '')), ''), p_error_code);

  if p_drive_file_id is not null and btrim(p_drive_file_id) <> '' then
    select id into v_source_id from public.data_sources where drive_file_id = p_drive_file_id;
  end if;

  if v_source_id is not null
     and p_run_id is not null
     and p_trigger_type in ('manual', 'schedule', 'bot') then
    <<logfail>>
    begin
      perform public.upsert_daily_recruitment_run_v02(
        p_run_id, v_source_id, p_trigger_type, p_snapshot_at, 'failed',
        coalesce(p_rows_read, 0), coalesce(p_rows_valid, 0), coalesce(p_rows_rejected, 0),
        0, 0,
        p_error_code, left(v_reason, 500)
      );

      -- Counts của một lần từ chối có thể không thoả bất biến của snapshot hợp lệ,
      -- nên chỉ ghi khi nó thoả ràng buộc của bảng; ngược lại ghi counters 0.
      insert into public.sync_errors (run_id, source_id, source_row_number, issue_level, error_code, sanitized_reason)
      values (p_run_id, v_source_id, null, 'error', p_error_code, left(v_reason, 500));

      v_logged := true;
      v_status := 'failed';
    exception when others then
      v_logged := false;
      v_status := null;
    end logfail;
  end if;

  return jsonb_build_object(
    'outcome',                'rejected',
    'contract_version',       'daily-recruitment-breakdown/0.2',
    'source_id',              v_source_id,
    'sync_run_id',            p_run_id,
    'run_status',             v_status,
    'breakdown_rows_current', null,
    'breakdown_rows_removed', null,
    'recruited_count_total',  null,
    'rows_warned',            null,
    'warning_issues',         null,
    'row_issues_logged',      0,
    'run_logged',             v_logged,
    'error_code',             p_error_code,
    'sanitized_reason',       left(v_reason, 500)
  );
end;
$function$;

revoke all on function public.reject_daily_recruitment_breakdown_snapshot_v02(text, uuid, text, timestamptz, integer, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.reject_daily_recruitment_breakdown_snapshot_v02(text, uuid, text, timestamptz, integer, integer, integer, text, text) to service_role;
