/**
 * P1.5-W04A — Test double cho ConfigStore (mirror semantics RPC: OCC + audit cùng mutation + một active).
 * R1 (C): mọi hàm đọc trả StoreRead { ok:true, config } | { ok:false, code } — hỗ trợ inject lỗi đọc
 * để chứng minh lỗi hạ tầng KHÔNG bị biến thành "không có cấu hình".
 */

import { projectConfig } from "../config-contract.ts";

export function createMemoryConfigStore(options = {}) {
  const versions = new Map();
  const audit = [];
  const state = { current: null };

  const read = (config) => {
    if (options.readFailure) return { ...options.readFailure };
    return { ok: true, config };
  };

  return {
    versions,
    audit,
    get current() {
      return state.current;
    },
    async readCurrent() {
      return read(state.current);
    },
    async readVersion(_configId, version) {
      return read(versions.get(version) ?? null);
    },
    async readActiveProjection() {
      if (options.readFailure) return { ...options.readFailure };
      const active = [...versions.values()].find((row) => row.status === "active");
      return {
        ok: true,
        config: active
          ? {
              config_id: active.config_id,
              provider_profile: active.provider_profile,
              model: active.model,
              version: active.version,
              status: active.status,
              verified_at: active.verified_at,
              sanitized_host: active.sanitized_host,
            }
          : null,
      };
    },
    async saveVersion({ expected_version, config, actor, action }) {
      const maxVersion = versions.size === 0 ? null : Math.max(...versions.keys());
      if (maxVersion !== expected_version) {
        audit.push({ event_type: "config_mutation_rejected", outcome: "failure", reason_code: "version_conflict", actor_ref: actor, version: maxVersion ?? 0 });
        return { ok: false, code: "VERSION_CONFLICT", message: "cấu hình đã thay đổi" };
      }
      versions.set(config.version, config);
      state.current = config;
      audit.push({
        event_type: action,
        outcome: "success",
        reason_code: "ok",
        actor_ref: actor,
        version: config.version,
        provider_profile: config.provider_profile,
        sanitized_host: config.sanitized_host,
        model: config.model,
        key_fingerprint: config.key_fingerprint,
      });
      return { ok: true, config };
    },
    async recordTest({ config_id, version, success, actor, reason_code }) {
      const target = versions.get(version);
      if (!target) return { ok: false, code: "NOT_FOUND", message: "không tìm thấy version" };
      const next = {
        ...target,
        status: target.status === "active" ? "active" : success ? "verified" : "test_failed",
        verified_at: target.status === "active" ? target.verified_at : success ? "2026-10-02T00:00:00.000Z" : null,
        updated_at: "2026-10-02T00:00:00.000Z",
      };
      versions.set(version, next);
      state.current = next;
      audit.push({ event_type: "connection_tested", outcome: success ? "success" : "failure", reason_code, actor_ref: actor, version, config_id });
      return { ok: true, config: next };
    },
    async activate({ config_id, version, actor }) {
      const target = versions.get(version);
      if (!target) return { ok: false, code: "NOT_FOUND", message: "không tìm thấy version" };
      if (target.status !== "verified" || !target.verified_at) {
        audit.push({ event_type: "config_mutation_rejected", outcome: "failure", reason_code: "not_verified", actor_ref: actor, version });
        return { ok: false, code: "NOT_VERIFIED", message: "chưa verified" };
      }
      for (const [otherVersion, other] of versions) {
        if (other.status === "active" && otherVersion !== version) {
          versions.set(otherVersion, { ...other, status: "disabled" });
          audit.push({ event_type: "config_disabled", outcome: "success", reason_code: "superseded", actor_ref: actor, version: otherVersion, config_id });
        }
      }
      const next = { ...target, status: "active" };
      versions.set(version, next);
      state.current = next;
      audit.push({ event_type: "config_activated", outcome: "success", reason_code: "ok", actor_ref: actor, version, config_id });
      return { ok: true, config: next };
    },
    async disable({ config_id, version, actor }) {
      const target = versions.get(version);
      if (!target) return { ok: false, code: "NOT_FOUND", message: "không tìm thấy version" };
      const next = { ...target, status: "disabled" };
      versions.set(version, next);
      state.current = next;
      audit.push({ event_type: "config_disabled", outcome: "success", reason_code: "owner_disabled", actor_ref: actor, version, config_id });
      return { ok: true, config: next };
    },
    async recordRejected({ config_id, version, actor, reason_code }) {
      audit.push({ event_type: "config_mutation_rejected", outcome: "failure", reason_code, actor_ref: actor, version, config_id });
      return { ok: true };
    },
    projectionOf(config) {
      return projectConfig(config);
    },
  };
}
