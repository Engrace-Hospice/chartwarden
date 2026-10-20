import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from "react";

import { t } from "../theme/tokens";
import { Button } from "./button";
import { LoadingSpinner } from "./loading-spinner";

export interface EntityLookupOption {
  id: string;
  label: ReactNode;
  searchLabel: string;
  description?: ReactNode;
  /** Optional opaque identifiers needed by a consuming workflow; never rendered by the lookup. */
  metadata?: Readonly<Record<string, string>>;
}

export interface EntityLookupLoadInput {
  query: string;
  cursor: string | null;
  limit: number;
}

export interface EntityLookupLoadResult {
  options: EntityLookupOption[];
  nextCursor?: string | null;
}

export interface EntityLookupFieldProps {
  label: ReactNode;
  value: string;
  onChange: (value: string, option: EntityLookupOption | null) => void;
  loadOptions: (input: EntityLookupLoadInput) => Promise<EntityLookupLoadResult>;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  valueLabel?: string;
  pageSize?: number;
  minQueryLength?: number;
  noMatchesContent?: ReactNode;

  /**
   * Keeps the existing lookup styling as the default. `modal` only increases
   * the popup's visual elevation, spacing and stacking for dense dialog flows.
   * Existing lookup consumers are therefore unchanged.
   */
  appearance?: "default" | "modal";
}

