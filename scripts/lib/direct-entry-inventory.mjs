/**
 * Derive the expected public.direct_entry_* function names from the local migration set.
 * Functions dropped by a later statement are removed so the live comparison stays strict.
 */
export function expectedDirectEntryFunctions(migrations) {
  const names = new Set();
  for (const { sql } of migrations) {
    const code = sql.split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
    for (const match of code.matchAll(/function public\.(direct_entry_[a-z0-9_]+)\s*\(/gi)) names.add(match[1]);
    for (const match of code.matchAll(/drop function(?: if exists)? public\.(direct_entry_[a-z0-9_]+)/gi)) {
      names.delete(match[1]);
    }
  }
  return names;
}