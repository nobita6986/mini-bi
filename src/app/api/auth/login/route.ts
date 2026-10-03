import "server-only";

import { createAuthLoginResponse } from "@/lib/auth/auth-session-core";
import { createAuthDependencies } from "@/lib/auth/auth-route-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createAuthLoginResponse(request, createAuthDependencies());
}
