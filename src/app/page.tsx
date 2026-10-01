import { connection } from "next/server";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION, DAILY_RECRUITMENT_BREAKDOWN_RPC_NAME } from "@/lib/contracts/daily-recruitment-breakdown";
import { getEnvVarStatus } from "@/lib/env";

export const metadata = {
  title: "mini-bi — Báo cáo tuyển dụng",
};

export default async function Home() {
  // Đọc biến môi trường tại thời điểm request, không nhúng giá trị vào build tĩnh.
  await connection();

  const envStatus = getEnvVarStatus();
  const missing = envStatus.filter((entry) => !entry.present);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <header>
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Sales Performance &amp; Reporting System V1 — P0</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Báo cáo số người tuyển theo ngày
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Trang nền của P0. Dashboard BoD thuộc P1 và chưa được xây dựng trong task này.
        </p>
      </header>

      {missing.length > 0 ? (
        <Alert tone="warning" title="Cấu hình môi trường chưa đầy đủ">
          <p>
            Thiếu: {missing.map((entry) => entry.name).join(", ")}. Sao chép <code>.env.example</code> thành{" "}
            <code>.env.local</code> và điền giá trị. Không có giá trị mặc định và không có fallback.
          </p>
        </Alert>
      ) : (
        <Alert tone="info" title="Cấu hình môi trường đã có đủ biến bắt buộc">
          <p>Server đã đọc được các biến cần thiết. Giá trị không được hiển thị ở đây.</p>
        </Alert>
      )}

      <Card>
        <CardHeader title="Trạng thái biến môi trường" description="Chỉ hiển thị tên biến và trạng thái có/không. Không hiển thị giá trị." />
        <table className="w-full text-left text-sm">
          <thead className="text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="py-1 font-medium">Biến</th>
              <th className="py-1 font-medium">Phạm vi</th>
              <th className="py-1 font-medium">Trạng thái</th>
            </tr>
          </thead>
          <tbody className="text-zinc-800 dark:text-zinc-200">
            {envStatus.map((entry) => (
              <tr key={entry.name} className="border-t border-zinc-100 dark:border-zinc-900">
                <td className="py-1.5 font-mono text-xs">{entry.name}</td>
                <td className="py-1.5">{entry.scope === "public" ? "public (bundle)" : "server-only"}</td>
                <td className="py-1.5">{entry.present ? "đã cấu hình" : "thiếu"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card>
        <CardHeader title="Data contract đang áp dụng" description="Nguồn tham chiếu cho tích hợp với workflow n8n." />
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-500 dark:text-zinc-400">Contract version</dt>
          <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{DAILY_RECRUITMENT_BREAKDOWN_CONTRACT_VERSION}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Ingestion RPC</dt>
          <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{DAILY_RECRUITMENT_BREAKDOWN_RPC_NAME}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Chiều phân loại</dt>
          <dd className="text-zinc-800 dark:text-zinc-200">Dự án · Người tuyển · HRP/Vendor · Loại hình làm việc</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Tài liệu</dt>
          <dd className="font-mono text-xs text-zinc-800 dark:text-zinc-200">docs/contracts/daily-recruitment-breakdown-v0.2.md</dd>
        </dl>
      </Card>
    </main>
  );
}