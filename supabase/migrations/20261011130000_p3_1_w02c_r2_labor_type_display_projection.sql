-- =============================================================================
-- P3.1-W02C-R2 - authoritative labor-type display projection for Direct Entry.
--
-- Blocker: after #79 the database owns the labor-type vocabulary, but every
-- Direct Entry read surface still shipped only the RAW KEY. A client therefore
-- had to turn `labor_type` into a label itself, which means a static map plus a
-- fallback for a key the build has never seen - exactly what a dynamic catalog
-- forbids. An INACTIVE labor type made it worse: it is deliberately absent from
-- direct_entry_labor_type_options(), so the client had no label source at all
-- for a stored row.
--
-- This migration adds ONE display-only companion field, `labor_type_display`,
-- next to the `labor_type` key on the three read surfaces that render a STORED
-- labor type:
--   * direct_entry_list_workers         -> Worker Directory rows
--   * direct_entry_read_projection      -> Direct Entry / privileged edit baseline
--   * direct_entry_read_change_request  -> Change Request read items
--
-- Semantics, identical on all three:
--   * resolved from public.direct_entry_labor_types BY KEY and with NO `active`
--     filter, so a deactivated type still resolves to its CURRENT display_name;
--   * the display name only: never the raw key, never a client-side fallback,
--     never a 'Khong xac dinh' sentinel;
--   * an unresolvable key yields NULL, which the strict TypeScript projection
--     turns into `unavailable` instead of rendering something wrong.
--
-- direct_entry_labor_type_options() is deliberately NOT touched: it stays the
-- ACTIVE-ONLY input catalog, so an inactive labor type can never become a new
-- write choice. The write guard is likewise untouched, and nothing here changes
-- authority, capability, RLS or the granted surface.
--
-- Bodies are patched IN PLACE from their LIVE definitions via
-- pg_get_functiondef, never re-emitted from an original source: re-emitting
-- silently reverts every later migration that patched the same body. Source
-- drift aborts the whole transaction with 55000.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Patch helper. Same shape as the #79 helper, which is dropped at the end of
-- its own migration, so this one is new rather than reused.
-- -----------------------------------------------------------------------------

create function public.direct_entry_w02c_r2_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $r2$
declare
  v_definition text;
  v_count integer;
begin
  select pg_get_functiondef(p_signature) into v_definition;
  if v_definition is null or p_expected is null or p_expected = '' then
    raise exception 'labor type display source missing' using errcode = '55000';
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, p_expected, '')))
    / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'labor type display source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, p_expected, p_replacement);
end;
$r2$;
revoke all on function public.direct_entry_w02c_r2_replace_proc_source(regprocedure, text, text, integer)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1. direct_entry_list_workers -> Worker Directory rows.
--
--    The CTE carries the key, so it carries the label too; the row builder then
--    emits both. A scalar subquery is used instead of a join so the row set,
--    the ordering, the cursor and every authority filter are untouched.
-- -----------------------------------------------------------------------------

select public.direct_entry_w02c_r2_replace_proc_source(
  'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
  '           e.labor_type,',
  '           e.labor_type,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,',
  1
);

select public.direct_entry_w02c_r2_replace_proc_source(
  'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
  '               ''labor_type'', t.labor_type,',
  '               ''labor_type'', t.labor_type,
               ''labor_type_display'', t.labor_type_display,',
  1
);

-- -----------------------------------------------------------------------------
-- 2. direct_entry_read_projection -> the Direct Entry / privileged edit baseline.
-- -----------------------------------------------------------------------------

select public.direct_entry_w02c_r2_replace_proc_source(
  'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
  '    ''provider_type'', v_entry.provider_type, ''labor_type'', v_entry.labor_type,',
  '    ''provider_type'', v_entry.provider_type, ''labor_type'', v_entry.labor_type,
    ''labor_type_display'', (select lt.display_name from public.direct_entry_labor_types lt
      where lt.labor_type_key = v_entry.labor_type),',
  1
);

-- -----------------------------------------------------------------------------
-- 3. direct_entry_read_change_request -> Change Request read items.
--
--    The label is a SIBLING of `proposal`, never a member of it: the proposal
--    keeps carrying the business key in its write shape, and the display field
--    is null for every item that has no labor type.
-- -----------------------------------------------------------------------------

select public.direct_entry_w02c_r2_replace_proc_source(
  'public.direct_entry_read_change_request(uuid,uuid,uuid)'::regprocedure,
  '               ''expected_version'', i.expected_version,',
  '               ''expected_version'', i.expected_version,
               ''labor_type_display'', case
                 when i.target_kind = ''ENTRY_FIELD''
                   and nullif(i.proposal->>''labor_type'', '''') is not null
                 then (select lt.display_name from public.direct_entry_labor_types lt
                        where lt.labor_type_key = i.proposal->>''labor_type'')
                 else null end,',
  1
);

drop function public.direct_entry_w02c_r2_replace_proc_source(regprocedure, text, text, integer);
-- -----------------------------------------------------------------------------
-- Self-check. Every assertion below is a property of the LIVE bodies, so this
-- migration can never land half-applied.
-- -----------------------------------------------------------------------------

do $check$
declare
  v_rec record;
  v_options text;
begin
  for v_rec in
    select p.proname as name, pg_get_functiondef(p.oid) as body
      from pg_proc p
     where p.oid in (
       'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
       'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
       'public.direct_entry_read_change_request(uuid,uuid,uuid)'::regprocedure
     )
  loop
    if v_rec.body not like '%labor_type_display%' then
      raise exception 'read surface % does not project labor_type_display', v_rec.name
        using errcode = '55000';
    end if;
    if v_rec.body like '%''TEMPORARY''%' or v_rec.body like '%''PERMANENT''%' then
      raise exception 'read surface % carries a static labor type map', v_rec.name
        using errcode = '55000';
    end if;
    if v_rec.body not like '%from public.direct_entry_labor_types lt%' then
      raise exception 'read surface % does not resolve the catalog by key', v_rec.name
        using errcode = '55000';
    end if;
    -- The lookup must NOT be narrowed to active rows: an inactive type still has
    -- to render its label for a row that already stores it.
    if v_rec.body like '%lt.active%' or v_rec.body like '%t.active%' then
      raise exception 'read surface % filters the display lookup by active', v_rec.name
        using errcode = '55000';
    end if;
    if v_rec.body like '%Không xác định%' then
      raise exception 'read surface % carries a fallback label', v_rec.name
        using errcode = '55000';
    end if;
  end loop;

  -- The input catalog stays the ACTIVE-ONLY choosable list, with no display
  -- projection of its own: an inactive type must never become a new write choice.
  select pg_get_functiondef(
    'public.direct_entry_labor_type_options()'::regprocedure) into v_options;
  if v_options is null or v_options not like '%where t.active%' then
    raise exception 'the input catalog is no longer active-only' using errcode = '55000';
  end if;
  if v_options like '%labor_type_display%' then
    raise exception 'the input catalog leaked the display projection' using errcode = '55000';
  end if;
end;
$check$;

commit;

