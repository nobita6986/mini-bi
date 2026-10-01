-- =============================================================================
-- P0 — Ingestion boundary cho contract daily-recruitment-breakdown/0.2
--
-- replace_daily_recruitment_breakdown_snapshot_v02(p_payload jsonb) returns jsonb
--
-- Thay thế TOÀN BỘ aggregate hiện tại của đúng một source trong một transaction.
-- Payload sai hoặc lỗi ghi => giữ nguyên snapshot thành công gần nhất.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Chuẩn hóa payload thành các dòng grain đã chuẩn hóa.
-- Dùng chung cho validate, so sánh và ghi => chỉ có MỘT nơi áp quy ước chuỗi.
-- -----------------------------------------------------------------------------
create or replace function public.expand_daily_recruitment_breakdown_v02(p_breakdown jsonb)
returns table (
  business_date           date,
  project_key             text,
  project_display         text,
  recruiter_key           text,
  recruiter_display       text,
  provider_type_key       text,
  provider_type_display   text,
  employment_type_key     text,
  employment_type_display text,
  recruited_count         integer
)
language sql
immutable
set search_path = ''
as $function$
  select
    (e.value ->> 'business_date')::date,
    coalesce(public.recruitment_dimension_key(e.value ->> 'project'), '__unknown__'),
    coalesce(public.recruitment_dimension_display(e.value ->> 'project'), 'Không xác định'),
    coalesce(public.recruitment_dimension_key(e.value ->> 'recruiter'), '__unknown__'),
    coalesce(public.recruitment_dimension_display(e.value ->> 'recruiter'), 'Không xác định'),
    coalesce(public.recruitment_dimension_key(e.value ->> 'provider_type'), '__unknown__'),
    coalesce(public.recruitment_dimension_display(e.value ->> 'provider_type'), 'Không xác định'),
    coalesce(public.recruitment_dimension_key(e.value ->> 'employment_type'), '__unknown__'),
    coalesce(public.recruitment_dimension_display(e.value ->> 'employment_type'), 'Không xác định'),
    (e.value ->> 'recruited_count')::integer
  from jsonb_array_elements(coalesce(p_breakdown, '[]'::jsonb)) as e(value);
$function$;

comment on function public.expand_daily_recruitment_breakdown_v02(jsonb) is
  'Nội bộ. Chuẩn hóa breakdown payload thành dòng grain; thiếu/rỗng => __unknown__ / "Không xác định".';

-- -----------------------------------------------------------------------------
-- Helper: ghi nhận từ chối (giữ nguyên snapshot) và trả response thống nhất.
-- -----------------------------------------------------------------------------
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
    select id into v_source_id
      from public.data_sources
     where drive_file_id = p_drive_file_id;
  end if;

  if v_source_id is not null
     and p_run_id is not null
     and p_trigger_type in ('manual', 'schedule', 'bot') then
    <<logfail>>
    begin
      perform public.upsert_daily_recruitment_run_v01(
        p_run_id, v_source_id, p_trigger_type, p_snapshot_at, 'failed',
        coalesce(p_rows_read, 0), coalesce(p_rows_valid, 0), coalesce(p_rows_rejected, 0),
        p_error_code, left(v_reason, 500)
      );

      insert into public.sync_errors (run_id, source_id, source_row_number, error_code, sanitized_reason)
      values (p_run_id, v_source_id, null, p_error_code, left(v_reason, 500));

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
    'run_logged',             v_logged,
    'error_code',             p_error_code,
    'sanitized_reason',       left(v_reason, 500)
  );
end;
$function$;

comment on function public.reject_daily_recruitment_breakdown_snapshot_v02(text, uuid, text, timestamptz, integer, integer, integer, text, text) is
  'Nội bộ. Ghi sync_runs/sync_errors cho payload bị từ chối; KHÔNG thay đổi aggregate.';

