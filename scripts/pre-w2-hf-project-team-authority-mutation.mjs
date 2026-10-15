/**
 * PRE-W2-HF Project<->Team authority - MUTATION CHECK evidence (manual, not in the CI lane).
 *
 * For every required mutation this script edits the #94 migration, runs the focused
 * DB lane, and REQUIRES the lane to go red. The migration file is restored
 * byte-for-byte after every run (self-verified by SHA-256).
 *
 * Probes (per the T1B handoff contract):
 *   1. remove the mapping gate from the leader read;
 *   2. remove the mapping gate from the leader assign/unassign;
 *   3. accept a wrong-team mapping (predicate loses the team term);
 *   4. allow project master to Team Leaders (can_manage_project_master forced true);
 *   5. drop the canonical Full Admin guard on the mapping RPCs;
 *   6. drop the revoke row lock (no revalidation under the lock);
 *   7. allow a future-effective revoke date.
 *
 * Run: node scripts/pre-w2-hf-project-team-authority-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const MIGRATION = path.join(
  ROOT, "supabase", "migrations", "20261015100000_pre_w2_hf_project_team_authority.sql");

const LANE_COMMANDS = [
  ["--test", "scripts/pre-w2-hf-project-team-authority-db.test.mjs"],
];

function findFunctionBody(source, name) {
  const start = source.indexOf(`create or replace function public.${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  const bodyStart = source.indexOf("as $$", start) + "as $$".length;
  const bodyEnd = source.indexOf("\n$$;", bodyStart);
  if (bodyStart <= "as $$".length || bodyEnd === -1) throw new Error(`${name} has no body`);
  return { start: bodyStart, end: bodyEnd, text: source.slice(bodyStart, bodyEnd) };
}

function replaceAll(source, find, replace) {
  if (!source.includes(find)) throw new Error(`anchor not found: ${JSON.stringify(find)}`);
  return source.split(find).join(replace);
}

const MUTATIONS = [
  {
    label: "1. remove the mapping gate from the leader read",
    apply: (source) => replaceAll(
      source,
      "v_authority <> 'team_manager_assign'\n       or public.direct_entry_project_team_scope_effective(a.project_id, v_team_id)",
      "v_authority <> 'team_manager_assign'",
    ),
  },
  {
    label: "2. remove the mapping gate from the leader assign/unassign",
    apply: (source) => [
      "if not public.direct_entry_lock_project_team_scope(p_project_id, v_team_id) then",
      "if not public.direct_entry_lock_project_team_scope(v_project_id, v_team_id) then",
      "if not public.direct_entry_project_team_scope_effective(p_project_id, v_team_id) then",
      "if not public.direct_entry_project_team_scope_effective(v_project_id, v_team_id) then",
    ].reduce((acc, anchor) => replaceAll(acc, anchor, "if false then"), source),
  },
  {
    label: "3. accept a wrong-team mapping (predicate loses the team term)",
    apply: (source) => {
      const body = findFunctionBody(source, "direct_entry_project_team_scope_effective");
      const mutated = body.text.replace("and s.team_id = p_team_id", "and true");
      if (!mutated.includes("and true")) throw new Error("team-term anchor not found");
      return source.slice(0, body.start) + mutated + source.slice(body.end);
    },
  },
  {
    label: "4. allow project master to Team Leaders",
    apply: (source) => replaceAll(
      source,
      "'can_manage_project_master', v_authority <> 'team_manager_assign'",
      "'can_manage_project_master', true",
    ),
  },
  {
    label: "5. drop the canonical Full Admin guard",
    apply: (source) => replaceAll(
      source,
      "public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id)",
      "null",
    ),
  },
  {
    label: "6. drop the revoke row lock (no revalidation under the lock)",
    apply: (source) => {
      const body = findFunctionBody(source, "direct_entry_revoke_project_team_scope");
      const find = "where s.mapping_id = p_mapping_id\n   for update;";
      if (!body.text.includes(find)) throw new Error("revoke lock anchor not found");
      return source.slice(0, body.start)
        + body.text.replace(find, "where s.mapping_id = p_mapping_id;")
        + source.slice(body.end);
    },
  },
  {
    label: "7. allow a future-effective revoke date",
    apply: (source) => replaceAll(
      source,
      "  if p_effective_to is not null\n"
        + "     and p_effective_to > public.direct_entry_authorization_date() then\n"
        + "    raise exception 'revoke date must not be in the future' using errcode = '22023';\n"
        + "  end if;\n",
      "",
    ),
  },
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function runLane() {
  for (const args of LANE_COMMANDS) {
    try {
      await run(process.execPath, args, { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
    } catch (error) {
      // node --test leaves non-zero on any failing test: the mutation is RED here.
      return error.code !== 0;
    }
  }
  return false;
}

const original = await readFile(MIGRATION, "utf8");
const hash = sha256(original);

const results = [];
try {
  for (const mutation of MUTATIONS) {
    await writeFile(MIGRATION, mutation.apply(original), "utf8");
    let red = false;
    try {
      red = await runLane();
    } finally {
      await writeFile(MIGRATION, original, "utf8");
    }
    results.push({ label: mutation.label, red });
    console.log((red ? "RED   " : "GREEN ") + mutation.label);
  }
} finally {
  await writeFile(MIGRATION, original, "utf8");
}

const green = results.filter((item) => !item.red);
const restored = sha256(await readFile(MIGRATION, "utf8")) === hash;
console.log("");
console.log("mutation checks red: " + (results.length - green.length) + "/" + results.length);
console.log("source restored byte-for-byte: " + String(restored));
if (green.length > 0 || !restored) {
  console.error("MUTATION EVIDENCE FAILED " + JSON.stringify(green));
  process.exitCode = 1;
}
