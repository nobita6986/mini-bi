/**
 * Derive the expected public.direct_entry_* function names from the local migration set.
 * Functions dropped by a later statement are removed so the live comparison stays strict.
 * Adds and drops are applied in source order, so a migration that drops a signature and
 * re-creates the same name (P2.5-HF-R1 #59 redefines the rehire lookup) stays declared.
 */
export function expectedDirectEntryFunctions(migrations) {
  const names = new Set();
  for (const { sql } of migrations) {
    const code = sql.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
    const events = [];
    // Only a declaration counts as an add; a bare reference (grant/revoke/comment/execute)
    // must never re-declare a function that a drop already removed.
    for (const match of code.matchAll(
      /\bcreate\b[^;]{0,120}?\bfunction\s+public\.(direct_entry_[a-z0-9_]+)\s*\(/gi)) {
      events.push([match.index, true, match[1]]);
    }
    // A W07B/W07C style "alter function ... rename to direct_entry_x" also declares the name.
    for (const match of code.matchAll(/\brename\s+to\s+(direct_entry_[a-z0-9_]+)/gi)) {
      events.push([match.index, true, match[1]]);
    }
    for (const match of code.matchAll(/drop function(?: if exists)? public\.(direct_entry_[a-z0-9_]+)/gi)) {
      events.push([match.index, false, match[1]]);
    }
    events.sort((left, right) => left[0] - right[0]);
    for (const [, declares, name] of events) {
      if (declares) names.add(name);
      else names.delete(name);
    }
  }
  return names;
}