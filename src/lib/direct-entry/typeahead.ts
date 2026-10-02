export interface TypeaheadOption {
  id: string;
  label: string;
  groupLabel: string;
}

export function matchTypeaheadIds(
  options: readonly TypeaheadOption[],
  query: string,
): string[] {
  const normalizedQuery = query.trim().normalize("NFC").toLocaleLowerCase("vi");
  if (!normalizedQuery) return options.map(({ id }) => id);

  return options
    .filter(({ label, groupLabel }) =>
      `${label} ${groupLabel}`.normalize("NFC").toLocaleLowerCase("vi").includes(normalizedQuery),
    )
    .map(({ id }) => id);
}

export type TypeaheadKeyAction = "up" | "down" | "commit" | "close" | "tab" | "ignore";

export function typeaheadKeyAction(key: string, isComposing: boolean): TypeaheadKeyAction | null {
  if (isComposing) return "ignore";
  switch (key) {
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "Enter": return "commit";
    case "Escape": return "close";
    case "Tab": return "tab";
    default: return null;
  }
}

export function moveTypeaheadIndex(index: number, count: number, direction: "up" | "down"): number {
  if (count === 0) return -1;
  if (direction === "down") return index < 0 ? 0 : (index + 1) % count;
  return index < 0 ? count - 1 : (index - 1 + count) % count;
}

export function resolveTypeaheadSelection(
  options: readonly TypeaheadOption[],
  optionId: string,
): string | null {
  return options.some(({ id }) => id === optionId) ? optionId : null;
}
