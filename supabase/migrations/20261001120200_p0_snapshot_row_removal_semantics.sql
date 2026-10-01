-- =============================================================================
-- P0-T1-G1 — Sửa ngữ nghĩa daily_rows_removed của ingestion boundary.
--
-- Vấn đề: bản đầu của replace_daily_recruitment_snapshot_v01 xóa TOÀN BỘ dòng của
-- source rồi ghi lại, nên daily_rows_removed đếm cả những ngày vẫn còn trong
-- snapshot mới. Ca nghiệm thu D (bỏ 1 ngày) trả về removed = 2 thay vì 1.
--
-- Sửa: chỉ xóa những business_date không còn trong snapshot mới, và upsert các
-- ngày còn lại (giữ created_at). Kết quả daily counts và tính nguyên tử không đổi.
--
-- Không sửa file migration đã áp dụng; thay thế function bằng migration mới.
-- =============================================================================

create or replace function public.replace_daily_recruitment_snapshot_v01(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  c_contract_version    constant text   := 'daily-recruitment-count/0.1';
  c_timezone            constant text   := 'Asia/Ho_Chi_Minh';
  c_payload_keys        constant text[] := array[
    'contract_version', 'drive_file_id', 'file_name', 'sheet_name', 'sync_run_id',
    'trigger_type', 'snapshot_at', 'timezone', 'rows_read', 'rows_valid',
    'rows_rejected', 'daily_counts'
  ];
  c_daily_keys          constant text[] := array['business_date', 'recruited_count'];
  c_trigger_types       constant text[] := array['manual', 'schedule', 'bot'];
  c_iso_date            constant text   := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  c_uint                constant text   := '^[0-9]{1,9}$';
  c_timestamp_with_tz   constant text   := '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:?[0-9]{2})$';
  c_safe_field_name     constant text   := '^[A-Za-z0-9_]{1,64}$';

  v_error_code          text := null;
  v_error_reason        text := null;

  v_key                 text;
  v_drive_file_id       text;
  v_file_name           text;
  v_sheet_name          text;
  v_sync_run_id         uuid   := null;
  v_trigger_type        text;
  v_snapshot_at         timestamptz := null;
  v_timezone            text;
  v_rows_read           integer;
  v_rows_valid          integer;
  v_rows_rejected       integer;
  v_daily               jsonb;

  v_source_id           uuid := null;
  v_run_source_id       uuid := null;
  v_element             jsonb;
  v_business_date       date := null;
  v_count               integer;
  v_sum                 bigint := 0;
  v_seen_dates          date[] := array[]::date[];
  v_incoming            jsonb;
  v_current             jsonb;
  v_outcome             text;
  v_status              text;
  v_removed             integer := 0;
  v_current_rows        integer := 0;
  v_current_total       bigint := 0;
begin
  -- ===========================================================================
  -- PHASE 1 — Validation (chỉ đọc, không ghi dữ liệu)
  -- ===========================================================================
  <<validate>>
  begin
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
      v_error_code := 'INVALID_PAYLOAD';
      v_error_reason := 'payload phải là JSON object';
      exit validate;
    end if;

    -- Trích xuất định danh trước tiên (không kiểm tra) để mọi từ chối sau đây
    -- vẫn ghi được sync_runs/sync_errors với đúng run_id và source.
    v_drive_file_id := nullif(btrim(coalesce(p_payload->>'drive_file_id', '')), '');
    v_file_name     := nullif(btrim(coalesce(p_payload->>'file_name', '')), '');
    v_sheet_name    := nullif(btrim(coalesce(p_payload->>'sheet_name', '')), '');
    v_trigger_type  := p_payload->>'trigger_type';

    if coalesce(p_payload->>'sync_run_id', '')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_sync_run_id := (p_payload->>'sync_run_id')::uuid;
    end if;

    for v_key in select jsonb_object_keys(p_payload) loop
      if not (v_key = any (c_payload_keys)) then
        v_error_code := 'UNKNOWN_FIELD';
        v_error_reason := case when v_key ~ c_safe_field_name
                               then 'field ngoài contract: ' || v_key
                               else 'payload chứa field ngoài contract' end;
        exit validate;
      end if;
    end loop;

    if p_payload->>'contract_version' is distinct from c_contract_version then
      v_error_code := 'UNSUPPORTED_CONTRACT_VERSION';
      v_error_reason := 'contract_version không được hỗ trợ: '
                        || coalesce(left(p_payload->>'contract_version', 64), '(thiếu)');
      exit validate;
    end if;

    if v_drive_file_id is null then
      v_error_code := 'MISSING_DRIVE_FILE_ID';
      v_error_reason := 'drive_file_id là bắt buộc và không được rỗng';
      exit validate;
    end if;

    if v_file_name is null then
      v_error_code := 'MISSING_FILE_NAME';
      v_error_reason := 'file_name là bắt buộc và không được rỗng';
      exit validate;
    end if;

    if v_sheet_name is null then
      v_error_code := 'MISSING_SHEET_NAME';
      v_error_reason := 'sheet_name là bắt buộc và không được rỗng';
      exit validate;
    end if;

    if v_sync_run_id is null then
      v_error_code := 'INVALID_SYNC_RUN_ID';
      v_error_reason := 'sync_run_id phải là uuid';
      exit validate;
    end if;

    if v_trigger_type is null or not (v_trigger_type = any (c_trigger_types)) then
      v_error_code := 'INVALID_TRIGGER_TYPE';
      v_error_reason := 'trigger_type phải là manual|schedule|bot';
      exit validate;
    end if;

    v_timezone := p_payload->>'timezone';
    if v_timezone is distinct from c_timezone then
      v_error_code := 'UNSUPPORTED_TIMEZONE';
      v_error_reason := 'timezone phải là ' || c_timezone;
      exit validate;
    end if;

    if coalesce(p_payload->>'snapshot_at', '') ~ c_timestamp_with_tz then
      begin
        v_snapshot_at := (p_payload->>'snapshot_at')::timestamptz;
      exception when others then
        v_snapshot_at := null;
      end;
    end if;
    if v_snapshot_at is null then
      v_error_code := 'INVALID_SNAPSHOT_AT';
      v_error_reason := 'snapshot_at phải là timestamp ISO-8601 có offset (ví dụ 2026-10-01T09:30:00Z)';
      exit validate;
    end if;

    if jsonb_typeof(p_payload->'rows_read') <> 'number'
       or (p_payload->>'rows_read') !~ c_uint
       or jsonb_typeof(p_payload->'rows_valid') <> 'number'
       or (p_payload->>'rows_valid') !~ c_uint
       or jsonb_typeof(p_payload->'rows_rejected') <> 'number'
       or (p_payload->>'rows_rejected') !~ c_uint then
      v_error_code := 'INVALID_COUNTS';
      v_error_reason := 'rows_read/rows_valid/rows_rejected phải là số nguyên >= 0';
      exit validate;
    end if;
    v_rows_read     := (p_payload->>'rows_read')::integer;
    v_rows_valid    := (p_payload->>'rows_valid')::integer;
    v_rows_rejected := (p_payload->>'rows_rejected')::integer;

    if jsonb_typeof(p_payload->'daily_counts') <> 'array' then
      v_error_code := 'INVALID_DAILY_COUNTS';
      v_error_reason := 'daily_counts phải là array';
      exit validate;
    end if;
    v_daily := p_payload->'daily_counts';

    for v_element in select jsonb_array_elements(v_daily) loop
      if jsonb_typeof(v_element) <> 'object' then
        v_error_code := 'INVALID_DAILY_COUNTS';
        v_error_reason := 'phần tử daily_counts phải là object';
        exit validate;
      end if;

      for v_key in select jsonb_object_keys(v_element) loop
        if not (v_key = any (c_daily_keys)) then
          v_error_code := 'UNKNOWN_FIELD';
          v_error_reason := 'daily_counts chứa field ngoài contract';
          exit validate;
        end if;
      end loop;

      if not (v_element ? 'business_date') or not (v_element ? 'recruited_count') then
        v_error_code := 'INVALID_DAILY_COUNTS';
        v_error_reason := 'daily_counts thiếu business_date hoặc recruited_count';
        exit validate;
      end if;

      if jsonb_typeof(v_element->'business_date') <> 'string'
         or (v_element->>'business_date') !~ c_iso_date then
        v_error_code := 'INVALID_DATE';
        v_error_reason := 'business_date phải là chuỗi YYYY-MM-DD';
        exit validate;
      end if;

      begin
        v_business_date := (v_element->>'business_date')::date;
      exception when others then
        v_business_date := null;
      end;
      if v_business_date is null then
        v_error_code := 'INVALID_DATE';
        v_error_reason := 'business_date không phải ngày lịch hợp lệ';
        exit validate;
      end if;

      if jsonb_typeof(v_element->'recruited_count') <> 'number'
         or (v_element->>'recruited_count') !~ c_uint then
        v_error_code := 'INVALID_VALUE';
        v_error_reason := 'recruited_count phải là số nguyên >= 0';
        exit validate;
      end if;
      v_count := (v_element->>'recruited_count')::integer;

      if v_business_date = any (v_seen_dates) then
        v_error_code := 'DUPLICATE_BUSINESS_DATE';
        v_error_reason := 'business_date xuất hiện nhiều lần trong cùng snapshot';
        exit validate;
      end if;
      v_seen_dates := v_seen_dates || v_business_date;

      v_sum := v_sum + v_count;
    end loop;

    if v_rows_valid + v_rows_rejected <> v_rows_read then
      v_error_code := 'ROWS_COUNT_MISMATCH';
      v_error_reason := 'rows_valid + rows_rejected phải bằng rows_read';
      exit validate;
    end if;

    if v_sum <> v_rows_valid then
      v_error_code := 'COUNT_MISMATCH';
      v_error_reason := 'tổng recruited_count phải bằng rows_valid';
      exit validate;
    end if;

    select id into v_source_id
      from public.data_sources
     where drive_file_id = v_drive_file_id;

    select source_id into v_run_source_id
      from public.sync_runs
     where run_id = v_sync_run_id;

    if v_run_source_id is not null
       and (v_source_id is null or v_source_id <> v_run_source_id) then
      v_error_code := 'RUN_SOURCE_MISMATCH';
      v_error_reason := 'sync_run_id đã thuộc source khác';
      exit validate;
    end if;
  end validate;

  if v_error_code is not null then
    return public.reject_daily_recruitment_snapshot_v01(
      v_drive_file_id, v_sync_run_id, v_trigger_type, v_snapshot_at,
      v_rows_read, v_rows_valid, v_rows_rejected, v_error_code, v_error_reason
    );
  end if;

  -- ===========================================================================
  -- PHASE 2 — Ghi dữ liệu (một transaction; lỗi => rollback toàn bộ block này)
  -- ===========================================================================
  <<write>>
  begin
    insert into public.data_sources (drive_file_id, file_name, sheet_name, active, first_seen_at, last_seen_at)
    values (v_drive_file_id, v_file_name, v_sheet_name, true, now(), v_snapshot_at)
    on conflict (drive_file_id) do update
      set file_name  = excluded.file_name,
          sheet_name = excluded.sheet_name,
          last_seen_at = greatest(public.data_sources.last_seen_at, excluded.last_seen_at)
    returning id into v_source_id;

    v_status := case when v_rows_rejected > 0 then 'partial' else 'succeeded' end;

    perform public.upsert_daily_recruitment_run_v01(
      v_sync_run_id, v_source_id, v_trigger_type, v_snapshot_at, v_status,
      v_rows_read, v_rows_valid, v_rows_rejected, null, null
    );

    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'business_date', to_char(c.business_date, 'YYYY-MM-DD'),
                 'recruited_count', c.recruited_count
               ) order by c.business_date
             ),
             '[]'::jsonb
           )
      into v_current
      from public.daily_recruitment_counts c
     where c.source_id = v_source_id;

    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'business_date', e.business_date,
                 'recruited_count', e.recruited_count
               ) order by e.business_date
             ),
             '[]'::jsonb
           )
      into v_incoming
      from jsonb_to_recordset(v_daily) as e(business_date text, recruited_count integer);

    if v_incoming = v_current then
      v_outcome := 'unchanged';
      v_removed := 0;
    else
      -- Chỉ xóa đúng những ngày không còn trong snapshot mới; giữ created_at của
      -- những ngày không đổi (docs/P0.md §7.4: "giữ created time" khi cập nhật).
      delete from public.daily_recruitment_counts c
       where c.source_id = v_source_id
         and c.business_date not in (
               select e.business_date::date
                 from jsonb_to_recordset(v_daily) as e(business_date text, recruited_count integer)
             );
      get diagnostics v_removed = row_count;

      insert into public.daily_recruitment_counts
        (source_id, business_date, recruited_count, sync_run_id, snapshot_at)
      select v_source_id, e.business_date::date, e.recruited_count, v_sync_run_id, v_snapshot_at
        from jsonb_to_recordset(v_daily) as e(business_date text, recruited_count integer)
      on conflict (source_id, business_date) do update
        set recruited_count = excluded.recruited_count,
            sync_run_id     = excluded.sync_run_id,
            snapshot_at     = excluded.snapshot_at;

      v_outcome := 'applied';
    end if;

    if v_status = 'succeeded' then
      update public.data_sources
         set last_successful_sync_at = greatest(last_successful_sync_at, v_snapshot_at)
       where id = v_source_id;
    end if;

    select count(*), coalesce(sum(recruited_count), 0)
      into v_current_rows, v_current_total
      from public.daily_recruitment_counts
     where source_id = v_source_id;
  exception when others then
    if v_error_code is null then
      v_error_code := 'DB_WRITE_FAILED';
      v_error_reason := left(sqlstate || ': ' || sqlerrm, 500);
    end if;
  end write;

  if v_error_code is not null then
    return public.reject_daily_recruitment_snapshot_v01(
      v_drive_file_id, v_sync_run_id, v_trigger_type, v_snapshot_at,
      v_rows_read, v_rows_valid, v_rows_rejected, v_error_code, v_error_reason
    );
  end if;

  return jsonb_build_object(
    'outcome',               v_outcome,
    'contract_version',      c_contract_version,
    'source_id',             v_source_id,
    'sync_run_id',           v_sync_run_id,
    'run_status',            v_status,
    'daily_rows_current',    v_current_rows,
    'daily_rows_removed',    v_removed,
    'recruited_count_total', v_current_total,
    'run_logged',            true,
    'error_code',            null,
    'sanitized_reason',      null
  );
