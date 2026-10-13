/**
 * PRE-W2-P2 - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong model affordance / proposal builder / hai entry
 * point, chay lane focused `test:pre-w2-p2-worker-name-correction` va BAT BUOC lane do phai DO.
 * Sau moi lan, moi file bi sua duoc khoi phuc byte-for-byte (script tu so hash).
 *
 * Tam probe toi thieu theo yeu cau:
 *   1. bo gate pii_view (suy quyen xem PII tu quyen de xuat);
 *   2. gui name-only payload thay vi worker_details day du;
 *   3. bypass change-request / direct-write;
 *   4. bo mot entry point (Directory khong con denial -> form hong).
 *
 * Cach chay: node scripts/pre-w2-p2-worker-name-correction-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const MODEL = path.resolve("src/lib/direct-entry/worker-operations-model.ts");
const BUILDERS = path.resolve("src/lib/direct-entry/change-request-proposal-builders.ts");
const DRAWER = path.resolve("src/components/direct-entry/worker-operations.tsx");

const LANE_COMMANDS = [
  ["--test", "src/lib/direct-entry/worker-name-correction.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. bo gate pii_view (suy quyen xem PII tu quyen de xuat)",
    file: MODEL,
    find: "  if (!input.viewPii) return { available: false, message: WORKER_NAME_DENIED_PII_MESSAGE };",
    replace: "  if (false) return { available: false, message: WORKER_NAME_DENIED_PII_MESSAGE };",
  },
  {
    label: "2. gui name-only payload thay vi worker_details day du",
    file: BUILDERS,
    find: "  return { ok: true, proposal: { worker_details: candidate } };",
    replace: "  return { ok: true, proposal: { worker_details: " +
      "{ display_name: candidate.display_name } } };",
  },
  {
    label: "3. bypass change-request (direct-write qua privileged-edit)",
    file: DRAWER,
    find: "      const response = await fetch(API + \"/change-requests\", {",
    replace: "      const response = await fetch(API + \"/entries/\" + " +
      "encodeURIComponent(row.entry_id) + \"/privileged-edit\", {",
  },
  {
    label: "4. bo mot entry point (Directory khong con denial)",
    file: DRAWER,
    find: "data-testid=\"propose-worker-unavailable\"",
    replace: "data-testid=\"removed-parity\"",
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

const files = [MODEL, BUILDERS, DRAWER];
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
