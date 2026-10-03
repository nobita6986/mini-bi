import "server-only";

import { createAuthLogoutResponse } from "@/lib/auth/auth-session-core";
import { createAuthDependencies } from "@/lib/auth/auth-route-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createAuthLogoutResponse(request, createAuthDependencies());
}
