/**
 * PRE-W2-HF-D3-A - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua mot doan trong migration #92, chay lane focused va BAT BUOC
 * lane do phai DO. Sau moi lan, file duoc khoi phuc byte-for-byte (script tu so hash).
 *
 * Nam probe theo yeu cau:
 *   1. bo Full Admin guard (authority);
 *   2. claim khong con la conditional atomic (double claim);
 *   3. khong dong bo linked recruiter khi doi display_name;
 *   4. bo guard 1:1 theo recruiter (cardinality);
 *   5. lay display_name tu browser thay vi tu account (auto-link/free-create).
 *
 * Cach chay: node scripts/pre-w2-hf-d3-a-account-personnel-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const MIGRATION = path.resolve(
  "supabase/migrations/20261014180000_pre_w2_hf_d3_a_account_personnel_db.sql");

const LANE_COMMANDS = [
  ["--test", "scripts/pre-w2-hf-d3-a-account-personnel-db.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. bo Full Admin guard (authority)",
    find: "perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);",
    replace: "perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_actor_app_user_id);",
  },
  {
    label: "2. claim khong con conditional atomic (double claim)",
    find: "     and state = 'PENDING'\n  returning * into v_intent;",
    replace: "  returning * into v_intent;",
  },
  {
    label: "3. khong dong bo linked recruiter khi doi display_name",
    find: "  if v_linked_recruiter_id is not null then",
    replace: "  if false then",
  },
  {
    label: "4. bo guard 1:1 theo recruiter (cardinality)",
    find: "  if new.verified then",
    replace: "  if false then",
  },
  {
    label: "5. lay display_name tu browser (auto-link/free-create)",
    find: "values (v_account.display_name, v_code, v_position, true, 1)",
    replace: "values ('browser-supplied', v_code, v_position, true, 1)",
  },
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function applyMutation(source, mutation) {
  if (!source.includes(mutation.find)) {
    throw new Error("anchor not found for " + mutation.label);
  }
  return source.split(mutation.find).join(mutation.replace);
}

async function runLane() {
  for (const args of LANE_COMMANDS) {
    try {
      await run(process.execPath, args, { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
    } catch {
      return true;
    }
  }
  return false;
}

const original = await readFile(MIGRATION, "utf8");
const hash = sha256(original);

const results = [];
try {
  for (const mutation of MUTATIONS) {
    await writeFile(MIGRATION, applyMutation(original, mutation), "utf8");
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
