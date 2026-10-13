/**
 * PRE-W2-HF-C - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong migration #87 / #74 hoac source da cua
 * HF-C, chay lane focused `test:pre-w2-hf-c-global-duplicate-cccd-read-access` va BAT BUOC lane
 * do phai DO. Sau moi lan, moi file bi sua duoc khoi phuc byte-for-byte (script tu so hash).
 *
 * Bay probe toi thieu theo yeu cau:
 *   1. bo session guard (reader khong con actor mapping);
 *   2. cho disabled account doc;
 *   3. lam lo raw CCCD;
 *   4. lam lo project_id/internal ID trong response;
 *   5. mo nham general/team tab cho audience khac;
 *   6. bo page-1000 ceiling;
 *   7. grant RPC truc tiep cho authenticated/public.
 *
 * Cach chay: node scripts/pre-w2-hf-c-global-duplicate-cccd-read-access-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const HF_C = path.resolve("supabase/migrations/20261013130000_pre_w2_hf_c_global_duplicate_cccd_read_access.sql");
const REPORT = path.resolve("supabase/migrations/20261009100000_p3_1_hf_duplicate_cccd_reporting.sql");
const VIEW = path.resolve("src/components/dashboard/dashboard-view.tsx");
const API = path.resolve("src/lib/direct-entry/duplicate-cccd-report-api.ts");
const CONTRACT = path.resolve("src/lib/direct-entry/duplicate-cccd-report-contract.ts");

const READER_GUARD =
  "  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);\n" +
  "  return 'business_actor';";

const LANE_COMMANDS = [
  ["--conditions=react-server", "--test",
    "src/lib/direct-entry/duplicate-cccd-report-contract.test.mjs",
    "src/lib/direct-entry/duplicate-cccd-report-api.test.mjs"],
  ["--test",
    "src/lib/auth/duplicate-cccd-report-access.test.mjs",
    "scripts/pre-w2-hf-c-duplicate-cccd-read-access-db.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. bo session guard (reader khong con actor mapping)",
    file: HF_C,
    find: READER_GUARD,
    replace: "  return 'business_actor';",
  },
  {
    label: "2. cho disabled account doc (nuot loi guard)",
    file: HF_C,
    find: READER_GUARD,
    replace: "  begin\n" +
      "    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);\n" +
      "  exception when others then\n" +
      "    null;\n" +
      "  end;\n" +
      "  return 'business_actor';",
  },
  {
    label: "3. lam lo raw CCCD",
    file: REPORT,
    find: "                          'cccd_last4', right(pg.cccd, 4),",
    replace: "                          'cccd_last4', right(pg.cccd, 4),\n" +
      "                          'cccd', right(pg.cccd, 12),",
  },
  {
    label: "4. lam lo project_id/internal ID trong response",
    file: API,
    find: "  return respond({\n    ok: true,\n    page: result.data.page,",
    replace: "  return respond({\n    ok: true,\n    project_id: \"leaked-project-id\",\n    page: result.data.page,",
  },
  {
    label: "5. mo nham general/team tab cho audience khac",
    file: VIEW,
    find: '  if (mode.kind === "team") {',
    replace: '  if (mode.kind === "never") {',
  },
  {
    label: "6. bo page-1000 ceiling",
    file: CONTRACT,
    find: "  if (!Number.isSafeInteger(page) || page < 1) return null;\n" +
      "  if (page >= DUPLICATE_CCCD_REPORT_MAX_PAGE) return null;\n" +
      "  return page + 1;",
    replace: "  if (!Number.isSafeInteger(page) || page < 1) return null;\n" +
      "  return page + 1;",
  },
  {
    label: "7. grant RPC truc tiep cho authenticated",
    file: HF_C,
    find: "revoke all on function public.direct_entry_assert_duplicate_cccd_reader(uuid, uuid)\n" +
      "  from public, anon, authenticated, service_role;",
    replace: "revoke all on function public.direct_entry_assert_duplicate_cccd_reader(uuid, uuid)\n" +
      "  from public, anon, authenticated, service_role;\n" +
      "grant execute on function public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)\n" +
      "  to authenticated;",
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

const files = [HF_C, REPORT, VIEW, API, CONTRACT];
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
