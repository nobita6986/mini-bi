-- =============================================================================
-- HF: duplicate-CCCD report also detects "Đang chờ việc" (UNCONFIRMED).
--
-- Chỉ thay đổi TIÊU CHÍ PHÁT HIỆN của báo cáo trùng CCCD:
--   * một nhóm cùng CCCD xuất hiện khi có >= 2 episode trong tập {ON, UNCONFIRMED};
--   * ON và UNCONFIRMED đều được xem là "đã được bố trí" cho mục đích phát hiện trùng;
--   * mỗi episode vẫn hiển thị đúng trạng thái thật (UNCONFIRMED không bị gán thành ON);
--   * active_profile_count và cờ `active` VẪN chỉ tính episode ON.
--
-- KHÔNG đổi ý nghĩa UNCONFIRMED trong workforce analytics, không đổi quy tắc doanh số,
-- không rút trùng/void, không đổi trạng thái hồ sơ. Giữ nguyên quyền truy cập, bộ lọc,
-- phân trang, các thao tác trên từng dòng, che CCCD, chữ ký, owner và ACL của RPC.
-- =============================================================================
begin;

create function public.direct_entry_hf_unconfirmed_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_source text; v_definition text;
  v_expected text := p_expected; v_replacement text := p_replacement;
  v_next text; v_count integer;
begin
  if p_expected is null or length(p_expected) = 0 or p_expected_count < 1 then
    raise exception 'HF unconfirmed invalid source patch specification';
  end if;
  select replace(p.prosrc, chr(13), '') into v_source from pg_proc p where p.oid = p_signature;
  if v_source is null then
    raise exception 'HF unconfirmed source function not found: %', p_signature;
  end if;
  v_expected := replace(p_expected, chr(13), '');
  v_replacement := replace(p_replacement, chr(13), '');
  v_count := (length(v_source) - length(replace(v_source, v_expected, ''))) / length(v_expected);
  if v_count <> p_expected_count then
    raise exception 'HF unconfirmed expected % exact source fragment(s), found % in %, starting with: %',
      p_expected_count, v_count, p_signature, left(v_expected, 96);
  end if;
  v_next := replace(v_source, v_expected, v_replacement);
  select replace(pg_get_functiondef(p.oid), chr(13), '') into v_definition
    from pg_proc p where p.oid = p_signature;
  if length(v_definition) - length(replace(v_definition, v_source, '')) <> length(v_source) then
    raise exception 'HF unconfirmed could not reconstruct function definition: %', p_signature;
  end if;
  execute replace(v_definition, v_source, v_next);
end;
$$;

revoke all on function public.direct_entry_hf_unconfirmed_replace_proc_source(
  regprocedure, text, text, integer
) from public, anon, authenticated, service_role;

-- The `live` set becomes {ON, UNCONFIRMED}; everything downstream stays byte-stable.
select public.direct_entry_hf_unconfirmed_replace_proc_source(
  'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure,
  $old$
     where public.direct_entry_is_canonical_national_id(c.cccd)
       and coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') = 'ON'$old$,
  $new$
     where public.direct_entry_is_canonical_national_id(c.cccd)
       and coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') in ('ON','UNCONFIRMED')$new$,
  1
);

drop function public.direct_entry_hf_unconfirmed_replace_proc_source(regprocedure,text,text,integer);

-- -----------------------------------------------------------------------------
-- Install-time self-check (data free).
-- -----------------------------------------------------------------------------
do $check$
declare
  v_source text;
begin
  select replace(p.prosrc, chr(13), '') into v_source
    from pg_proc p
   where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure;
  if v_source is null then
    raise exception 'HF unconfirmed duplicate report function missing';
  end if;

  -- The `live` set includes both ON and UNCONFIRMED.
  if position('in (' || chr(39) || 'ON' || chr(39) || ',' || chr(39) || 'UNCONFIRMED' || chr(39) || ')' in v_source) = 0 then
    raise exception 'HF unconfirmed duplicate report lost the {ON, UNCONFIRMED} predicate';
  end if;
  -- The old ON-only live predicate must be gone.
  if position(') = ' || chr(39) || 'ON' || chr(39) in v_source) > 0 then
    raise exception 'HF unconfirmed duplicate report still has the ON-only live predicate';
  end if;
  -- `active` and active_profile_count still follow ON, never UNCONFIRMED.
  if position('l.latest_status = ' || chr(39) || 'ON' || chr(39) in v_source) = 0 then
    raise exception 'HF unconfirmed duplicate report lost the ON active flag';
  end if;
  if position('active_profile_count' in v_source) = 0 then
    raise exception 'HF unconfirmed duplicate report lost active_profile_count';
  end if;
  -- Still masked, still read-only, still bounded.
  if position('cccd_last4' in v_source) = 0 or position('right(' in v_source) = 0 then
    raise exception 'HF unconfirmed duplicate report no longer masks the CCCD';
  end if;
  if v_source ~* '(insert into|update public|delete from|for update|advisory_xact_lock|truncate)' then
    raise exception 'HF unconfirmed duplicate report is not read-only';
  end if;
  if position('duplicate_report_page_size_invalid' in v_source) = 0
     or position('duplicate_report_page_invalid' in v_source) = 0 then
    raise exception 'HF unconfirmed duplicate report is not bounded';
  end if;
  -- Security boundary unchanged.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig @> array['search_path=pg_catalog, public']
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not exists (
         select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
       )
  ) then
    raise exception 'HF unconfirmed duplicate report security boundary changed';
  end if;

  raise notice 'HF unconfirmed duplicate-CCCD detection migration self-check OK';
end;
$check$;

commit;
