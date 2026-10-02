"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  matchTypeaheadIds,
  moveTypeaheadIndex,
  typeaheadKeyAction,
  type TypeaheadOption,
} from "@/lib/direct-entry/typeahead";

interface PickerOption extends TypeaheadOption {
  kind: "recruiter" | "team" | "bank";
}

// Synthetic stand-in for the server's already-active/effective projection.
const projectedOptions: readonly PickerOption[] = [
  { id: "synthetic-recruiter-hrp-1", label: "CongHr1", groupLabel: "HRP · Team Bắc", kind: "recruiter" },
  { id: "synthetic-recruiter-hrp-2", label: "CongHr2", groupLabel: "HRP · Team Nam", kind: "recruiter" },
  { id: "synthetic-recruiter-vendor-1", label: "ChungVendor", groupLabel: "Vendor · Team Bắc", kind: "recruiter" },
  { id: "synthetic-team-north", label: "Team Bắc", groupLabel: "Team", kind: "team" },
  { id: "synthetic-bank-north", label: "Ngân ha\u0300ng Bắc", groupLabel: "Bank", kind: "bank" },
];

export function TypeaheadPickerSmoke() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const composing = useRef(false);
  const inputId = "direct-entry-picker-smoke";
  const listId = `${inputId}-options`;
  const visibleIds = useMemo(
    () => matchTypeaheadIds(projectedOptions, query),
    [query],
  );
  const activeId = activeIndex < 0 ? undefined : visibleIds[activeIndex];

  const choose = (id: string) => {
    const option = projectedOptions.find((item) => item.id === id);
    if (!option) return;
    setSelectedId(id);
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
    <div>
      <label htmlFor={inputId}>Tìm recruiter, team hoặc ngân hàng</label>
      <input
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && activeId ? `${listId}-${encodeURIComponent(activeId)}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelectedId(null);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <span aria-live="polite">Selected ID: {selectedId ?? "none"}</span>
      {open && (
        <ul id={listId} role="listbox" aria-label="Matching records">
          {projectedOptions.filter(({ id }) => visibleIds.includes(id)).map((option) => (
            <li
              id={`${listId}-${encodeURIComponent(option.id)}`}
              key={option.id}
              role="option"
              aria-selected={activeId === option.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.id)}
            >
              <span>{option.label}</span>
              <span> — {option.groupLabel}</span>
              <span className="sr-only"> ({option.kind})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
