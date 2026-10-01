import Link from "next/link";

import { Card, CardHeader } from "@/components/ui/card";

export const metadata = {
  title: "mini-bi — Báo cáo tuyển dụng",
};

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <header>
        <p className="text-sm font-medium text-muted">Sales Performance &amp; Reporting System V1 — P1</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Báo cáo tuyển dụng</h1>
        <p className="mt-2 text-sm text-muted">
          Số người tuyển theo ngày — theo dự án, người tuyển, HRP/Vendor và loại hình làm việc.
        </p>
      </header>

      <div>
        <Link
          href="/dashboard"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          Mở báo cáo
        </Link>
        <p className="mt-2 text-xs text-muted">Báo cáo được bảo vệ bằng access gate — cần đăng nhập pilot để xem dữ liệu.</p>
      </div>

      <Card>
        <CardHeader title="Giới thiệu" description="Hệ thống báo cáo kết quả tuyển dụng cho BoD / Leader / Staff." />
        <p className="text-sm text-muted">
          “Kết quả kinh doanh” ở đây là số người được tuyển theo ngày, không phải tiền. Dashboard không hiển thị dữ liệu cá nhân của ứng viên.
        </p>
      </Card>
    </main>
  );
}
