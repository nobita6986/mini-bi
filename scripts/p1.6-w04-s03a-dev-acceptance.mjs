import assert from "node:assert/strict";
import process from "node:process";
import pg from "pg";

import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

const fixture = {
  authSubject: "91000000-0000-4000-8000-000000000001",
  unknownAuthSubject: "91000000-0000-4000-8000-000000000002",
  appUserId: "92000000-0000-4000-8000-000000000001",
  recruiterId: "93000000-0000-4000-8000-000000000001",
  teamId: "94000000-0000-4000-8000-000000000001",
  capabilityGrantId: "95000000-0000-4000-8000-000000000001",
  teamScopeGrantId: "96000000-0000-4000-8000-000000000001",
  allScopeGrantId: "96000000-0000-4000-8000-000000000002",
  recruiterLinkId: "97000000-0000-4000-8000-000000000001",
};

async function reportingBaseline(client) {
  const { rows } = await client.query(`
    select
      (select count(*) from public.data_sources where active and not is_test)::int
        as "reportingSources",
      (select count(*) from public.data_sources where is_test)::int
        as "existingFixtureSources",
      (select coalesce(sum(b.recruited_count), 0)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::bigint as "recruitedTotal",
      (select count(*)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as "breakdownRows",
      (select count(distinct b.business_date)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as "breakdownDateBuckets",
      (select count(distinct b.project_key)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as projects,
      (select count(distinct b.recruiter_key)
         from public.daily_recruitment_breakdown b
         join public.data_sources s on s.id = b.source_id
        where s.active and not s.is_test)::int as recruiters
  `);
  return rows[0];
}

