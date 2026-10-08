#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

import { loadSupabaseConfig } from "./lib/load-supabase-config.mjs";
import { buildSslOptions } from "./lib/supabase-tls.mjs";

export const HRP_ACCOUNT_IDS = Object.freeze([
  "vinhnt.td", "huynq.td", "tuannh.td", "yenlh.td", "truongnd.td", "anhnh.td",
  "ngant.td", "nhieunt.td", "chivv.td", "ngocva.td", "tuocnt.td", "hungdv.td",
  "truongnv.td", "quynhntn.td", "anh1dt.td", "anh3dt.td", "thuynb.td", "hainq.td",
  "longmv.td", "tudt.td", "maynt.td", "ngannt.td", "anhhn.td", "hungnt.td",
  "linhnt.td", "vietnt.td", "khanhhv.td", "duongnt.td", "congnt.td", "namtv.td",
  "sontv.td", "truongtv.td", "trangtt.td", "vuongtq.td", "huytg.td", "lanhn.td",
  "tuanta.td", "binhnt.td", "duynd.td", "anhnn.td", "toannv.td", "quynhnn.td",
  "haond.td", "quyenht.td", "lanbt.td", "sondv.td", "maiht.td", "linhld.td",
  "haynt.td", "sampt.td", "thuandd.td", "huongnl.td",
]);

export const EXTRA_ACCOUNT_IDS = Object.freeze(["lienvu", "ngant.hr"]);
export const ACCOUNT_IDS = Object.freeze([...HRP_ACCOUNT_IDS, ...EXTRA_ACCOUNT_IDS]);

export const PROJECT_MANAGER_BY_ID = Object.freeze({
  Newwing: "sampt.td", Fushan: "sampt.td", JH: "namtv.td", ARP: "namtv.td",
  INST: "namtv.td", Innova: "namtv.td", Almus: "namtv.td", Kido: "namtv.td",
  Amo: "maynt.td", KCI: "linhnt.td", Haesung: "maynt.td", Optrontech: "vietnt.td",
  Cosonic: "vietnt.td", Shinsung: "anh1dt.td", Newface: "ngocva.td", Im: "vietnt.td",
  Dingyi: "tuocnt.td", MinhDuc: "ngocva.td", Ability: "ngocva.td", TKDT: "chivv.td",
  Dongyang: "ngocva.td", Beifa: "duongnt.td", KL: "duongnt.td", Wesum: "anhnh.td",
  Hanbo: "tuocnt.td", ISC: "ngocva.td", Solum: "hainq.td", Actro: "hainq.td",
  Segi: "hainq.td", Union: "tuocnt.td", Ohashi: "huynq.td", HPL: "huynq.td",
  Haeyoun: "huynq.td", Sungjee: "linhnt.td", SYC: "huynq.td", JFS: "toannv.td",
  Mentech: "toannv.td", Anydo: "anhnh.td", MeTran: "anhhn.td", Tanaka: "yenlh.td",
  Lens: "sampt.td", Fukang: "sampt.td", Argent: "nhieunt.td", NewProtec: "khanhhv.td",
  Techon: "hungnt.td", Heriz: "truongnd.td", Samyoung: "truongnd.td", Star: "tuannh.td",
  CDL: "tuannh.td", Minda: "anhnh.td", CNW: "ngocva.td", Vitalink: "khanhhv.td",
  Arcadyan: "anh3dt.td", Value: "anh3dt.td", Profiber: "toannv.td", Tungaloy: "toannv.td",
  Piaggio: "truongnd.td", Transon: "toannv.td", TechL: "thuynb.td", Compal: "anh1dt.td",
  Glitter: "nhieunt.td", Jahwa: "thuynb.td", Luxshare: "sampt.td", Inno: "vinhnt.td",
  Sunway: "hungnt.td", Coasia: "quynhnn.td",
});

const HRP_CAPABILITIES = Object.freeze([
  "entry_create", "entry_own", "submission_create", "change_request_create",
  "employment_status.request", "document_upload", "document_view", "payment_view",
]);
const CONFIRM = "P3_W07B_ACCESS_APPLY";
const UNASSIGNED_PROJECTS = Object.freeze(["AP", "TSCO"]);

function emailFor(accountId) {
  return `${accountId}@hrpartner.vn`;
}

async function listAuthUsers(admin) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("AUTH_LIST_FAILED");
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return users;
}

async function validateDatabase(client) {
  const projectIds = Object.keys(PROJECT_MANAGER_BY_ID);
  const personnelCodes = [...new Set(Object.values(PROJECT_MANAGER_BY_ID))];
  const projects = await client.query(
    "select project_id from public.direct_entry_projects where project_id = any($1::text[]) and active",
    [projectIds],
  );
  const unassigned = await client.query(
    "select project_id from public.direct_entry_projects where project_id = any($1::text[]) and active",
    [UNASSIGNED_PROJECTS],
  );
  const recruiters = await client.query(
    "select recruiter_id, lower(personnel_code) as personnel_code from public.recruiters" +
    " where lower(personnel_code) = any($1::text[]) and active",
    [personnelCodes],
  );
  const allHrp = await client.query(
    "select recruiter_id, lower(personnel_code) as personnel_code from public.recruiters" +
    " where lower(personnel_code) = any($1::text[]) and active",
    [[...HRP_ACCOUNT_IDS]],
  );
  if (projects.rows.length !== projectIds.length) throw new Error("PROJECT_SET_MISMATCH");
  if (unassigned.rows.length !== UNASSIGNED_PROJECTS.length) throw new Error("UNASSIGNED_PROJECT_SET_MISMATCH");
  if (recruiters.rows.length !== personnelCodes.length) throw new Error("MANAGER_SET_MISMATCH");
  if (allHrp.rows.length !== HRP_ACCOUNT_IDS.length) throw new Error("HRP_ACCOUNT_SET_MISMATCH");
  return new Map(allHrp.rows.map((row) => [row.personnel_code, row.recruiter_id]));
}

