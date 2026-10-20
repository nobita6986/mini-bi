export type OptionalActionReason = { ok: true; value: string | null } | { ok: false };

export function hasExactKeysWithOptionalReason(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) &&
    keys.every((key) => key === "reason" || Object.prototype.hasOwnProperty.call(value, key));
}

export function projectOptionalActionReason(value: unknown, maxLength = 4000): OptionalActionReason {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > maxLength) return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed === "" ? null : trimmed };
}
