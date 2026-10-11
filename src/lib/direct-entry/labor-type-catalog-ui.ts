import type { DraftCatalogLaborType } from "./write-repository.ts";

export function sortedActiveLaborTypes(
  options: readonly DraftCatalogLaborType[] | undefined,
): DraftCatalogLaborType[] {
  return [...(options ?? [])].sort((left, right) =>
    left.sort_order - right.sort_order ||
    (left.display_name < right.display_name ? -1 : left.display_name > right.display_name ? 1 : 0));
}

export function activeLaborTypeLabel(
  options: readonly DraftCatalogLaborType[] | undefined,
  key: string,
): string | null {
  return options?.find((option) => option.labor_type_key === key)?.display_name ?? null;
}

export function firstActiveLaborTypeKey(
  options: readonly DraftCatalogLaborType[] | undefined,
): string {
  return sortedActiveLaborTypes(options)[0]?.labor_type_key ?? "";
}