-- -----------------------------------------------------------------------------
-- RPC chính
-- -----------------------------------------------------------------------------
create or replace function public.replace_daily_recruitment_breakdown_snapshot_v02(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  c_contract_version  constant text   := 'daily-recruitment-breakdown/0.2';
  c_timezone          constant text   := 'Asia/Ho_Chi_Minh';
  c_unknown_key       constant text   := '__unknown__';
  c_unknown_display   constant text   := 'Không xác định';
  c_payload_keys      constant text[] := array[
    'contract_version', 'drive_file_id', 'file_name', 'sheet_name', 'sync_run_id',
    'trigger_type', 'snapshot_at', 'timezone', 'rows_read', 'rows_valid',
    'rows_rejected', 'breakdown'
  ];
  c_breakdown_keys    constant text[] := array[
    'business_date', 'project', 'recruiter', 'provider_type', 'employment_type', 'recruited_count'
  ];
  c_dimension_keys    constant text[] := array['project', 'recruiter', 'provider_type', 'employment_type'];
  c_trigger_types     constant text[] := array['manual', 'schedule', 'bot'];
  c_iso_date          constant text   := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  c_uint              constant text   := '^[0-9]{1,9}$';
  c_timestamp_with_tz constant text   := '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?([Zz]|[+-][0-9]{2}:?[0-9]{2})$';
  c_safe_field_name   constant text   := '^[A-Za-z0-9_]{1,64}$';
  c_max_dimension_len constant integer := 200;

  v_error_code        text := null;
  v_error_reason      text := null;

  v_key               text;
  v_drive_file_id     text;
  v_file_name         text;
  v_sheet_name        text;
  v_sync_run_id       uuid := null;
  v_trigger_type      text;
  v_snapshot_at       timestamptz := null;
  v_timezone          text;
  v_rows_read         integer;
  v_rows_valid        integer;
  v_rows_rejected     integer;
  v_breakdown         jsonb;

  v_source_id         uuid := null;
  v_run_source_id     uuid := null;
  v_element           jsonb;
  v_business_date     date := null;
  v_count             integer;
  v_dimension         text;
  v_sum               bigint := 0;
  v_seen_grains       text[] := array[]::text[];
  v_grain_key         text;
  v_incoming          jsonb;
  v_current           jsonb;
  v_outcome           text;
  v_status            text;
  v_removed           integer := 0;
  v_current_rows      integer := 0;
  v_current_total     bigint := 0;
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

    -- Trích xuất định danh trước để mọi từ chối sau đây vẫn ghi được run/source.
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

    if jsonb_typeof(p_payload->'breakdown') <> 'array' then
      v_error_code := 'INVALID_BREAKDOWN';
      v_error_reason := 'breakdown phải là array';
      exit validate;
    end if;
    v_breakdown := p_payload->'breakdown';

    for v_element in select jsonb_array_elements(v_breakdown) loop
      if jsonb_typeof(v_element) <> 'object' then
        v_error_code := 'INVALID_BREAKDOWN';
        v_error_reason := 'phần tử breakdown phải là object';
        exit validate;
      end if;

      for v_key in select jsonb_object_keys(v_element) loop
        if not (v_key = any (c_breakdown_keys)) then
          v_error_code := 'UNKNOWN_FIELD';
          v_error_reason := 'breakdown chứa field ngoài contract';
          exit validate;
        end if;
      end loop;

      if not (v_element ? 'business_date') or not (v_element ? 'recruited_count') then
        v_error_code := 'INVALID_BREAKDOWN';
        v_error_reason := 'breakdown thiếu business_date hoặc recruited_count';
        exit validate;
      end if;

      -- Bốn chiều phân loại: được phép thiếu/null (=> "Không xác định"),
      -- nhưng nếu có giá trị thì phải là string trong giới hạn độ dài.
      foreach v_key in array c_dimension_keys loop
        if (v_element ? v_key) and jsonb_typeof(v_element->v_key) not in ('string', 'null') then
          v_error_code := 'INVALID_DIMENSION';
          v_error_reason := 'trường phân loại ' || v_key || ' phải là chuỗi hoặc null';
          exit validate;
        end if;
        if char_length(v_element->>v_key) > c_max_dimension_len then
          v_error_code := 'INVALID_DIMENSION';
          v_error_reason := 'trường phân loại ' || v_key || ' vượt quá ' || c_max_dimension_len || ' ký tự';
          exit validate;
        end if;
      end loop;

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

      -- Khóa grain sau chuẩn hóa: cùng khóa xuất hiện hai lần => từ chối toàn bộ.
      v_grain_key := to_char(v_business_date, 'YYYY-MM-DD')
        || '|' || coalesce(public.recruitment_dimension_key(v_element->>'project'), c_unknown_key)
        || '|' || coalesce(public.recruitment_dimension_key(v_element->>'recruiter'), c_unknown_key)
        || '|' || coalesce(public.recruitment_dimension_key(v_element->>'provider_type'), c_unknown_key)
        || '|' || coalesce(public.recruitment_dimension_key(v_element->>'employment_type'), c_unknown_key);

      if v_grain_key = any (v_seen_grains) then
        v_error_code := 'DUPLICATE_GRAIN_KEY';
        v_error_reason := 'cùng một tổ hợp (ngày, dự án, người tuyển, HRP/Vendor, loại hình) xuất hiện nhiều lần';
        exit validate;
      end if;
      v_seen_grains := v_seen_grains || v_grain_key;

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
    return public.reject_daily_recruitment_breakdown_snapshot_v02(
      v_drive_file_id, v_sync_run_id, v_trigger_type, v_snapshot_at,
      v_rows_read, v_rows_valid, v_rows_rejected, v_error_code, v_error_reason
    );
  end if;

  -- ===========================================================================
  -- PHASE 2 — Ghi dữ liệu (một transaction; lỗi => rollback toàn bộ block này,
  --            snapshot thành công gần nhất được giữ nguyên)
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
               to_jsonb(r)
               order by r.business_date, r.project_key, r.recruiter_key,
                        r.provider_type_key, r.employment_type_key
             ),
             '[]'::jsonb
           )
      into v_incoming
      from public.expand_daily_recruitment_breakdown_v02(v_breakdown) r;

    select coalesce(
             jsonb_agg(
               to_jsonb(c)
               order by c.business_date, c.project_key, c.recruiter_key,
                        c.provider_type_key, c.employment_type_key
             ),
             '[]'::jsonb
           )
      into v_current
      from (
        select business_date, project_key, project_display, recruiter_key, recruiter_display,
               provider_type_key, provider_type_display, employment_type_key,
               employment_type_display, recruited_count
          from public.daily_recruitment_breakdown
         where source_id = v_source_id
      ) c;

    if v_incoming = v_current then
      v_outcome := 'unchanged';
      v_removed := 0;
    else
      -- Chỉ xóa đúng những tổ hợp không còn trong snapshot mới; giữ created_at
      -- của những tổ hợp không đổi.
      with incoming as (
        select * from public.expand_daily_recruitment_breakdown_v02(v_breakdown)
      )
      delete from public.daily_recruitment_breakdown c
       where c.source_id = v_source_id
         and not exists (
               select 1
                 from incoming i
                where i.business_date = c.business_date
                  and i.project_key = c.project_key
                  and i.recruiter_key = c.recruiter_key
                  and i.provider_type_key = c.provider_type_key
                  and i.employment_type_key = c.employment_type_key
             );
      get diagnostics v_removed = row_count;

      insert into public.daily_recruitment_breakdown (
        source_id, business_date, project_key, project_display,
        recruiter_key, recruiter_display, provider_type_key, provider_type_display,
        employment_type_key, employment_type_display, recruited_count,
        sync_run_id, snapshot_at
      )
      select v_source_id, i.business_date, i.project_key, i.project_display,
             i.recruiter_key, i.recruiter_display, i.provider_type_key, i.provider_type_display,
             i.employment_type_key, i.employment_type_display, i.recruited_count,
             v_sync_run_id, v_snapshot_at
        from public.expand_daily_recruitment_breakdown_v02(v_breakdown) i
      on conflict (source_id, business_date, project_key, recruiter_key, provider_type_key, employment_type_key)
      do update
        set recruited_count         = excluded.recruited_count,
            project_display         = excluded.project_display,
            recruiter_display       = excluded.recruiter_display,
            provider_type_display   = excluded.provider_type_display,
            employment_type_display = excluded.employment_type_display,
            sync_run_id             = excluded.sync_run_id,
            snapshot_at             = excluded.snapshot_at;

      v_outcome := 'applied';
    end if;

    if v_status = 'succeeded' then
      update public.data_sources
         set last_successful_sync_at = greatest(last_successful_sync_at, v_snapshot_at)
       where id = v_source_id;
    end if;

    select count(*), coalesce(sum(recruited_count), 0)
      into v_current_rows, v_current_total
      from public.daily_recruitment_breakdown
     where source_id = v_source_id;
  exception when others then
    if v_error_code is null then
      v_error_code := 'DB_WRITE_FAILED';
      v_error_reason := left(sqlstate || ': ' || sqlerrm, 500);
    end if;
  end write;

  if v_error_code is not null then
    return public.reject_daily_recruitment_breakdown_snapshot_v02(
      v_drive_file_id, v_sync_run_id, v_trigger_type, v_snapshot_at,
      v_rows_read, v_rows_valid, v_rows_rejected, v_error_code, v_error_reason
    );
  end if;

  return jsonb_build_object(
    'outcome',                v_outcome,
    'contract_version',       c_contract_version,
    'source_id',              v_source_id,
    'sync_run_id',            v_sync_run_id,
    'run_status',             v_status,
    'breakdown_rows_current', v_current_rows,
    'breakdown_rows_removed', v_removed,
    'recruited_count_total',  v_current_total,
    'run_logged',             true,
    'error_code',             null,
    'sanitized_reason',       null
  );
