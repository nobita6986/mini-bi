/** Independent, small in-memory oracle for the locked F1.5 reporting rules. */
export const WORK_REPORT_ORACLE_FIXTURE = Object.freeze({
  obligations: Object.freeze([
    { id: "o1", assignee: "a1", team: "A", period: "2026-10-20", dueAt: "2026-10-21T16:59:59Z", submittedAt: "2026-10-21T16:59:59Z", late: false, exempted: false },
    { id: "o2", assignee: "a2", team: "A", period: "2026-10-20", dueAt: "2026-10-21T16:59:59Z", submittedAt: "2026-10-21T17:00:00Z", late: true, exempted: false },
    { id: "o3", assignee: "b1", team: "B", period: "2026-10-20", dueAt: "2026-10-21T16:59:59Z", submittedAt: null, late: false, exempted: false },
    { id: "o4", assignee: "a1", team: "B", period: "2026-10-21", dueAt: "2026-10-22T16:59:59Z", submittedAt: "2026-10-22T16:59:58Z", late: false, exempted: false },
    { id: "o5", assignee: "b1", team: "B", period: "2026-10-21", dueAt: "2026-10-22T16:59:59Z", submittedAt: null, late: false, exempted: false },
  ]),
  metrics: Object.freeze([
    { obligation: "o1", version: 1, key: "calls", unit: "call", group: "calls_v1", value: 10, isEligible: true, isFinal: true },
    { obligation: "o1", version: 1, key: "interested", unit: "person", group: "interested_v1", value: 1, isEligible: true, isFinal: true },
    { obligation: "o1", version: 1, key: "started", unit: "person", group: "started_v1", value: 2, isEligible: true, isFinal: true },
    { obligation: "o2", version: 1, key: "calls", unit: "call", group: "calls_v1", value: 20, isEligible: true, isFinal: true },
    { obligation: "o2", version: 1, key: "interested", unit: "person", group: "interested_v1", value: 9, isEligible: true, isFinal: true },
    { obligation: "o2", version: 1, key: "started", unit: "person", group: "started_v1", value: 18, isEligible: true, isFinal: true },
    { obligation: "o4", version: 2, key: "calls", unit: "call", group: "calls_v1", value: 0, isEligible: true, isFinal: true },
    { obligation: "o4", version: 2, key: "interested", unit: "person", group: "interested_v1", value: null, isEligible: true, isFinal: true },
    { obligation: "o4", version: 2, key: "calls", unit: "call", group: "calls_v2", value: 100, isEligible: true, isFinal: true },
    { obligation: "o4", version: 2, key: "calls", unit: "minute", group: "calls_minutes", value: 5, isEligible: true, isFinal: true },
    { obligation: "o4", version: 1, key: "calls", unit: "call", group: "calls_v1", value: 900, isEligible: false, isFinal: true },
    { obligation: "o4", version: 1, key: "calls", unit: "call", group: "calls_v1", value: 800, isEligible: true, isFinal: false },
  ]),
});

export function aggregateWorkReportFixture({ obligations, metrics }, { teamIds, from, to } = {}) {
  const visibleObligations = obligations.filter((row) =>
    (!teamIds || teamIds.includes(row.team)) && (!from || row.period >= from) && (!to || row.period <= to));
  const visibleIds = new Set(visibleObligations.map(({ id }) => id));
  const submitted = visibleObligations.filter(({ submittedAt }) => submittedAt !== null);
  const late = submitted.filter(({ late: isLate }) => isLate);
  const metricsByGroup = new Map();
  for (const row of metrics) {
    if (!visibleIds.has(row.obligation) || !row.isEligible || !row.isFinal) continue;
    const group = `${row.key}\u0000${row.unit}\u0000${row.group}`;
    const values = metricsByGroup.get(group) ?? [];
    values.push(row.value);
    metricsByGroup.set(group, values);
  }
  return {
    dueCount: visibleObligations.length,
    submittedCount: submitted.length,
    lateSubmittedCount: late.length,
    overdueMissingCount: visibleObligations.filter((row) => row.submittedAt === null && row.dueAt <= (to ? `${to}T23:59:59+07:00` : "9999-12-31T23:59:59+07:00")).length,
    completionRate: visibleObligations.length ? submitted.length / visibleObligations.length : null,
    metrics: [...metricsByGroup].map(([key, rawValues]) => {
      const [metricKey, unit, compatibleGroup] = key.split("\u0000");
      const values = rawValues.filter((value) => value !== null);
      return { metricKey, unit, compatibleGroup, sum: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
        avg: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        countValid: values.length };
    }).sort((a, b) => a.metricKey.localeCompare(b.metricKey) || a.unit.localeCompare(b.unit) || a.compatibleGroup.localeCompare(b.compatibleGroup)),
  };
}

export function localBusinessDate(instant) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
