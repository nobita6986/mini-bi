"use client";

import { useMemo, useState, type KeyboardEvent } from "react";

import { filterCatalogSearchOptions } from "@/lib/direct-entry/catalog-search";
import { moveTypeaheadIndex, typeaheadKeyAction } from "@/lib/direct-entry/typeahead";

export type CatalogFilterOption = { id: string; label: string; keywords?: string };

const inputClass =
  "h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30";

/** Searchable single-select; only the stable catalog id is committed as a filter. */
export function CatalogFilterCombobox({
  id, label, allLabel, placeholder, options, value, disabled = false, onChange,
  containerClassName = "relative flex min-w-0 flex-col gap-1 text-sm",
  labelClassName = "font-medium text-muted",
  inputClassName = inputClass,
}: {
  id: string;
  label: string;
  allLabel: string;
  placeholder: string;
  options: readonly CatalogFilterOption[];
  value: string;
  disabled?: boolean;
  onChange: (nextValue: string) => void;
  containerClassName?: string;
  labelClassName?: string;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = id + "-listbox";
  const entries = useMemo<CatalogFilterOption[]>(
    () => [{ id: "", label: allLabel }, ...options],
    [allLabel, options],
  );
  const visible = useMemo(() => filterCatalogSearchOptions(entries, query), [entries, query]);
  const activeId = activeIndex >= 0 && activeIndex < visible.length ? visible[activeIndex].id : undefined;
  const selectedLabel = value === "" ? ""
    : (options.find((option) => option.id === value)?.label ?? "");

  const choose = (nextValue: string) => {
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
    onChange(nextValue);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = typeaheadKeyAction(event.key, event.nativeEvent.isComposing);
    if (action === null || action === "ignore") return;
    if (action === "up" || action === "down") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => moveTypeaheadIndex(index, visible.length, action));
    } else if (action === "commit") {
      if (activeId !== undefined) {
        event.preventDefault();
        choose(activeId);
      }
    } else if (action === "close" || action === "tab") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className={containerClassName}>
      <label htmlFor={id} className={labelClassName}>{label}</label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && activeId !== undefined
          ? listId + "-" + encodeURIComponent(activeId) : undefined}
        className={inputClassName}
        placeholder={placeholder}
        disabled={disabled}
        value={open ? query : selectedLabel}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onFocus={() => { setQuery(""); setOpen(true); setActiveIndex(-1); }}
        onKeyDown={onKeyDown}
        onBlur={() => { setOpen(false); setActiveIndex(-1); }}
      />
      {open ? (
        <ul id={listId} role="listbox" aria-label={label + " — gợi ý"}
          className="absolute top-full z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg">
          {visible.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-muted">Không có kết quả phù hợp</li>
          ) : visible.map((option) => (
            <li
              key={option.id === "" ? "__all__" : option.id}
              id={listId + "-" + encodeURIComponent(option.id)}
              role="option"
              aria-selected={activeId === option.id}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-surface-hover aria-selected:bg-surface-hover"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.id)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