export function EntityLookupField({
  label,
  value,
  onChange,
  loadOptions,
  placeholder = "Search...",
  hint,
  error,
  required = false,
  disabled = false,
  clearable = true,
  valueLabel,
  pageSize = 25,
  minQueryLength = 0,
  noMatchesContent,
  appearance = "default",
}: EntityLookupFieldProps): JSX.Element {
  const generatedId = useId();
  const inputId = generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const listId = `${inputId}-list`;
  const labelId = `${inputId}-label`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const closeTimer = useRef<number | null>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<EntityLookupOption[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const display = open
    ? query
    : value
      ? ((selectedValue === value ? selectedLabel : null) ?? valueLabel ?? value)
      : "";

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const needle = query.trim();
      if (needle.length < minQueryLength) {
        setOptions([]);
        setNextCursor(null);
        setActiveIndex(-1);
        return;
      }

      if (append) setLoadingMore(true);
      else setLoading(true);
      setLoadError(null);

      try {
        const result = await loadOptions({
          query: needle,
          cursor,
          limit: pageSize,
        });
        setOptions((current) => (append ? [...current, ...result.options] : result.options));
        setNextCursor(result.nextCursor ?? null);
        if (!append) setActiveIndex(-1);
      } catch {
        setLoadError("Lookup unavailable.");
        if (!append) {
          setOptions([]);
          setActiveIndex(-1);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [loadOptions, minQueryLength, pageSize, query],
  );

  useEffect(() => {
    if (!open || disabled) return;
    const handle = window.setTimeout(() => {
      void load(null, false);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [disabled, load, open]);

  function focus(): void {
    if (disabled) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setOpen(true);
    setQuery("");
    setActiveIndex(-1);
  }

  function blur(): void {
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  }

  function select(option: EntityLookupOption): void {
    setSelectedLabel(option.searchLabel);
    setSelectedValue(option.id);
    onChange(option.id, option);
    setQuery(option.searchLabel);
    setOpen(false);
    setActiveIndex(-1);
    setHoveredId(null);
  }

  function clear(): void {
    setSelectedLabel(null);
    setSelectedValue(null);
    onChange("", null);
    setQuery("");
    setOptions([]);
    setNextCursor(null);
    setOpen(false);
    setActiveIndex(-1);
    setHoveredId(null);
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation(); // dismiss the listbox only, not an enclosing modal
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (options.length > 0) {
        setActiveIndex((current) => Math.min(current + 1, options.length - 1));
      }
      return;
    }

    if (event.key === "ArrowUp" && open && options.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current <= 0 ? options.length - 1 : current - 1));
      return;
    }

    if (event.key === "Enter" && open && activeIndex >= 0 && options[activeIndex]) {
      event.preventDefault();
      select(options[activeIndex]!);
    }
  }

  return (
    <label
      htmlFor={inputId}
      className="wx-field"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: t.space2,
        color: t.onSurface,
      }}
    >
      <span id={labelId} style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </span>

      <span style={shellStyle}>
        <input
          id={inputId}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            appearance === "modal" && open && activeIndex >= 0
              ? `${listId}-option-${activeIndex}`
              : undefined
          }
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          required={required}
          disabled={disabled}
          autoComplete="off"
          value={display}
          placeholder={placeholder}
          onFocus={focus}
          onBlur={blur}
          onKeyDown={appearance === "modal" ? onInputKeyDown : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(-1);
            if (value) {
              setSelectedLabel(null);
              setSelectedValue(null);
              onChange("", null);
            }
            if (!open) setOpen(true);
          }}
          style={inputStyle(Boolean(error), open, appearance)}
        />

        {clearable && value && !disabled ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
            aria-label="Clear selection"
            style={clearStyle(appearance)}
          >
            {appearance === "modal" ? "×" : "x"}
          </button>
        ) : null}

        {open ? (
          // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the combobox input; option buttons are intentionally removed from the tab order
          <span
            // biome-ignore lint/a11y/useSemanticElements: <select>/<option> cannot hold a search field's async, richly-formatted results (ARIA 1.2 combobox popup pattern)
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            style={popoverStyle(appearance)}
          >
            {loading ? (
              <span style={stateStyle(appearance)}>
                <LoadingSpinner />
                {appearance === "modal" ? <span>Searching…</span> : null}
              </span>
            ) : loadError ? (
              <span role="alert" style={{ ...stateStyle(appearance), color: t.error }}>
                {loadError}
              </span>
            ) : options.length === 0 ? (
              noMatchesContent ? (
                <span style={stateStyle(appearance)}>{noMatchesContent}</span>
              ) : (
                <span style={stateStyle(appearance)}>No matches</span>
              )
            ) : (
              options.map((option, index) => {
                const selected = option.id === value;
                const active = index === activeIndex || option.id === hoveredId;
                return (
                  <button
                    id={`${listId}-option-${index}`}
                    key={option.id}
                    // biome-ignore lint/a11y/useSemanticElements: an <option> element cannot carry the description markup or the click behaviour these rows have
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    onMouseEnter={() => {
                      if (appearance === "modal") {
                        setHoveredId(option.id);
                        setActiveIndex(index);
                      }
                    }}
                    onMouseLeave={() => {
                      if (appearance === "modal") setHoveredId(null);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(option)}
                    style={optionStyle(appearance, selected, active)}
                  >
                    <span style={optionTopLine}>
                      <span style={{ fontWeight: 650, color: t.onSurface }}>{option.label}</span>
                      {selected ? (
                        <span aria-hidden="true" style={selectedMarkStyle}>
                          ✓
                        </span>
                      ) : null}
                    </span>
                    {option.description ? (
                      <span
                        style={{
                          color: t.onSurfaceVariant,
                          fontSize: "0.75rem",
                          lineHeight: 1.4,
                        }}
                      >
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}

            {nextCursor ? (
              <span style={{ padding: t.space2 }}>
                <Button
                  type="button"
                  size="sm"
                  tone="secondary"
                  loading={loadingMore}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void load(nextCursor, true)}
                >
                  Load more
                </Button>
              </span>
            ) : null}
          </span>
        ) : null}
      </span>

      {hint && !error ? (
        <span id={hintId} style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" style={{ color: t.error, fontSize: "0.75rem" }}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

const shellStyle: CSSProperties = {
  position: "relative",
  display: "block",
  minWidth: 0,
  overflow: "visible",
};

const inputStyle = (
  invalid: boolean,
  open: boolean,
  appearance: "default" | "modal",
): CSSProperties => {
  if (appearance === "default") {
    return {
      width: "100%",
      minHeight: "2.5rem",
      padding: "0.5rem 2rem 0.5rem 0.75rem",
      border: `1px solid ${invalid ? t.error : t.outlineVariant}`,
      borderRadius: t.radiusLg,
      background: t.surfaceLow,
      color: t.onSurface,
      fontFamily: t.fontSans,
    };
  }

  return {
    width: "100%",
    minHeight: "2.75rem",
    padding: "0.6rem 2.15rem 0.6rem 0.75rem",
    border: `1px solid ${invalid ? t.error : open ? t.primary : t.outlineVariant}`,
    borderRadius: t.radiusLg,
    background: t.surface,
    color: t.onSurface,
    fontFamily: t.fontSans,
    fontSize: "0.875rem",
    outline: "none",
    boxShadow:
      open && !invalid ? `0 0 0 3px color-mix(in srgb, ${t.primary} 13%, transparent)` : "none",
  };
};

const clearStyle = (appearance: "default" | "modal"): CSSProperties => ({
  position: "absolute",
  right: "0.45rem",
  top: appearance === "modal" ? "0.58rem" : "0.45rem",
  display: appearance === "modal" ? "grid" : undefined,
  width: "1.5rem",
  height: "1.5rem",
  placeItems: appearance === "modal" ? "center" : undefined,
  padding: appearance === "modal" ? 0 : undefined,
  border: "none",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  cursor: "pointer",
  fontSize: appearance === "modal" ? "1rem" : undefined,
  lineHeight: appearance === "modal" ? 1 : undefined,
});

const popoverStyle = (appearance: "default" | "modal"): CSSProperties => ({
  position: "absolute",
  zIndex: appearance === "modal" ? 120 : 30,
  top: appearance === "modal" ? "calc(100% + 0.35rem)" : "calc(100% + 0.25rem)",
  left: 0,
  right: 0,
  display: "flex",
  flexDirection: "column",
  maxHeight: appearance === "modal" ? "20rem" : "18rem",
  overflowY: "auto",
  overscrollBehavior: appearance === "modal" ? "contain" : undefined,
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: appearance === "modal" ? t.radiusLg : t.radiusMd,
  background: t.surface,
  boxShadow: t.shadowFloat,
});

const optionStyle = (
  appearance: "default" | "modal",
  selected: boolean,
  active: boolean,
): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: appearance === "modal" ? "0.25rem" : "0.15rem",
  width: "100%",
  padding: appearance === "modal" ? "0.7rem 0.8rem" : "0.55rem 0.7rem",
  border: "none",
  borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 45%, transparent)`,
  background: selected
    ? t.primaryTint
    : appearance === "modal" && active
      ? t.surfaceContainer
      : "transparent",
  color: appearance === "modal" ? t.onSurface : undefined,
  textAlign: "left",
  cursor: "pointer",
  fontFamily: appearance === "modal" ? t.fontSans : undefined,
});

const optionTopLine: CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.65rem",
};

const selectedMarkStyle: CSSProperties = {
  flex: "0 0 auto",
  color: t.primary,
  fontWeight: 800,
};

const stateStyle = (appearance: "default" | "modal"): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: "0.55rem",
  minHeight: appearance === "modal" ? "3rem" : "2.5rem",
  padding: appearance === "modal" ? "0.75rem 0.8rem" : "0.6rem 0.75rem",
  color: t.onSurfaceVariant,
  fontSize: "0.8125rem",
});
