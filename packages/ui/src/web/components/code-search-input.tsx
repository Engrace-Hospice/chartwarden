// CodeSearchInput — the one type-ahead for clinical and billing codes (ICD-10, SNOMED CT, LOINC, CARC,
// RARC, RxNorm …). It searches the M38 terminology catalog by code OR description and returns the chosen
// code plus its display text.
//
// Honest degradation. The M38 catalog only answers for systems an operator has loaded (SNOMED CT and LOINC
// need a licence attestation; CARC/RARC are admin uploads). When a search finds nothing — or the search
// route is down — the field offers a clearly labelled "use as entered" row instead of blocking the user.
// An entered code is checked through `/validate` and the field says plainly whether the catalog confirmed
// it ("Verified"), did not know it ("Not found … saved as entered"), or could not be reached. Set
// `allowUnverified={false}` where an unknown code must not be accepted.
//
// Only the typed code or term goes into the request URL — never patient data.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from "react";

import { useApiClient } from "../../core/api/provider";
import { t } from "../theme/tokens";
import { CODE_SYSTEM_LABEL, conceptLabel, normalizeCode, rankConcepts } from "./code-search-model";
import type { CodeSearchConcept, CodeSearchSystem } from "./code-search-model";
import { LoadingSpinner } from "./loading-spinner";

export type { CodeSearchSystem } from "./code-search-model";

const SEARCH_DEBOUNCE_MS = 250;
const DEFAULT_LIMIT = 10;
const MAX_QUERY_LENGTH = 100;

type SearchStatus = "idle" | "loading" | "ready" | "error";
type Verification = "none" | "checking" | "verified" | "unknown" | "unavailable";