async function applyPublicMappings(client, authUsersByEmail, recruiterByCode) {
  await client.query("begin");
  try {
    const today = (await client.query(
      "select public.direct_entry_authorization_date()::text as today",
    )).rows[0].today;
    for (const accountId of ACCOUNT_IDS) {
      const authUser = authUsersByEmail.get(emailFor(accountId));
      if (!authUser) throw new Error("AUTH_USER_MISSING_AFTER_CREATE");
      const appUser = (await client.query(
        `insert into public.direct_entry_app_users(auth_subject, enabled)
         values ($1::uuid, true)
         on conflict (auth_subject) do update set enabled = true
         returning app_user_id`,
        [authUser.id],
      )).rows[0];
      for (const capability of HRP_CAPABILITIES) {
        await client.query(
          `insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from)
           select $1::uuid, $2::text, $3::date
           where not exists (
             select 1 from public.direct_entry_capability_grants g
              where g.app_user_id=$1::uuid and g.capability=$2::text
                and g.valid_from <= $3::date and (g.valid_to is null or $3::date < g.valid_to)
           )`,
          [appUser.app_user_id, capability, today],
        );
      }
      await client.query(
        `insert into public.direct_entry_scope_grants(app_user_id, scope_kind, team_id, valid_from)
         select $1::uuid, 'own', null, $2::date
         where not exists (
           select 1 from public.direct_entry_scope_grants g
            where g.app_user_id=$1::uuid and g.scope_kind='own'
              and g.valid_from <= $2::date and (g.valid_to is null or $2::date < g.valid_to)
         )`,
        [appUser.app_user_id, today],
      );
      if (recruiterByCode.has(accountId)) {
        await client.query(
          `insert into public.direct_entry_app_user_recruiter_links
             (app_user_id, recruiter_id, verified, valid_from)
           select $1::uuid, $2::uuid, true, $3::date
           where not exists (
             select 1 from public.direct_entry_app_user_recruiter_links l
              where l.app_user_id=$1::uuid and l.recruiter_id=$2::uuid and l.verified
                and l.valid_from <= $3::date and (l.valid_to is null or $3::date < l.valid_to)
           )`,
          [appUser.app_user_id, recruiterByCode.get(accountId), today],
        );
      }
    }
    for (const [projectId, personnelCode] of Object.entries(PROJECT_MANAGER_BY_ID)) {
      await client.query(
        `insert into public.direct_entry_project_manager_assignments
           (project_id, manager_recruiter_id)
         values ($1::text, $2::uuid)
         on conflict (project_id, manager_recruiter_id) where valid_to is null
           do update set updated_at=now()`,
        [projectId, recruiterByCode.get(personnelCode)],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function run({ apply }) {
  const config = await loadSupabaseConfig();
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: buildSslOptions(),
    connectionTimeoutMillis: 10000,
  });
  const admin = createClient(config.url, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.connect();
  try {
    const recruiterByCode = await validateDatabase(client);
    let authUsers = await listAuthUsers(admin);
    let byEmail = new Map(authUsers.map((user) => [user.email?.toLowerCase(), user]));
    const missing = ACCOUNT_IDS.filter((accountId) => !byEmail.has(emailFor(accountId)));
    if (!apply) {
      return {
        mode: "dry-run", requestedAccounts: ACCOUNT_IDS.length,
        existingAccounts: ACCOUNT_IDS.length - missing.length, missingAccounts: missing.length,
        hrpRecruiterLinks: HRP_ACCOUNT_IDS.length,
        projectAssignments: Object.keys(PROJECT_MANAGER_BY_ID).length,
        unassignedProjects: UNASSIGNED_PROJECTS,
      };
    }
    const password = process.env.P3_W07B_DEFAULT_PASSWORD;
    if (process.env.P3_W07B_CONFIRM !== CONFIRM || !password || password.length < 6) {
      throw new Error("APPLY_CONFIRMATION_REQUIRED");
    }
    for (const accountId of missing) {
      const { error } = await admin.auth.admin.createUser({
        email: emailFor(accountId),
        password,
        email_confirm: true,
        user_metadata: { login_id: accountId },
      });
      if (error) throw new Error("AUTH_CREATE_FAILED");
    }
    authUsers = await listAuthUsers(admin);
    byEmail = new Map(authUsers.map((user) => [user.email?.toLowerCase(), user]));
    await applyPublicMappings(client, byEmail, recruiterByCode);
    return {
      mode: "apply", requestedAccounts: ACCOUNT_IDS.length,
      createdAccounts: missing.length, existingAccounts: ACCOUNT_IDS.length - missing.length,
      linkedRecruiters: HRP_ACCOUNT_IDS.length,
      projectAssignments: Object.keys(PROJECT_MANAGER_BY_ID).length,
      unassignedProjects: UNASSIGNED_PROJECTS,
      defaultPasswordLogged: false,
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) throw new Error("ARGUMENTS_INVALID");
  const summary = await run({ apply: args.includes("--apply") });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  main().catch((error) => {
    console.error(`P3_W07B_BOOTSTRAP_FAILED ${error?.message ?? "UNKNOWN"}`);
    process.exitCode = 1;
  });
}
