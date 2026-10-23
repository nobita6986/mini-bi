/**
 * P3.1-HF-R3 - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong source da cua P3.1-HF-R3, chay lane focused
 * `test:p3-1-hf-r3-duplicate-cccd-report-ui` va BAT BUOC lane do phai DO. Sau moi lan, moi file
 * bi sua duoc khoi phuc byte-for-byte (script tu so hash).
 *
 * Ba probe toi thieu theo yeu cau:
 *   1. bo all-scope gate tren predicate doc bao cao;
 *   2. tra authority/project_id (dinh danh noi bo) ra client;
 *   3. vuot paging bound cua RPC (bo tran page_size).
 *
 * P3.1-HF-R3-R1 them hai probe cho phan Dashboard tab:
 *   4. bo chan page 1000 (cho phep goi page 1001 du has_more);
 *   5. bo gate tab CCCD tren Dashboard (luon hien tab).
 *
 * Cach chay: node scripts/p3-1-hf-r3-duplicate-cccd-report-ui-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const ACCESS = path.resolve("src/lib/auth/direct-entry-page-access.ts");
const CONTRACT = path.resolve("src/lib/direct-entry/duplicate-cccd-report-contract.ts");
const TABS = path.resolve("src/components/dashboard/bod-dashboard-tabs.tsx");
const PANEL = path.resolve("src/components/reporting/duplicate-cccd-report-panel.tsx");

const LANE_COMMANDS = [
  ["--conditions=react-server", "--test",
    "src/lib/direct-entry/duplicate-cccd-report-contract.test.mjs",
    "src/lib/direct-entry/duplicate-cccd-report-repository.test.mjs",
    "src/lib/direct-entry/duplicate-cccd-report-api.test.mjs"],
  ["--test", "src/lib/auth/duplicate-cccd-report-access.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. bo fail-closed actor gate tren canViewDuplicateCccdReport",
    file: ACCESS,
    find: "export function canViewDuplicateCccdReport(actor: ActorResolution | null): boolean {\n" +
      "  return actor !== null && actor.ok;",
    replace: "export function canViewDuplicateCccdReport(_actor: ActorResolution | null): boolean {\n" +
      "  return true;",
  },
  {
    label: "2. tra authority/project_id (dinh danh noi bo) ra client",
    file: CONTRACT,
    find: "  return {\n    page: value.page,\n    page_size: value.page_size,\n    total_groups: value.total_groups,",
    replace: "  return {\n    authority: \"entry_admin\",\n    project_id: \"proj_a\",\n    page: value.page,\n    page_size: value.page_size,\n    total_groups: value.total_groups,",
  },
  {
    label: "3. vuot paging bound (bo tran page_size)",
    file: CONTRACT,
    find: "    pageSize = Number(rawPageSize);\n" +
      "    if (pageSize < 1 || pageSize > DUPLICATE_CCCD_REPORT_MAX_PAGE_SIZE) return QUERY_INVALID;",
    replace: "    pageSize = Number(rawPageSize);\n" +
      "    if (pageSize < 1) return QUERY_INVALID;",
  },
  {
    label: "4. bo chan page 1000 (cho phep goi page 1001 du has_more)",
    file: CONTRACT,
    find: "  if (!Number.isSafeInteger(page) || page < 1) return null;\n" +
      "  if (page >= DUPLICATE_CCCD_REPORT_MAX_PAGE) return null;\n" +
      "  return page + 1;",
    replace: "  if (!Number.isSafeInteger(page) || page < 1) return null;\n" +
      "  return page + 1;",
  },
  {
    label: "5. bo gate tab CCCD tren Dashboard (luon hien tab)",
    file: TABS,
    find: "    tab.key === \"duplicate-cccd\"\n" +
      "      ? canViewDuplicateCccd",
    replace: "    tab.key === \"duplicate-cccd\"\n" +
      "      ? true",
  },
  {
    label: "6. cho phep client truyen project_id hoac query key tuy y",
    file: CONTRACT,
    find: "  for (const key of searchParams.keys()) {\n" +
      "    if (!(DUPLICATE_CCCD_REPORT_QUERY_KEYS as readonly string[]).includes(key)) return QUERY_INVALID;\n" +
      "  }",
    replace: "  for (const _key of searchParams.keys()) {\n" +
      "    void _key;\n" +
      "  }",
  },
  {
    label: "7. lam lo created_by_user_id trong episode projection",
    file: CONTRACT,
    find: "    can_mark_off: value.can_mark_off,\n" +
      "    can_self_withdraw: value.can_self_withdraw,",
    replace: "    can_mark_off: value.can_mark_off,\n" +
      "    can_self_withdraw: value.can_self_withdraw,\n" +
      "    created_by_user_id: \"leaked-user\",",
  },
  {
    label: "8. bo server action flag gate tren nut Rut trung trong UI",
    file: PANEL,
    find: "                  {episode.can_self_withdraw ? (",
    replace: "                  {true ? (",
  },
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function applyMutation(source, mutation) {
  const parts = source.split(mutation.find);
  if (parts.length !== 2) {
    throw new Error(
      "anchor must occur exactly once for " + mutation.label + " (found " + (parts.length - 1) + ")",
    );
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

const originals = new Map();
const originalHashes = new Map();
const touchedFiles = [ACCESS, CONTRACT, TABS, PANEL];
for (const file of touchedFiles) {
  const text = await readFile(file, "utf8");
  originals.set(file, text);
  originalHashes.set(file, sha256(text));
}

const results = [];
try {
  for (const mutation of MUTATIONS) {
    const mutated = applyMutation(originals.get(mutation.file), mutation);
    await writeFile(mutation.file, mutated, "utf8");
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
  for (const file of touchedFiles) {
    await writeFile(file, originals.get(file), "utf8");
  }
}

const green = results.filter((item) => !item.red);
let restoredAll = true;
for (const file of touchedFiles) {
  if (sha256(await readFile(file, "utf8")) !== originalHashes.get(file)) restoredAll = false;
}
console.log("");
console.log("mutation checks red: " + (results.length - green.length) + "/" + results.length);
console.log("sources restored byte-for-byte: " + String(restoredAll));
if (green.length > 0 || !restoredAll) {
  console.error("MUTATION EVIDENCE FAILED " + JSON.stringify(green));
  process.exitCode = 1;
}
