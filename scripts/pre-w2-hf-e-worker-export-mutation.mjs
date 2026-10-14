/**
 * PRE-W2-HF-G - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong UI gate / contract / migration #93, chay lane
 * focused va BAT BUOC lane do phai DO. Sau moi lan, moi file bi sua duoc khoi phuc byte-for-byte.
 *
 * Tam probe toi thieu theo yeu cau:
 *   1. bo gate audience cua `all` trong UI (suy quyen xuat toan bo);
 *   2. bo cot `general_note` khoi row projection;
 *   3. migration bien `general_note` thanh null (khong lay tu direct_entries.general_note);
 *   4. migration cho `all` bo qua capability conjunction (Admin thieu pii_export van xuat duoc).
 *
 * Cach chay: node scripts/pre-w2-hf-e-worker-export-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const MODEL = path.resolve("src/lib/direct-entry/worker-export-ui-model.ts");
const CONTRACT = path.resolve("src/lib/direct-entry/worker-export-contract.ts");
const MIGRATION = path.resolve(
  "supabase/migrations/20261014190000_pre_w2_hf_g_worker_directory_export.sql");

const LANE_COMMANDS = [
  ["--conditions=react-server", "--test",
    "src/lib/direct-entry/worker-export-contract.test.mjs",
    "src/lib/direct-entry/worker-export-repository.test.mjs",
    "src/lib/direct-entry/worker-export-api.test.mjs",
    "src/lib/direct-entry/worker-export-xlsx.test.mjs"],
  ["--test",
    "scripts/pre-w2-p1-worker-export-db.test.mjs",
    "src/lib/direct-entry/worker-export-ui-model.test.mjs",
    "src/components/direct-entry/worker-export-ui.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. bo gate audience cua all trong UI",
    file: MODEL,
    find: "  return WORKER_EXPORT_CAPABILITIES.every((capability) =>\n" +
      "      actor.capabilities.includes(capability)) &&\n" +
      "    actor.scopes.some((scope) => scope.kind === \"all\") &&\n" +
      "    actor.capabilities.some((capability) =>\n" +
      "      capability === \"entry_admin\" || capability === \"change_review\");",
    replace: "  return actor !== null;",
  },
  {
    label: "2. bo cot general_note khoi row projection",
    file: CONTRACT,
    find: "  \"bank_name\", \"account_holder_name\", \"payment_note\", \"general_note\",\n" +
      "] as const;",
    replace: "  \"bank_name\", \"account_holder_name\", \"payment_note\",\n" +
      "] as const;",
  },
  {
    label: "3. migration bien general_note thanh null",
    file: MIGRATION,
    find: "             'payment_note', null,\n             'general_note', b.general_note",
    replace: "             'payment_note', null,\n             'general_note', null",
  },
  {
    label: "4. migration bo capability conjunction (all scope must still deny)",
    file: MIGRATION,
    find: "  if p_scope = 'all' and (\n" +
      "       not public.direct_entry_has_capability(p_app_user_id, 'pii_export')\n" +
      "       or not public.direct_entry_has_capability(p_app_user_id, 'pii_view')\n" +
      "       or not public.direct_entry_has_capability(p_app_user_id, 'payment_view')) then\n" +
      "    raise exception 'worker export capability denied' using errcode = '42501';\n" +
      "  end if;",
    replace: "",
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

const files = [MODEL, CONTRACT, MIGRATION];
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
