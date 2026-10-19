-- Return filter-scoped totals from the same authorized worker-directory query.
begin;

do $patch_worker_directory_summary$
declare
  v_signature regprocedure :=
    'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure;
  v_definition text;
  v_replaced text;
  v_declare_old constant text := $old$  v_items jsonb;
  v_next_cursor text;$old$;
  v_declare_new constant text := $new$  v_items jsonb;
  v_next_cursor text;
  v_summary jsonb;$new$;
  v_cursor_old constant text := $old$       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(e.first_work_date, 'YYYYMMDD'),
              e.entry_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.first_work_date, 'YYYYMMDD') || ':' || c.entry_id::text as cursor
      from candidates c
     order by c.first_work_date desc, c.entry_id desc
     limit v_page_size + 1$old$;
  v_cursor_new constant text := $new$  ),
  summary as (
    select count(*)::bigint as total_workers,
           count(distinct project_id)::bigint as project_count,
           count(distinct recruiter_id)::bigint as recruiter_count
      from candidates
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.first_work_date, 'YYYYMMDD') || ':' || c.entry_id::text as cursor
      from candidates c
     where v_cursor_stamp is null
        or (
             pg_catalog.to_char(c.first_work_date, 'YYYYMMDD'),
             c.entry_id::text
           ) < (v_cursor_stamp, v_cursor_id::text)
     order by c.first_work_date desc, c.entry_id desc
     limit v_page_size + 1$new$;
  v_select_old constant text := $old$    (
      select t.cursor from trimmed t
       order by t.first_work_date asc, t.entry_id asc
       limit 1
    )
  into v_scanned, v_items, v_next_cursor;$old$;
  v_select_new constant text := $new$    (
      select t.cursor from trimmed t
       order by t.first_work_date asc, t.entry_id asc
       limit 1
    ),
    (
      select jsonb_build_object(
        'total_workers', s.total_workers,
        'project_count', s.project_count,
        'recruiter_count', s.recruiter_count
      ) from summary s
    )
  into v_scanned, v_items, v_next_cursor, v_summary;$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('''summary'', v_summary' in v_definition) > 0 then
    if position('count(distinct project_id)' in v_definition) = 0
       or position('e.voided_at is null' in v_definition) = 0 then
      raise exception 'worker directory summary contract drift' using errcode = '55000';
    end if;
    return;
  end if;
  if position('e.voided_at is null' in v_definition) = 0
     or length(v_definition) - length(replace(v_definition, v_declare_old, '')) <> length(v_declare_old)
     or length(v_definition) - length(replace(v_definition, v_cursor_old, '')) <> length(v_cursor_old)
     or length(v_definition) - length(replace(v_definition, v_select_old, '')) <> length(v_select_old) then
    raise exception 'worker directory summary source drift' using errcode = '55000';
  end if;

  v_replaced := replace(v_definition, v_declare_old, v_declare_new);
  v_replaced := replace(v_replaced, v_cursor_old, v_cursor_new);
  v_replaced := replace(v_replaced, v_select_old, v_select_new);
  v_replaced := replace(
    v_replaced,
    $old$    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end,
    'authorization_date',$old$,
    $new$    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end,
    'summary', v_summary,
    'authorization_date',$new$
  );
  if v_replaced = v_definition
     or position('v_summary jsonb' in v_replaced) = 0
     or position('count(distinct project_id)' in v_replaced) = 0
     or position('count(distinct recruiter_id)' in v_replaced) = 0
     or position('''summary'', v_summary' in v_replaced) = 0 then
    raise exception 'worker directory summary patch failed' using errcode = '55000';
  end if;
  execute v_replaced;

  select pg_get_functiondef(v_signature) into v_definition;
  if position('e.voided_at is null' in v_definition) = 0
     or position('count(distinct project_id)' in v_definition) = 0
     or position('count(distinct recruiter_id)' in v_definition) = 0
     or position('''summary'', v_summary' in v_definition) = 0 then
    raise exception 'worker directory summary install check failed' using errcode = '55000';
  end if;
end;
$patch_worker_directory_summary$;

commit;
