/**
 * PRE-W2-P1 - bang chung MUTATION CHECK (chay tay, khong nam trong lane tu dong).
 *
 * Voi moi mutation, script sua dung mot doan trong migration export hoac XLSX builder, chay lane
 * focused `test:pre-w2-p1-worker-export-backend` va BAT BUOC lane do phai DO. Sau moi lan, moi
 * file bi sua duoc khoi phuc byte-for-byte (script tu so hash).
 *
 * Tam probe toi thieu theo yeu cau:
 *   1. reintroduce an export-capability requirement for row-scoped exports;
 *   2. allow an unknown scope token;
 *   3. truncate 10.001 thanh 10.000;
 *   4. ghi recruited/managed truc tiep vao scope_kind;
 *   5. RAISE sau cap audit (audit mat);
 *   6. ghi raw filter thay cho hash vao audit;
 *   7. viet CCCD nhu number (mat so 0 dau);
 *   8. tao formula cell tu chuoi "=".
 *
 * Cach chay: node scripts/pre-w2-p1-worker-export-mutation.mjs
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(".");
const MIGRATION = path.resolve("supabase/migrations/20261014190000_pre_w2_hf_g_worker_directory_export.sql");
const XLSX = path.resolve("src/lib/direct-entry/worker-export-xlsx.ts");

const LANE_COMMANDS = [
  ["--conditions=react-server", "--test",
    "src/lib/direct-entry/worker-export-contract.test.mjs",
    "src/lib/direct-entry/worker-export-repository.test.mjs",
    "src/lib/direct-entry/worker-export-api.test.mjs",
    "src/lib/direct-entry/worker-export-xlsx.test.mjs"],
  ["--test", "scripts/pre-w2-p1-worker-export-db.test.mjs"],
];

const MUTATIONS = [
  {
    label: "1. require pii_export outside all scope (denying row-scoped export)",
    file: MIGRATION,
    find: "  -- 2. Company-wide export keeps the existing capability conjunction. For\n",
    replace: "  if p_scope in ('recruited', 'managed') and\n" +
      "     not public.direct_entry_has_capability(p_app_user_id, 'pii_export') then\n" +
      "    raise exception 'mutation capability denied' using errcode = '42501';\n" +
      "  end if;\n\n" +
      "  -- 2. Company-wide export keeps the existing capability conjunction. For\n",
  },
  {
    label: "2. allow an unknown scope token",
    file: MIGRATION,
    find: "  if p_scope is null or p_scope not in ('recruited', 'managed', 'all') then",
    replace: "  if p_scope is null or p_scope not in ('recruited', 'managed', 'all', 'everything') then",
  },
  {
    label: "3. truncate 10.001 thanh 10.000",
    file: MIGRATION,
    find: "     limit 10001",
    replace: "     limit 10000",
  },
  {
    label: "4. ghi raw scope vao scope_kind",
    file: MIGRATION,
    find: "  v_scope_kind := case\n" +
      "    when p_scope = 'recruited' then 'own'\n" +
      "    when p_scope = 'managed' then 'project'\n" +
      "    else 'all'\n" +
      "  end;",
    replace: "  v_scope_kind := p_scope;",
  },
  {
    label: "5. RAISE sau cap audit",
    file: MIGRATION,
    find: "    return jsonb_build_object('status', 'too_many_rows', 'limit', 10000);",
    replace: "    raise exception 'mutation cap raise' using errcode = 'P0001';",
  },
  {
    label: "6. raw filter thay cho hash trong audit",
    file: MIGRATION,
    find: "      'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,\n" +
      "      v_scope_kind, 'REJECTED'",
    replace: "      'worker-export:' || p_scope || ':' || v_total::text || ':' || coalesce(p_project_id, 'rawfilter'),\n" +
      "      v_scope_kind, 'REJECTED'",
  },
  {
    label: "7. viet CCCD nhu number",
    file: XLSX,
    find: "    const added = sheet.addRow(WORKER_EXPORT_COLUMNS.map((column) => cellText(row[column.key])));",
    replace: "    const added = sheet.addRow(WORKER_EXPORT_COLUMNS.map((column) =>\n" +
      "      column.key === \"national_id\" ? Number(row[column.key]) : cellText(row[column.key])));",
  },
  {
    label: "8. tao formula cell tu chuoi '='",
    file: XLSX,
    find: "    const added = sheet.addRow(WORKER_EXPORT_COLUMNS.map((column) => cellText(row[column.key])));",
    replace: "    const added = sheet.addRow(WORKER_EXPORT_COLUMNS.map((column) => {\n" +
      "      const text = cellText(row[column.key]);\n" +
      "      return text.startsWith(\"=\") ? { formula: text.slice(1) } : text;\n" +
      "    }));",
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

const files = [MIGRATION, XLSX];
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
