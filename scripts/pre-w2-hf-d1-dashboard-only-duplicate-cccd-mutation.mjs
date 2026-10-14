/**
 * PRE-W2-HF-D1 - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong registry / Dashboard tab / Dashboard page,
 * chay lane focused va BAT BUOC lane do phai DO. Sau moi lan, moi file bi sua duoc khoi phuc
 * byte-for-byte (script tu so hash).
 *
 * Tam probe toi thieu theo acceptance:
 *   1. nav doc lap tai xuat hien (deep-link path tro thang tab)  -> nav-menu test do;
 *   2. tab CCCD bi xoa khoi Dashboard                            -> tab-order test do;
 *   3. bo gate server `canViewDuplicateCccdReport`               -> gate test do;
 *   4. tab CCCD hien khong can quyen (visibleTabs luon true)     -> gate/tab test do.
 *
 * Cach chay: node scripts/pre-w2-hf-d1-dashboard-only-duplicate-cccd-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const REGISTRY = path.resolve("src/lib/navigation/registry.ts");
const TABS = path.resolve("src/components/dashboard/bod-dashboard-tabs.tsx");
const PAGE = path.resolve("src/app/dashboard/page.tsx");

const LANE_COMMANDS = [
  ["--test",
    "src/lib/auth/duplicate-cccd-report-access.test.mjs",
    "src/lib/navigation/registry.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. nav doc lap tai xuat hien (deep-link path)",
    file: REGISTRY,
    find: "    path: \"/dashboard\",",
    replace: "    path: \"/dashboard?tab=duplicate-cccd\",",
  },
  {
    label: "2. xoa tab CCCD khoi Dashboard",
    file: TABS,
    find: "  { key: \"team\", label: \"Báo cáo theo nhóm\", panelId: \"bod-panel-team\" },\n" +
      "  { key: \"duplicate-cccd\", label: \"Báo cáo CCCD trùng\", panelId: \"bod-panel-duplicate-cccd\" },\n" +
      "];",
    replace: "  { key: \"team\", label: \"Báo cáo theo nhóm\", panelId: \"bod-panel-team\" },\n" +
      "];",
  },
  {
    label: "3. bo gate server canViewDuplicateCccdReport",
    file: PAGE,
    find: "  const canViewDuplicateCccd = canViewDuplicateCccdReport(actor);",
    replace: "  const canViewDuplicateCccd = true;",
  },
  {
    label: "4. tab CCCD hien khong can quyen (visibleTabs luon true)",
    file: TABS,
    find: "    (tab) => tab.key !== \"duplicate-cccd\" || canViewDuplicateCccd,",
    replace: "    (tab) => true,",
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

const files = [REGISTRY, TABS, PAGE];
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
