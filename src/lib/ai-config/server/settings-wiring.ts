import "server-only";

/**
 * P1.5-W04A — Wrapper CÓ KIỂU cho wiring settings (.mjs) để route Next không suy luận kiểu động.
 */

import type { SettingsService } from "../settings-service.ts";

import { createServerAiSettingsService } from "./settings.mjs";

export type SettingsWiring =
  | {
      ok: true;
      service: SettingsService;
      actor_ref: string;
      config_id: string;
      default_provider_profile: string;
    }
  | { ok: false; code: string; message: string };

export function createSettingsWiring(options: {
  env?: NodeJS.ProcessEnv;
  actor_ref?: string;
} = {}): SettingsWiring {
  return createServerAiSettingsService(options) as SettingsWiring;
}
