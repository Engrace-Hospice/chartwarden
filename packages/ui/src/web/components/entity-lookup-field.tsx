import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { t } from "../theme/tokens";
import { Button } from "./button";
import { LoadingSpinner } from "./loading-spinner";

export interface EntityLookupOption {
  id: string;
  label: ReactNode;
  searchLabel: string;
  description?: ReactNode;
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
}: EntityLookupFieldProps): JSX.Element {
  const generatedId = useId();
  const inputId = generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const listId = `${inputId}-list`;
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

  const display = open
    ? query
    : value
      ? (valueLabel ?? (selectedValue === value ? selectedLabel : null) ?? value)
      : "";

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const needle = query.trim();
      if (needle.length < minQueryLength) {
        setOptions([]);
        setNextCursor(null);
        return;
      }
      if (append) setLoadingMore(true);
      else setLoading(true);
      setLoadError(null);
      try {
        const result = await loadOptions({ query: needle, cursor, limit: pageSize });
        setOptions((current) => (append ? [...current, ...result.options] : result.options));
        setNextCursor(result.nextCursor ?? null);
      } catch {
        setLoadError("Lookup unavailable.");
        if (!append) setOptions([]);
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
  }

  function clear(): void {
    setSelectedLabel(null);
    setSelectedValue(null);
    onChange("", null);
    setQuery("");
    setOptions([]);
    setNextCursor(null);
    setOpen(false);
  }

  return (
    <label
      htmlFor={inputId}
      className="wx-field"
      style={{ display: "flex", flexDirection: "column", gap: t.space2, color: t.onSurface }}
    >
      <span style={{ fontSize: "0.8125rem", fontWeight: 650 }}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </span>
      <span style={shellStyle}>
        <input
          id={inputId}
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          required={required}
          disabled={disabled}
          value={display}
          placeholder={placeholder}
          onFocus={focus}
          onBlur={blur}
          onChange={(event) => {
            setQuery(event.target.value);
            if (value) {
              setSelectedLabel(null);
              setSelectedValue(null);
              onChange("", null);
            }
            if (!open) setOpen(true);
          }}
          style={inputStyle(Boolean(error))}
        />
        {clearable && value && !disabled ? (
          <button type="button" onClick={clear} aria-label="Clear selection" style={clearStyle}>
            x
          </button>
        ) : null}
        {open ? (
          <span id={listId} style={popoverStyle}>
            {loading ? (
              <span style={stateStyle}>
                <LoadingSpinner />
              </span>
            ) : loadError ? (
              <span role="alert" style={{ ...stateStyle, color: t.error }}>
                {loadError}
              </span>
            ) : options.length === 0 ? (
              <span style={stateStyle}>No matches</span>
            ) : (
              options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-selected={option.id === value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(option)}
                  style={{
                    ...optionStyle,
                    background: option.id === value ? t.primaryTint : "transparent",
                  }}
                >
                  <span style={{ fontWeight: 650, color: t.onSurface }}>{option.label}</span>
                  {option.description ? (
                    <span style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>
                      {option.description}
                    </span>
                  ) : null}
                </button>
              ))
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
};

const inputStyle = (invalid: boolean): CSSProperties => ({
  width: "100%",
  minHeight: "2.5rem",
  padding: "0.5rem 2rem 0.5rem 0.75rem",
  border: `1px solid ${invalid ? t.error : t.outlineVariant}`,
  borderRadius: t.radiusLg,
  background: t.surfaceLow,
  color: t.onSurface,
  fontFamily: t.fontSans,
});

const clearStyle: CSSProperties = {
  position: "absolute",
  right: "0.45rem",
  top: "0.45rem",
  width: "1.5rem",
  height: "1.5rem",
  border: "none",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  cursor: "pointer",
};

const popoverStyle: CSSProperties = {
  position: "absolute",
  zIndex: 30,
  top: "calc(100% + 0.25rem)",
  left: 0,
  right: 0,
  display: "flex",
  flexDirection: "column",
  maxHeight: "18rem",
  overflowY: "auto",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: t.radiusMd,
  background: t.surface,
  boxShadow: "0 1rem 2.5rem rgba(15, 23, 42, 0.18)",
};

const optionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  width: "100%",
  padding: "0.55rem 0.7rem",
  border: "none",
  borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 45%, transparent)`,
  textAlign: "left",
  cursor: "pointer",
};

const stateStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minHeight: "2.5rem",
  padding: "0.6rem 0.75rem",
  color: t.onSurfaceVariant,
  fontSize: "0.8125rem",
};
