import "server-only";

import { getDirectEntryActor } from "@/lib/auth/direct-entry-session";
import { createDirectEntryActorRepository } from "@/lib/direct-entry/actor-context-repository";
import {
  createProvinceCatalog,
  listProvincesCatalog,
} from "@/lib/recruitment-locations/location-catalog-api";
import { createLocationCatalogRepository } from "@/lib/recruitment-locations/location-catalog-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GATE = () =>
  Response.json(
    { ok: false, code: "NOT_FOUND" },
    {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    },
  );

const dependencies = {
  resolveSession: () => getDirectEntryActor(createDirectEntryActorRepository()),
  repository: createLocationCatalogRepository(),
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return listProvincesCatalog(request, "true", dependencies);
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.DIRECT_ENTRY_API_ENABLED !== "true") return GATE();
  return createProvinceCatalog(request, "true", dependencies);
}
