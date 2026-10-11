-- =============================================================================
-- P3.1-W02C-R3 - authoritative labor-type display for the Own Draft projection.
--
-- Blocker: after #80 the Worker Directory, the entry baseline and the Change
-- Request read surfaces all carry a server-resolved `labor_type_display`, but
-- the Direct Entry grid loads its PERSISTED DRAFT through
-- `direct_entry_list_own_drafts`, whose payload still shipped only the raw
-- `labor_type` key. A draft that stores a since-deactivated type therefore
-- made the client fall back to rendering the raw key, which is exactly what a
-- dynamic catalog forbids - the type is deliberately absent from
-- direct_entry_labor_type_options(), so the key is not a choosable value any
-- more and must never be shown as if it were one.
--
-- This migration adds the same display-only companion field,
-- `labor_type_display`, to every draft of that one RPC, resolved from
-- public.direct_entry_labor_types BY KEY with NO active filter, so an inactive
-- type still renders its authoritative current label.
--
-- It also bumps the wire envelope to `direct-entry-draft-list/2`. The field is
-- required by the strict client contract, so a client build that still expects
-- the /1 shape must refuse the payload instead of silently rendering a draft
-- without a label; the version is how it tells the two shapes apart.
--
-- Nothing else changes: authority, the own-draft scope resolver, the 500-row
-- bound, the existing keys, the profile redaction, RLS, every grant and the
-- whole write path are untouched.
--
-- Bodies are patched IN PLACE from their LIVE definitions via
-- pg_get_functiondef, never re-emitted from an original source: re-emitting
-- silently reverts every later migration that patched the same body. Source
-- drift aborts the whole transaction with 55000.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Patch helper. Same shape as the #79 and #80 helpers, both of which are dropped
-- at the end of their own migration, so this one is new rather than reused.
-- -----------------------------------------------------------------------------

create function public.direct_entry_w02c_r3_replace_proc_source(
  p_signature regprocedure,
  p_expected text,
  p_replacement text,
  p_expected_count integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $r3$
declare
  v_definition text;
  v_count integer;
begin
  select pg_get_functiondef(p_signature) into v_definition;
  if v_definition is null or p_expected is null or p_expected = '' then
    raise exception 'own draft display source missing' using errcode = '55000';
  end if;
  v_count := (length(v_definition) - length(replace(v_definition, p_expected, '')))
    / length(p_expected);
  if v_count <> p_expected_count then
    raise exception 'own draft display source drift for %: expected %, found %',
      p_signature, p_expected_count, v_count using errcode = '55000';
  end if;
  execute replace(v_definition, p_expected, p_replacement);
end;
$r3$;
revoke all on function public.direct_entry_w02c_r3_replace_proc_source(regprocedure, text, text, integer)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1. direct_entry_list_own_drafts -> every draft row.
--
--    A scalar subquery is used instead of a join so the row set, the ordering,
--    the 500-row bound, the scope resolver and the redaction branches are all
--    untouched. The key stays exactly where it was; the label is added beside
--    it, never instead of it.
-- -----------------------------------------------------------------------------

select public.direct_entry_w02c_r3_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  '      ''labor_type'', e.labor_type,',
  '      ''labor_type'', e.labor_type,
      ''labor_type_display'', (select lt.display_name from public.direct_entry_labor_types lt
        where lt.labor_type_key = e.labor_type),',
  1
);

-- -----------------------------------------------------------------------------
-- 2. The wire envelope moves to /2. The label is REQUIRED by the strict client
--    contract, so the version is what stops an older client from accepting a
--    payload whose drafts it would render without a label.
-- -----------------------------------------------------------------------------

select public.direct_entry_w02c_r3_replace_proc_source(
  'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure,
  '    ''projection_version'', ''direct-entry-draft-list/1'',',
  '    ''projection_version'', ''direct-entry-draft-list/2'',',
  1
);

drop function public.direct_entry_w02c_r3_replace_proc_source(regprocedure, text, text, integer);
-- -----------------------------------------------------------------------------
-- Self-check. Every assertion below is a property of the LIVE bodies, so this
-- migration can never land half-applied. All FOUR read surfaces that render a
-- stored labor type are covered here, not just the one this migration patches:
-- the R2 surfaces are re-proved so a later migration cannot quietly undo them.
-- -----------------------------------------------------------------------------

do $check$
declare
  v_rec record;
  v_options text;
  v_drafts text;
begin
  for v_rec in
    select p.proname as name, pg_get_functiondef(p.oid) as body
      from pg_proc p
     where p.oid in (
       'public.direct_entry_list_workers(uuid,uuid,text,text,uuid,text,text,integer)'::regprocedure,
       'public.direct_entry_read_projection(uuid,uuid,uuid)'::regprocedure,
       'public.direct_entry_read_change_request(uuid,uuid,uuid)'::regprocedure,
       'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure
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
    -- to render its label for a draft that already stores it.
    if v_rec.body like '%lt.active%' or v_rec.body like '%t.active%' then
      raise exception 'read surface % filters the display lookup by active', v_rec.name
        using errcode = '55000';
    end if;
    if v_rec.body like '%Không xác định%' then
      raise exception 'read surface % carries a fallback label', v_rec.name
        using errcode = '55000';
    end if;
  end loop;

  -- The own-draft envelope must advertise exactly the new shape: /2 present and
  -- /1 gone. A body carrying both would let a client pick whichever it prefers.
  select pg_get_functiondef(
    'public.direct_entry_list_own_drafts(uuid,uuid)'::regprocedure) into v_drafts;
  if v_drafts is null or v_drafts not like '%''direct-entry-draft-list/2''%' then
    raise exception 'the own-draft list does not advertise projection version 2'
      using errcode = '55000';
  end if;
  if v_drafts like '%''direct-entry-draft-list/1''%' then
    raise exception 'the own-draft list still advertises the superseded projection version'
      using errcode = '55000';
  end if;

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
