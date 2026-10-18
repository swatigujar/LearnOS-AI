"use client";

import { ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { nextSelectIndex, placeSelectMenu } from "@/lib/select-navigation";

export type SelectOption = { value: string; label: string };

/** Compact, scrollable select used by Practice forms where native option popups can obscure the page. */
export function Select({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  className = "",
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef("");
  const typeaheadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setMenuStyle({
        position: "fixed",
        ...placeSelectMenu(rect, { width: window.innerWidth, height: window.innerHeight }),
      });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => () => {
    if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
  }, []);

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onValueChange(option.value);
    setActiveIndex(index);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || !options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setActiveIndex(selectedIndex);
        setOpen(true);
      } else {
        setActiveIndex((index) => nextSelectIndex(index, event.key as "ArrowDown" | "ArrowUp", options.length));
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => nextSelectIndex(index, event.key as "Home" | "End", options.length));
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && open) {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      typeahead.current += event.key.toLocaleLowerCase();
      if (typeaheadTimer.current) clearTimeout(typeaheadTimer.current);
      typeaheadTimer.current = setTimeout(() => { typeahead.current = ""; }, 700);
      const match = options.findIndex((option) => option.label.toLocaleLowerCase().startsWith(typeahead.current));
      if (match >= 0) {
        setActiveIndex(match);
        setOpen(true);
      }
    }
  }

  return (
    <div className={`relative w-full min-w-0 ${className}`} ref={rootRef}>
      <button
        aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        aria-controls={`${id}-listbox`}
        className="flex min-h-11 w-full min-w-0 items-center justify-between gap-3 rounded-md border border-[#EEE5E0] bg-white px-3 py-2 text-left text-sm font-medium text-[#4A285F] outline-none hover:border-[#aebdb2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#642BD8] disabled:cursor-not-allowed disabled:bg-[#F2ECFF] disabled:text-[#858398]"
        disabled={disabled}
        onClick={() => { setActiveIndex(selectedIndex); setOpen((current) => !current); }}
        onKeyDown={onKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className="min-w-0 truncate" title={selected?.label ?? ""}>{selected?.label ?? "Choose an option"}</span>
        <ChevronDown aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} size={16} />
      </button>
      {open && options.length > 0 && menuStyle && typeof document !== "undefined" && createPortal(
        <div
          className="z-[1000] overflow-y-auto overscroll-contain rounded-md border border-[#EEE5E0] bg-white p-1 shadow-lg"
          id={`${id}-listbox`}
          ref={listRef}
          role="listbox"
          aria-label={label}
          style={menuStyle}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {options.map((option, index) => (
            <div
              aria-selected={option.value === value}
              className={`cursor-pointer rounded px-3 py-2 text-sm leading-5 text-[#424158] focus:outline-none ${index === activeIndex ? "bg-[#F2ECFF] text-[#642BD8]" : "hover:bg-[#F2ECFF]"} ${option.value === value ? "font-semibold" : ""}`}
              data-option-index={index}
              id={`${id}-option-${index}`}
              key={`${option.value}-${index}`}
              onClick={() => choose(index)}
              onMouseEnter={() => setActiveIndex(index)}
              role="option"
              title={option.label}
            >
              <span className="block break-words">{option.label}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