end;
$function$;

comment on function public.replace_daily_recruitment_breakdown_snapshot_v02(jsonb) is
  'Contract daily-recruitment-breakdown/0.2. Thay thế toàn bộ aggregate của một source theo drive_file_id.';

-- -----------------------------------------------------------------------------
-- Quyền: chỉ service_role.
-- -----------------------------------------------------------------------------
revoke all on function public.recruitment_dimension_display(text) from public, anon, authenticated;
revoke all on function public.recruitment_dimension_key(text) from public, anon, authenticated;
revoke all on function public.expand_daily_recruitment_breakdown_v02(jsonb) from public, anon, authenticated;
revoke all on function public.reject_daily_recruitment_breakdown_snapshot_v02(text, uuid, text, timestamptz, integer, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.replace_daily_recruitment_breakdown_snapshot_v02(jsonb) from public, anon, authenticated;

grant execute on function public.recruitment_dimension_display(text) to service_role;
grant execute on function public.recruitment_dimension_key(text) to service_role;
grant execute on function public.expand_daily_recruitment_breakdown_v02(jsonb) to service_role;
grant execute on function public.reject_daily_recruitment_breakdown_snapshot_v02(text, uuid, text, timestamptz, integer, integer, integer, text, text) to service_role;
grant execute on function public.replace_daily_recruitment_breakdown_snapshot_v02(jsonb) to service_role;
