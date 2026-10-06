import "server-only";

import { createChangePasswordResponse } from "@/lib/auth/change-password-core";
import { createChangePasswordDependencies } from "@/lib/auth/change-password-route-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return createChangePasswordResponse(request, createChangePasswordDependencies());
}