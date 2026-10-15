-- PRE-W2 worker export repair: preserve date strings and include CCCD issue date.
-- Append-only patch of the existing scoped export RPC; no business data is modified.
begin;

do $migration$
declare
  v_signature regprocedure :=
    'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)'::regprocedure;
  v_definition text;
  v_old text := '''phone'', case';
  v_new text := '''national_id_issued_at'', case
               when b.worker_details->''national_id_issued_at''->>''state'' = ''provided''
               then b.worker_details->''national_id_issued_at''->>''value'' else null end,
             ''phone'', case';
  v_updated text;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if v_definition is null
     or length(v_definition) - length(replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'PRE-W2 export patch expected exactly one phone projection marker';
  end if;

  v_updated := replace(v_definition, v_old, v_new);
  execute v_updated;

  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position('national_id_issued_at' in v_definition) = 0
     or position('direct_entry_worker_directory_audience' in v_definition) = 0
     or position('EXPORT_ROW_LIMIT_EXCEEDED' in v_definition) = 0 then
    raise exception 'PRE-W2 export patch postcondition failed';
  end if;
end;
$migration$;

commit;
