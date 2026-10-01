/**
 * TLS cho kết nối Postgres tới Supabase.
 *
 * Supavisor pooler dùng PKI riêng của Supabase ("Supabase Root 2021 CA"), không có
 * trong CA store công khai của Node. Vì vậy repo pin sẵn root CA đó để vẫn xác minh
 * chứng chỉ server thay vì tắt xác minh.
 *
 * File pin: supabase/certs/supabase-pooler-root-2021-ca.pem (chứng chỉ công khai,
 * không phải secret). Khi Supabase xoay CA, cập nhật file này.
 *
 * SUPABASE_DB_TLS_INSECURE=1 chỉ dùng để xử lý sự cố cục bộ; sẽ in cảnh báo rõ ràng.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CA_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "certs",
  "supabase-pooler-root-2021-ca.pem"
);

export function buildSslOptions() {
  if (process.env.SUPABASE_DB_TLS_INSECURE === "1") {
    console.warn("CẢNH BÁO: SUPABASE_DB_TLS_INSECURE=1 — KHÔNG xác minh chứng chỉ TLS của server.");
    return { rejectUnauthorized: false };
  }
  return { ca: readFileSync(CA_PATH, "utf8") };
}

export const SUPABASE_CA_PATH = CA_PATH;
