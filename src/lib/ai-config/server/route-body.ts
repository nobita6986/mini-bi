import "server-only";

/**
 * P1.5-W04A-R1 — Wrapper CÓ KIỂU cho đọc body settings (module .mjs) để route Next narrow được union.
 */

import { readSettingsBody, readBoundedBodyBytes } from "./route-helpers.mjs";

export type SettingsBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string };

export type BoundedBodyResult =
  | { ok: true; bytes: number }
  | { ok: false; code: string; message: string };

export function readSettingsJsonBody(request: Request): Promise<SettingsBodyResult> {
  return readSettingsBody(request) as Promise<SettingsBodyResult>;
}

export function readSettingsRawBody(request: Request): Promise<BoundedBodyResult> {
  return readBoundedBodyBytes(request) as Promise<BoundedBodyResult>;
}
