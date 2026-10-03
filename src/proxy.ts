import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { evaluatePilotAccess, isPilotProtectedPath, PILOT_AUTH_REALM } from "@/lib/auth/pilot-access";

const UNAUTHORIZED_BODY = "Unauthorized";
const UNAVAILABLE_BODY = "Pilot access unavailable";

/**
 * Access gate pilot P1-W03 — Basic Auth ở tầng proxy (chạy TRƯỚC Server Component,
 * Supabase client, DB query và API/reporting handler).
 *
 * - development: bỏ qua gate (cho pnpm dev).
 * - production/preview: thiếu PILOT_ACCESS_* => fail closed 503;
 *   thiếu/sai Authorization => 401; đúng => đi tiếp.
 * - Không tạo Supabase client, không đọc SUPABASE_SECRET_KEY, không gọi DB/API ngoài.
 */
export function proxy(request: NextRequest) {
  // Defense-in-depth: matcher đã giới hạn; đảm bảo không gate route ngoài danh sách.
  if (!isPilotProtectedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const decision = evaluatePilotAccess({
    isDevelopment: process.env.NODE_ENV === "development",
    username: process.env.PILOT_ACCESS_USERNAME,
    password: process.env.PILOT_ACCESS_PASSWORD,
    authorizationHeader: request.headers.get("authorization"),
  });

  if (decision.kind === "allow") {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("Vary", "Authorization");
    return res;
  }

  if (decision.kind === "unavailable") {
    return new NextResponse(UNAVAILABLE_BODY, {
      status: 503,
      headers: {
        "Cache-Control": "private, no-store",
        Vary: "Authorization",
      },
    });
  }

  return new NextResponse(UNAUTHORIZED_BODY, {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="' + PILOT_AUTH_REALM + '", charset="UTF-8"',
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}

export const config = {
  matcher: [
    "/dashboard",
    "/dashboard/:path*",
    "/pipeline-check",
    "/pipeline-check/:path*",
    "/api/reporting",
    "/api/reporting/:path*",
    "/api/ai/reports",
    "/api/ai/reports/:path*",
    "/api/ai/worker/run",
    "/api/ai/worker/:path*",
    "/api/ai/settings",
    "/api/ai/settings/:path*",
    "/direct-entry",
    "/direct-entry/:path*",
    "/api/direct-entry",
    "/api/direct-entry/:path*",
  ],
};
