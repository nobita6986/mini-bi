/**
 * Đọc cấu hình Supabase cho script chạy ngoài Next.js (migration, kiểm tra fixture).
 *
 * Nguồn secrets: file cấu hình ngoài repo (mặc định C:\\CodeApp\\supabase-bi.txt).
 * KHÔNG commit file cấu hình. KHÔNG in giá trị secret ra log.
 *
 * Vì sao cần SUPABASE_POOLER_HOST: host `db.<ref>.supabase.co` của project này
 * chỉ có bản ghi AAAA (IPv6). Máy chạy migration không có IPv6 ra Internet, nên
 * phải đi qua Supavisor pooler (IPv4). Giá trị này không phải secret nhưng phụ
 * thuộc môi trường nên đặt trong .env.local (đã gitignore).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONFIG_FILE = "C:\\CodeApp\\supabase-bi.txt";
const LOCAL_ENV_FILE = ".env.local";

async function readKeyValueFile(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.search(/[:=]/);
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && value) values[key] = value;
  }
  return values;
}

function parseDelimitedConfig(file, raw) {
  const values = {};
  const bare = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.search(/[:=]/);
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (value !== "") values[key] = value;
    else if (/^eyJ/.test(trimmed)) bare.push(trimmed);
    // Dòng JWT trần (không nhãn) như "eyJ...": nhận qua nhánh dưới.
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^eyJ[A-Za-z0-9._-]+$/.test(trimmed)) bare.push(trimmed);
  }
  return { values, bare };
}

export async function loadSupabaseConfig() {
  const configFile = process.env.SUPABASE_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  const raw = await readFile(configFile, "utf8");
  const { values, bare } = parseDelimitedConfig(configFile, raw);

  const localEnv = await readKeyValueFile(path.join(process.cwd(), LOCAL_ENV_FILE));
  const pick = (name) => process.env[name] || localEnv[name] || null;

  const url = values.NEXT_PUBLIC_SUPABASE_URL || pick("NEXT_PUBLIC_SUPABASE_URL");
  const publishableKey =
    values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || pick("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const secretKey = pick("SUPABASE_SECRET_KEY") || values.SUPABASE_SECRET_KEY || bare[0];

  let directUrl = pick("SUPABASE_DB_URL") || values.SUPABASE_DB_URL || values.postgresql || null;
  if (directUrl && !/^postgres(ql)?:\/\//.test(directUrl)) {
    directUrl = "postgresql:" + directUrl;
  }

  const missing = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!publishableKey) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!secretKey) missing.push("SUPABASE_SECRET_KEY");
  if (!directUrl) missing.push("SUPABASE_DB_URL");
  if (missing.length > 0) {
    throw new Error(`Thiếu cấu hình trong ${configFile}: ${missing.join(", ")}`);
  }

  // Project ref lấy từ public API URL (https://<ref>.supabase.co), KHÔNG lấy từ
  // host db.<ref>.supabase.co (label đầu là "db").
  const projectRef = new URL(url).hostname.split(".")[0];

  const parsed = new URL(directUrl);
  const password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.replace(/^\//, "") || "postgres";

  const poolerHost = pick("SUPABASE_POOLER_HOST");
  const poolerPort = Number(pick("SUPABASE_POOLER_PORT") || 5432);

  const databaseUrl = poolerHost
    ? `postgresql://postgres.${projectRef}:${encodeURIComponent(password)}@${poolerHost}:${poolerPort}/${database}`
    : directUrl;

  return {
    url,
    publishableKey,
    secretKey,
    databaseUrl,
    directDatabaseUrl: directUrl,
    usesPooler: Boolean(poolerHost),
    projectRef,
    configFile,
  };
}