async function seedFixture(client) {
  await client.query("insert into auth.users (id) values ($1)", [fixture.authSubject]);
  await client.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name) values ($1, $2, 'Synthetic Account')",
    [fixture.appUserId, fixture.authSubject],
  );
  await client.query(
    "insert into public.teams (team_id, code, display_name) values ($1, $2, $3)",
    [fixture.teamId, "S03A-SYNTH", "Synthetic team S03A"],
  );
  await client.query(
    `insert into public.recruiters (recruiter_id, display_name)
     values ($1, $2)`,
    [fixture.recruiterId, "Synthetic recruiter S03A"],
  );
  await client.query(
    `insert into public.direct_entry_capability_grants
       (grant_id, app_user_id, capability, valid_from)
     values ($1, $2, 'entry_create', public.direct_entry_authorization_date() - 1)`,
    [fixture.capabilityGrantId, fixture.appUserId],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants
       (grant_id, app_user_id, scope_kind, team_id, valid_from)
     values ($1, $2, 'team', $3, public.direct_entry_authorization_date() - 1)`,
    [fixture.teamScopeGrantId, fixture.appUserId, fixture.teamId],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants
       (grant_id, app_user_id, scope_kind, valid_from)
     values ($1, $2, 'all', public.direct_entry_authorization_date() - 1)`,
    [fixture.allScopeGrantId, fixture.appUserId],
  );
  await client.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (link_id, app_user_id, recruiter_id, verified, valid_from)
     values ($1, $2, $3, true, public.direct_entry_authorization_date() - 1)`,
    [fixture.recruiterLinkId, fixture.appUserId, fixture.recruiterId],
  );
}

async function fixtureCounts(client) {
  const { rows } = await client.query(`
    select
      (select count(*) from auth.users where id = $1)::int as auth_users,
      (select count(*) from public.direct_entry_app_users where app_user_id = $2)::int as app_users,
      (select count(*) from public.recruiters where recruiter_id = $3)::int as recruiters,
      (select count(*) from public.teams where team_id = $4)::int as teams,
      (select count(*) from public.direct_entry_capability_grants where grant_id = $5)::int as capabilities,
      (select count(*) from public.direct_entry_scope_grants where grant_id in ($6, $7))::int as scopes,
      (select count(*) from public.direct_entry_app_user_recruiter_links where link_id = $8)::int as recruiter_links
  `, [
    fixture.authSubject, fixture.appUserId, fixture.recruiterId, fixture.teamId,
    fixture.capabilityGrantId, fixture.teamScopeGrantId, fixture.allScopeGrantId,
    fixture.recruiterLinkId,
  ]);
  return rows[0];
}

async function main() {
  const { databaseUrl } = await loadSupabaseConfig();
  const client = new pg.Client({ connectionString: databaseUrl, ssl: buildSslOptions() });
  await client.connect();
  let transactionOpen = false;
  try {
    const before = await reportingBaseline(client);
    await client.query("begin");
    transactionOpen = true;
    await seedFixture(client);

    await client.query("set local role service_role");
    const { rows: resultRows } = await client.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as context",
      [fixture.authSubject],
    );
    const context = resultRows[0].context;
    assert.equal(context.app_user_id, fixture.appUserId);
    assert.deepEqual(context.capabilities, ["entry_create"]);
    assert.equal(context.team_scope_grants[0].team_id, fixture.teamId);
    assert.equal(context.recruiter_links[0].recruiter_id, fixture.recruiterId);

    const actorResult = await resolveActor({
      session: {
        auth_subject: fixture.authSubject,
        provider: "supabase",
        authenticated_at: null,
      },
      repository: { loadByAuthSubject: async () => context },
      at: new Date().toISOString(),
    });
    assert.equal(actorResult.ok, true);
    if (!actorResult.ok) throw new Error("Synthetic actor did not resolve");
    assert.equal(actorResult.actor.app_user_id, fixture.appUserId);
    assert.deepEqual(actorResult.actor.capabilities, ["entry_create"]);
    assert.equal(actorResult.actor.scopes.some((scope) => scope.reference === fixture.teamId), true);
    assert.equal(actorResult.actor.self_recruiter_suggestion, fixture.recruiterId);

    const unknown = await client.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as context",
      [fixture.unknownAuthSubject],
    );
    assert.equal(unknown.rows[0].context, null);

    const { rows: grants } = await client.query(`
      select
        has_function_privilege('service_role',
          'public.direct_entry_resolve_actor_context(uuid)', 'execute') as service_execute,
        has_function_privilege('anon',
          'public.direct_entry_resolve_actor_context(uuid)', 'execute') as anon_execute,
        has_function_privilege('authenticated',
          'public.direct_entry_resolve_actor_context(uuid)', 'execute') as authenticated_execute,
        has_table_privilege('service_role',
          'public.direct_entry_app_users', 'select') as service_table_select
    `);
    assert.deepEqual(grants[0], {
      service_execute: true,
      anon_execute: false,
      authenticated_execute: false,
      service_table_select: false,
    });
    const { rows: rpcCounts } = await client.query(`
      select count(*)::int as count
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'direct_entry_%'
         and has_function_privilege('service_role', p.oid, 'execute')
    `);
    assert.equal(rpcCounts[0].count, 18);

    await client.query("rollback");
    transactionOpen = false;
    const after = await reportingBaseline(client);
    assert.deepEqual(after, before);
    const remaining = await fixtureCounts(client);
    assert.deepEqual(remaining, {
      auth_users: 0,
      app_users: 0,
      recruiters: 0,
      teams: 0,
      capabilities: 0,
      scopes: 0,
      recruiter_links: 0,
    });
    console.log(JSON.stringify({
      result: "PASS",
      rpc: "direct_entry_resolve_actor_context",
      p1_6ServiceRpcCount: rpcCounts[0].count,
      reportingBaseline: before,
      baselineUnchanged: true,
      cleanupVerified: true,
      fixtureIds: fixture,
      remainingFixtureRows: remaining,
    }, null, 2));
  } finally {
    if (transactionOpen) await client.query("rollback").catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(`S03A DEV acceptance failed (${error.code ?? error.name ?? "unknown"}); transaction rollback was attempted.`);
  process.exitCode = 1;
});