end;
$function$;

comment on function public.replace_daily_recruitment_snapshot_v01(jsonb) is
  'Contract daily-recruitment-count/0.1. Thay thế toàn bộ snapshot daily counts của một source theo drive_file_id.';

-- -----------------------------------------------------------------------------
-- Quyền: chỉ service_role được gọi ingestion boundary.
-- -----------------------------------------------------------------------------
revoke all on function public.upsert_daily_recruitment_run_v01(uuid, uuid, text, timestamptz, text, integer, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.reject_daily_recruitment_snapshot_v01(text, uuid, text, timestamptz, integer, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.replace_daily_recruitment_snapshot_v01(jsonb) from public, anon, authenticated;

grant execute on function public.upsert_daily_recruitment_run_v01(uuid, uuid, text, timestamptz, text, integer, integer, integer, text, text) to service_role;
grant execute on function public.reject_daily_recruitment_snapshot_v01(text, uuid, text, timestamptz, integer, integer, integer, text, text) to service_role;
grant execute on function public.replace_daily_recruitment_snapshot_v01(jsonb) to service_role;

revoke all on function public.replace_daily_recruitment_snapshot_v01(jsonb) from public, anon, authenticated;
grant execute on function public.replace_daily_recruitment_snapshot_v01(jsonb) to service_role;
