import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const MIGRATION = path.join(
  ROOT, "supabase", "migrations", "20261015130000_pre_w2_hf_project_team_batch_mapping.sql");
const CONTRACT = path.join(ROOT, "src", "lib", "admin", "project-team-scope-contract.ts");
const API = path.join(ROOT, "src", "lib", "admin", "project-team-scope-api.ts");

const DB_LANE = ["--test", "scripts/pre-w2-hf-project-team-authority-db.test.mjs"];
const API_LANE = [
  "--conditions=react-server", "--test",
  "src/lib/admin/project-team-scope-contract.test.mjs",
  "src/lib/admin/project-team-scope-api.test.mjs",
];

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`mutation anchor missing: ${before}`);
  return source.replace(before, after);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const probes = [
  {
    label: "dropping batch Full Admin authority",
    file: MIGRATION,
    lane: DB_LANE,
    mutate(source) {
      return replace(source,
        "v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);",
        "v_authority := 'entry_admin';");
    },
  },
  {
    label: "swallowing a per-project write failure",
    file: MIGRATION,
    lane: DB_LANE,
    mutate(source) {
      const loop = "  for v_project_id in select unnest(v_project_ids) order by 1 loop\n";
      const end = "  end loop;\n\n  v_result := jsonb_build_object(";
      return replace(replace(source,
        loop, loop + "    begin\n"),
        end, "    exception when others then\n      null;\n    end;\n" + end);
    },
  },
  {
    label: "accepting client-supplied pair versions",
    file: CONTRACT,
    lane: API_LANE,
    mutate(source) {
      return replace(source,
        "Object.keys(v).sort().join(\",\") === [...keys].sort().join(\",\")",
        "Object.keys(v).filter((key) => key !== \"expected_pair_version\").sort().join(\",\") === [...keys].sort().join(\",\")");
    },
  },
  {
    label: "accepting client-supplied authority fields",
    file: API,
    lane: API_LANE,
    mutate(source) {
      return replace(source,
        "if (!validateClientBusinessPayload(authorityCheck).ok)",
        "if (false && !validateClientBusinessPayload(authorityCheck).ok)");
    },
  },
  {
    label: "leaking database details in an API error",
    file: API,
    lane: API_LANE,
    mutate(source) {
      const anchor = 'return fail("PROJECT_TEAM_SCOPE_UNAVAILABLE", 500);';
      const index = source.lastIndexOf(anchor);
      if (index < 0) throw new Error("sanitized error anchor missing");
      return source.slice(0, index)
        + 'return fail("database sensitive error details", 500);'
        + source.slice(index + anchor.length);
    },
  },
  {
    label: "revoking legacy RPC access during migration-first rollout",
    file: MIGRATION,
    lane: DB_LANE,
    mutate(source) {
      const anchor = "-- Keep the versioned RPC and its existing ACL intact until the old UI/API caller\n"
        + "-- is retired. The new API uses the batch RPC; deployment still requires T1A coordination.\n";
      return replace(source, anchor, anchor
        + "revoke all on function public.direct_entry_grant_project_team_scope(uuid, uuid, text, uuid, integer, date, text, text) from service_role;\n"
        + "revoke all on function public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, integer, date, text, text) from service_role;\n");
    },
  },
];

const originals = new Map();
for (const probe of probes) {
  if (!originals.has(probe.file)) originals.set(probe.file, await readFile(probe.file));
}
const hashes = new Map([...originals].map(([file, bytes]) => [file, sha256(bytes)]));
const results = [];

async function laneIsRed(args) {
  try {
    await run(process.execPath, args, { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
    return false;
  } catch (error) {
    if (typeof error.code === "number") return error.code !== 0;
    throw error;
  }
}

try {
  for (const probe of probes) {
    const original = originals.get(probe.file).toString("utf8");
    try {
      await writeFile(probe.file, probe.mutate(original), "utf8");
      const red = await laneIsRed(probe.lane);
      results.push({ label: probe.label, red });
      console.log(`${red ? "RED   " : "GREEN "}${probe.label}`);
    } finally {
      await writeFile(probe.file, originals.get(probe.file));
    }
  }
} finally {
  for (const [file, bytes] of originals) await writeFile(file, bytes);
}

const restored = (await Promise.all([...originals].map(async ([file]) =>
  sha256(await readFile(file)) === hashes.get(file)))).every(Boolean);
const missed = results.filter(({ red }) => !red);
console.log(`\nmutation probes red: ${results.length - missed.length}/${results.length}`);
console.log(`sources restored byte-for-byte: ${restored}`);
if (missed.length > 0 || !restored) process.exitCode = 1;
