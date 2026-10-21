/** @param {string} query @param {string | null} [cursor] */
export function contributionPageUrl(query, cursor = null) {
  const params = new URLSearchParams(query);
  params.set("limit", "100");
  if (cursor) params.set("cursor", cursor);
  else params.delete("cursor");
  return `/api/work-reports/analytics/contributions?${params}`;
}

/** @template {{ obligation_id: string }} T @param {T[]} current @param {T[]} incoming @returns {T[]} */
export function appendUniqueContributions(current, incoming) {
  const seen = new Set(current.map((item) => item.obligation_id));
  return [...current, ...incoming.filter((item) => {
    if (seen.has(item.obligation_id)) return false;
    seen.add(item.obligation_id);
    return true;
  })];
}
