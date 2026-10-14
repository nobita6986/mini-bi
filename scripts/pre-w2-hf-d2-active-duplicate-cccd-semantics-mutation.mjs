/**
 * PRE-W2-HF-D2 - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua mot doan trong migration #88/#74 hoac contract HF-D2, chay lane
 * focused `test:pre-w2-hf-d2-active-duplicate-cccd-semantics` va BAT BUOC lane do phai DO. Sau
 * moi lan, moi file bi sua duoc khoi phuc byte-for-byte (script tu so hash).
 *
 * Ba probe toi thieu theo yeu cau:
 *   1. bo predicate active (nhom lai tren TONG ho so, OFF quay lai bao cao);
 *   2. lam lo raw CCCD trong projection;
 *   3. lam lo project_id (dinh danh noi bo) ra client projection.
 *
 * Cach chay: node scripts/pre-w2-hf-d2-active-duplicate-cccd-semantics-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const D2 = path.resolve("supabase/migrations/20261013140000_pre_w2_hf_d2_active_duplicate_cccd_semantics.sql");
const REPORT = path.resolve("supabase/migrations/20261009100000_p3_1_hf_duplicate_cccd_reporting.sql");
const CONTRACT = path.resolve("src/lib/direct-entry/duplicate-cccd-report-contract.ts");

const LANE_COMMANDS = [
  ["--test", "scripts/pre-w2-hf-d2-active-duplicate-cccd-semantics-db.test.mjs"],
  ["--conditions=react-server", "--test",
    "src/lib/direct-entry/duplicate-cccd-report-contract.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. bo predicate active (OFF quay lai bao cao)",
    file: D2,
    find:
      "  $new$where public.direct_entry_is_canonical_national_id(c.cccd)\n" +
      "         and coalesce((\n" +
      "               select st.status\n" +
      "                 from public.direct_entry_employment_status_events st\n" +
      "                where st.entry_id = c.entry_id\n" +
      "                order by st.version desc\n" +
      "                limit 1\n" +
      "             ), 'UNCONFIRMED') = 'ON'$new$,",
    replace:
      "  $new$where public.direct_entry_is_canonical_national_id(c.cccd)$new$,",
  },
  {
    label: "2. lam lo raw CCCD trong projection",
    file: REPORT,
    find: "                          'cccd_last4', right(pg.cccd, 4),",
    replace:
      "                          'cccd_last4', right(pg.cccd, 4),\n" +
      "                          'cccd', right(pg.cccd, 12),",
  },
  {
    label: "3. lam lo project_id ra client projection",
    file: CONTRACT,
    find:
      "export const DUPLICATE_CCCD_REPORT_EPISODE_KEYS = [\n" +
      "  \"employee_code\", \"display_name\", \"project_display\", \"first_work_date\", \"latest_status\",\n" +
      "  \"active\",\n" +
      "] as const;",
    replace:
      "export const DUPLICATE_CCCD_REPORT_EPISODE_KEYS = [\n" +
      "  \"employee_code\", \"display_name\", \"project_display\", \"first_work_date\", \"latest_status\",\n" +
      "  \"active\", \"project_id\",\n" +
      "] as const;",
  },
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function applyMutation(source, mutation) {
  const parts = source.split(mutation.find);
  if (parts.length !== 2) {
    throw new Error("anchor must occur exactly once for " + mutation.label +
      " (found " + (parts.length - 1) + ")");
  }
  return parts.join(mutation.replace);
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

const files = [D2, REPORT, CONTRACT];
const originals = new Map();
const hashes = new Map();
for (const file of files) {
  const text = await readFile(file, "utf8");
  originals.set(file, text);
  hashes.set(file, sha256(text));
}

const results = [];
try {
  for (const mutation of MUTATIONS) {
    await writeFile(mutation.file, applyMutation(originals.get(mutation.file), mutation), "utf8");
    let red = false;
    try {
      red = await runLane();
    } finally {
      await writeFile(mutation.file, originals.get(mutation.file), "utf8");
    }
    results.push({ label: mutation.label, red });
    console.log((red ? "RED   " : "GREEN ") + mutation.label);
  }
} finally {
  for (const file of files) await writeFile(file, originals.get(file), "utf8");
}

const green = results.filter((item) => !item.red);
let restored = true;
for (const file of files) {
  if (sha256(await readFile(file, "utf8")) !== hashes.get(file)) restored = false;
}
console.log("");
console.log("mutation checks red: " + (results.length - green.length) + "/" + results.length);
console.log("sources restored byte-for-byte: " + String(restored));
if (green.length > 0 || !restored) {
  console.error("MUTATION EVIDENCE FAILED " + JSON.stringify(green));
  process.exitCode = 1;
}
