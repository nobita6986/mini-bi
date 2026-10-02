"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  matchTypeaheadIds,
  moveTypeaheadIndex,
  resolveTypeaheadSelection,
  typeaheadKeyAction,
  type TypeaheadOption,
} from "@/lib/direct-entry/typeahead";

export interface PickerOption extends TypeaheadOption {
  provider: string;
  team: string;
}

const smokeOptions: readonly PickerOption[] = [
  { id: "synthetic-recruiter-hrp-1", label: "CongHr1", groupLabel: "HRP · Team Bắc", provider: "HRP", team: "Bắc" },
  { id: "synthetic-recruiter-hrp-2", label: "CongHr2", groupLabel: "HRP · Team Nam", provider: "HRP", team: "Nam" },
  { id: "synthetic-recruiter-vendor-1", label: "ChungVendor", groupLabel: "Vendor · Team Bắc", provider: "Vendor", team: "Bắc" },
];

export function RecruiterTypeahead({
  id,
  options,
  value,
  onChange,
  label = "Người tuyển",
  disabled = false,
}: {
  id: string;
  options: readonly PickerOption[];
  value: string;
  onChange: (recruiterId: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const selectedLabel = options.find((option) => option.id === value)?.label ?? "";
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const composing = useRef(false);
  const editingQuery = useRef(false);
  const listId = `${id}-options`;
  const visibleIds = useMemo(() => matchTypeaheadIds(options, query), [options, query]);
  const activeId = activeIndex < 0 ? undefined : visibleIds[activeIndex];

  useEffect(() => {
    if (!editingQuery.current) setQuery(selectedLabel);
  }, [selectedLabel, value]);

  const choose = (optionId: string) => {
    const stableId = resolveTypeaheadSelection(options, optionId);
    if (stableId === null) return;
    const option = options.find(({ id: optionKey }) => optionKey === stableId);
    if (!option) return;
    editingQuery.current = false;
    onChange(stableId);
    setQuery(option.label);
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = typeaheadKeyAction(
      event.key,
      event.nativeEvent.isComposing || composing.current,
    );
    if (action === "ignore" || action === null) return;
    if (action === "up" || action === "down") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => moveTypeaheadIndex(index, visibleIds.length, action));
    } else if (action === "commit" && activeId) {
      event.preventDefault();
      choose(activeId);
    } else if (action === "close" || action === "tab") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="relative">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        disabled={disabled}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && activeId ? `${listId}-${encodeURIComponent(activeId)}` : undefined}
        value={query}
        onChange={(event) => {
          editingQuery.current = true;
          setQuery(event.target.value);
          setActiveIndex(-1);
          setOpen(true);
          onChange("");
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setQuery(event.currentTarget.value);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={`${label} — gợi ý`}>
          {options.filter(({ id: optionId }) => visibleIds.includes(optionId)).map((option) => (
            <li
              id={`${listId}-${encodeURIComponent(option.id)}`}
              key={option.id}
              role="option"
              aria-selected={activeId === option.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.id)}
            >
              <span>{option.label}</span>
              <span> — {option.provider} · Team {option.team}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TypeaheadPickerSmoke() {
  const [selectedId, setSelectedId] = useState("");
  return (
    <div>
      <RecruiterTypeahead
        id="direct-entry-picker-smoke"
        label="Tìm recruiter"
        options={smokeOptions}
        value={selectedId}
        onChange={setSelectedId}
      />
      <span aria-live="polite">Selected ID: {selectedId || "none"}</span>
    </div>
  );
}