export interface CodeSearchInputProps {
  label: ReactNode;
  system: CodeSearchSystem;
  /** The selected code, or "" when nothing is selected. */
  value: string;
  /** Called with the chosen code and its display text; `("", "")` when the field is cleared. */
  onChange: (code: string, display: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** ICD-10-CM only: limit results to billable (leaf) codes. */
  billableOnly?: boolean;
  /** Restrict results to a platform value set (e.g. `sud_test_loinc`). */
  inValueSet?: string;
  /** Display text for `value` when the caller already has it (skips the one-off lookup). */
  valueDisplay?: string;
  /** Accept a code the catalog does not know (default true; it is labelled "saved as entered"). */
  allowUnverified?: boolean;
  limit?: number;
}

interface SearchPayload {
  results?: CodeSearchConcept[];
}

function useLiveRef<T>(value: T): { current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function CodeSearchInput({
  label,
  system,
  value,
  onChange,
  placeholder,
  hint,
  error,
  required = false,
  disabled = false,
  billableOnly,
  inValueSet,
  valueDisplay,
  allowUnverified = true,
  limit = DEFAULT_LIMIT,
}: CodeSearchInputProps): JSX.Element {
  const client = useApiClient();
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const statusId = `${baseId}-status`;
  const hintId = `${baseId}-hint`;
  const errorId = `${baseId}-error`;
  const systemName = CODE_SYSTEM_LABEL[system];

  const [text, setText] = useState(value);
  const [display, setDisplay] = useState(valueDisplay ?? "");
  const [open, setOpen] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<CodeSearchConcept[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [verification, setVerification] = useState<Verification>("none");

  const requestSeq = useRef(0);
  const verifySeq = useRef(0);
  const lastEmitted = useRef(value);
  const onChangeRef = useLiveRef(onChange);

  const selectedLabel = value ? conceptLabel(value, display) : "";
  const showManualRow =
    allowUnverified &&
    text.trim() !== "" &&
    text.trim() !== selectedLabel &&
    (searchStatus === "error" ||
      (searchStatus === "ready" &&
        !results.some((r) => r.code.toLowerCase() === text.trim().toLowerCase())));
  const optionCount = results.length + (showManualRow ? 1 : 0);

  // Follow the parent: it may set or reset `value` (edit modal opening, form reset after save).
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setText(value);
    setDisplay(valueDisplay ?? "");
    setVerification("none");
    setResults([]);
    setSearchStatus("idle");
  }, [value, valueDisplay]);

  // A pre-filled code (edit mode) shows its description once the catalog resolves it. Best effort.
  useEffect(() => {
    if (!value || display) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.GET("/api/v1/terminology/{system}/{code}", {
          params: { path: { system, code: value } },
        } as never);
        const concept = (res as { data?: CodeSearchConcept } | undefined)?.data;
        if (!cancelled && concept?.display) {
          setDisplay(concept.display);
          setText(conceptLabel(value, concept.display));
        }
      } catch {
        // The code alone is a fine label; a failed description lookup must not surface as an error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, system, value, display]);

  const runSearch = useCallback(
    async (needle: string): Promise<void> => {
      const seq = ++requestSeq.current;
      setSearchStatus("loading");
      try {
        const res = (await client.GET("/api/v1/terminology/{system}/search", {
          params: {
            path: { system },
            query: {
              q: needle,
              mode: "fuzzy",
              limit,
              ...(billableOnly ? { billableOnly: true } : {}),
              ...(inValueSet ? { inValueSet } : {}),
            },
          },
        } as never)) as { data?: SearchPayload; error?: unknown } | undefined;
        if (seq !== requestSeq.current) return;
        if (!res || res.error) {
          setResults([]);
          setSearchStatus("error");
          return;
        }
        setResults(rankConcepts(needle, res.data?.results ?? []));
        setActiveIndex(-1);
        setSearchStatus("ready");
      } catch {
        if (seq !== requestSeq.current) return;
        setResults([]);
        setSearchStatus("error");
      }
    },
    [billableOnly, client, inValueSet, limit, system],
  );

  // Debounced search while the user is typing an unselected term.
  useEffect(() => {
    const needle = text.trim();
    if (!open || disabled || value || needle === "") return;
    const handle = window.setTimeout(() => void runSearch(needle), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [disabled, open, runSearch, text, value]);

  function emit(code: string, nextDisplay: string): void {
    lastEmitted.current = code;
    onChangeRef.current(code, nextDisplay);
  }

  function selectConcept(concept: CodeSearchConcept): void {
    setDisplay(concept.display);
    setText(conceptLabel(concept.code, concept.display));
    setVerification("verified");
    setOpen(false);
    setActiveIndex(-1);
    emit(concept.code, concept.display);
  }

  async function commitManual(raw: string): Promise<void> {
    const code = normalizeCode(system, raw);
    if (!code) return;
    const seq = ++verifySeq.current;
    setOpen(false);
    setActiveIndex(-1);
    // An entered code is committed at once so a following click (Save, Look up) sees it; /validate then
    // reports whether the catalog knows it. Only `allowUnverified={false}` waits for the verdict.
    if (allowUnverified) {
      setDisplay("");
      setText(code);
      emit(code, "");
    }
    setVerification("checking");
    const outcome = await validateCode(code);
    if (seq !== verifySeq.current) return;
    setVerification(outcome);
    if (!allowUnverified && outcome === "verified") {
      setDisplay("");
      setText(code);
      emit(code, "");
    }
  }

  async function validateCode(code: string): Promise<Verification> {
    try {
      const res = (await client.GET("/api/v1/terminology/{system}/validate", {
        params: { path: { system }, query: { code } },
      } as never)) as { data?: { valid?: boolean }; error?: unknown } | undefined;
      if (res && !res.error && res.data) return res.data.valid ? "verified" : "unknown";
    } catch {
      // Treated as "could not check" below; the caller decides whether that blocks.
    }
    return "unavailable";
  }

  function clear(): void {
    requestSeq.current += 1;
    verifySeq.current += 1;
    setText("");
    setDisplay("");
    setResults([]);
    setSearchStatus("idle");
    setVerification("none");
    setActiveIndex(-1);
    emit("", "");
  }

  function onInputChange(next: string): void {
    verifySeq.current += 1;
    setText(next);
    setActiveIndex(-1);
    setVerification("none");
    if (value) {
      setDisplay("");
      emit("", "");
    }
    if (next.trim() === "") {
      requestSeq.current += 1;
      setResults([]);
      setSearchStatus("idle");
    }
    setOpen(true);
  }

  function onBlur(): void {
    setOpen(false);
    setActiveIndex(-1);
    const typed = text.trim();
    if (!typed || value) return;
    const exact = results.find((r) => r.code.toLowerCase() === typed.toLowerCase());
    if (exact) selectConcept(exact);
    else if (allowUnverified) void commitManual(typed);
  }

  function activateOption(index: number): void {
    const concept = results[index];
    if (concept) selectConcept(concept);
    else if (showManualRow && index === results.length) void commitManual(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (optionCount > 0) setActiveIndex((i) => (i + 1) % optionCount);
    } else if (event.key === "ArrowUp" && open && optionCount > 0) {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? optionCount - 1 : i - 1));
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    } else if (event.key === "Enter") {
      if (open && activeIndex >= 0) {
        event.preventDefault();
        activateOption(activeIndex);
      } else if (text.trim() && !value && allowUnverified) {
        // Enter must never submit a form with an uncommitted code: commit it first, submit on the next Enter.
        event.preventDefault();
        const exact = results.find((r) => r.code.toLowerCase() === text.trim().toLowerCase());
        if (exact) selectConcept(exact);
        else void commitManual(text);
      }
    }
  }

  const statusText = verificationText(verification, systemName, value);
  const describedBy =
    [error ? errorId : hint ? hintId : null, statusText ? statusId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const popupVisible = open && !disabled && text.trim() !== "" && !value;

  return (
    <div className="wx-field" style={fieldStyle}>
      <label htmlFor={inputId} style={labelStyle}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>

      <span style={shellStyle}>
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={popupVisible}
          aria-controls={popupVisible ? listId : undefined}
          aria-activedescendant={
            popupVisible && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
          }
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          aria-required={required || undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY_LENGTH}
          disabled={disabled}
          value={text}
          placeholder={placeholder ?? `Search ${systemName} by code or description`}
          onChange={(event) => onInputChange(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          style={inputStyle(Boolean(error))}
        />

        {(text || value) && !disabled ? (
          <button
            type="button"
            aria-label={`Clear ${systemName} code`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
            style={clearStyle}
          >
            {"×"}
          </button>
        ) : null}

        {popupVisible ? (
          // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the combobox input (ARIA 1.2 combobox pattern)
          <span
            // biome-ignore lint/a11y/useSemanticElements: <select> cannot hold async, richly formatted results
            role="listbox"
            id={listId}
            aria-label={`${systemName} results`}
            style={popoverStyle}
          >
            {searchStatus === "loading" ? (
              <span style={stateStyle}>
                <LoadingSpinner />
                <span>Searching {systemName}</span>
              </span>
            ) : null}
            {searchStatus === "error" ? (
              <span role="alert" style={{ ...stateStyle, color: t.error }}>
                {systemName} search is unavailable.
                {allowUnverified ? " You can use the code as entered." : ""}
              </span>
            ) : null}
            {searchStatus === "ready" && results.length === 0 ? (
              <span style={stateStyle}>No {systemName} matches in the catalog.</span>
            ) : null}
            {results.map((concept, index) => (
              <OptionRow
                key={concept.code}
                id={`${listId}-option-${index}`}
                active={index === activeIndex}
                onPick={() => selectConcept(concept)}
                onHover={() => setActiveIndex(index)}
              >
                <span style={codeStyle}>{concept.code}</span>
                <span style={displayStyle}>{concept.display}</span>
              </OptionRow>
            ))}
            {showManualRow ? (
              <OptionRow
                id={`${listId}-option-${results.length}`}
                active={activeIndex === results.length}
                onPick={() => void commitManual(text)}
                onHover={() => setActiveIndex(results.length)}
              >
                <span style={displayStyle}>
                  Use <span style={codeStyle}>{normalizeCode(system, text)}</span> as entered (not
                  checked against the catalog)
                </span>
              </OptionRow>
            ) : null}
          </span>
        ) : null}
      </span>

      {statusText ? (
        <output id={statusId} style={statusStyle(verification)}>
          {statusText}
        </output>
      ) : null}
      {hint && !error ? (
        <span id={hintId} style={helperStyle}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" style={{ ...helperStyle, color: t.error }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function OptionRow({
  id,
  active,
  onPick,
  onHover,
  children,
}: {
  id: string;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      id={id}
      // biome-ignore lint/a11y/useSemanticElements: an <option> cannot carry the two-part code/description markup
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={active}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
      style={optionStyle(active)}
    >
      {children}
    </button>
  );
}

function verificationText(state: Verification, systemName: string, value: string): string {
  if (!value && state !== "unknown" && state !== "unavailable") return "";
  switch (state) {
    case "checking":
      return `Checking ${systemName}`;
    case "verified":
      return `Verified in ${systemName}`;
    case "unknown":
      return `Not found in the ${systemName} catalog. It will be saved as entered.`;
    case "unavailable":
      return `Could not check this code against ${systemName}. It will be saved as entered.`;
    default:
      return "";
  }
}

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
  color: t.onSurface,
};

const labelStyle: CSSProperties = { fontSize: "0.8125rem", fontWeight: 650 };

const shellStyle: CSSProperties = { position: "relative", display: "block", minWidth: 0 };

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
  display: "grid",
  placeItems: "center",
  width: "1.5rem",
  height: "1.5rem",
  padding: 0,
  border: "none",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  cursor: "pointer",
  lineHeight: 1,
};

const popoverStyle: CSSProperties = {
  position: "absolute",
  zIndex: 120,
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
  boxShadow: t.shadowFloat,
};

const optionStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "baseline",
  gap: t.space3,
  width: "100%",
  padding: "0.55rem 0.7rem",
  border: "none",
  borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 45%, transparent)`,
  background: active ? t.surfaceContainer : "transparent",
  color: t.onSurface,
  textAlign: "left",
  cursor: "pointer",
  fontFamily: t.fontSans,
});

const codeStyle: CSSProperties = { fontFamily: t.fontMono, fontWeight: 650, flex: "0 0 auto" };

const displayStyle: CSSProperties = { fontSize: "0.8125rem", color: t.onSurfaceVariant };

const stateStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  minHeight: "2.5rem",
  padding: "0.6rem 0.75rem",
  color: t.onSurfaceVariant,
  fontSize: "0.8125rem",
};

const helperStyle: CSSProperties = { color: t.onSurfaceVariant, fontSize: "0.75rem" };

const statusStyle = (state: Verification): CSSProperties => ({
  fontSize: "0.75rem",
  color: state === "verified" ? t.success : t.warning,
  minHeight: 0,
});
