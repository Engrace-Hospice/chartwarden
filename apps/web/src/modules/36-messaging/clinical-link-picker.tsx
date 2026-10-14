import type { ClinicalLinkKind } from "@wardenx/types";
// M36 WP 3.2 - the composer's clinical link picker. Typing `#` or `+` at the start of a word (or the "Link record" button)
// opens a combobox popover: first a record kind, then a record of that kind from the candidate SOURCE (a port; see
// clinical-link-kinds.ts). Arrow keys move, Enter chooses, Escape closes and focus returns to the composer. Choosing only
// calls `onAdd`: the link becomes a tray chip and is sent as a `clinicalLink` node. Nothing here writes to a source.
import { Glyph, useFeatureFlag } from "@wardenx/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusEvent, JSX, KeyboardEvent } from "react";
import {
  CLINICAL_LINKS_FLAG_KEY,
  CLINICAL_LINK_KIND_LABEL,
  type ClinicalLinkCandidate,
  type ClinicalLinkCandidateSource,
  type DraftClinicalLink,
} from "./clinical-link-kinds";
import { useDefaultClinicalLinkSource } from "./use-clinical-link-source";
import { MAX_DRAFT_CLINICAL_LINKS } from "./use-draft-clinical-links";
import "./clinical-links.css";

/** Flag read that defaults to OFF with no provider mounted (a bare render must not throw; fail closed). */
function useClinicalLinksFlag(): boolean {
  try {
    return useFeatureFlag(CLINICAL_LINKS_FLAG_KEY);
  } catch {
    return false;
  }
}

/** Whether the picker may be offered, and from which source. Hidden: flag off, no patient scope, or no kind to offer. */
export function useClinicalLinkPicker(
  patientId: string | null,
  injected?: ClinicalLinkCandidateSource,
) {
  const flagOn = useClinicalLinksFlag();
  const fallback = useDefaultClinicalLinkSource();
  const source = injected ?? fallback;
  const [open, setOpen] = useState(false);
  const enabled = flagOn && patientId !== null && source.kinds.length > 0;
  return { enabled, source, patientId, open: enabled && open, setOpen };
}
export type ClinicalLinkPickerState = ReturnType<typeof useClinicalLinkPicker>;

/** A `#` or `+` just typed at the start of a word: where it is, so the composer can swap it for the picker. */
export function triggerIndex(previous: string, next: string, cursor: number): number | null {
  if (next.length !== previous.length + 1 || cursor < 1) return null;
  const at = cursor - 1;
  if (next[at] !== "#" && next[at] !== "+") return null;
  if (next.slice(0, at) + next.slice(at + 1) !== previous) return null;
  return at === 0 || /\s/.test(next[at - 1] ?? "") ? at : null;
}

type Step =
  | { readonly name: "kinds" }
  | { readonly name: "records"; readonly kind: ClinicalLinkKind };
type Records =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | { readonly status: "ready"; readonly items: readonly ClinicalLinkCandidate[] };

function useCandidates(
  source: ClinicalLinkCandidateSource,
  patientId: string | null,
  kind: ClinicalLinkKind | null,
  attempt: number,
): Records {
  const [records, setRecords] = useState<Records>({ status: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read after Try again
  useEffect(() => {
    if (!kind || !patientId) return;
    const controller = new AbortController();
    let stale = false;
    setRecords({ status: "loading" });
    source
      .list(kind, patientId, controller.signal)
      .then((items) => {
        if (!stale) setRecords({ status: "ready", items });
      })
      .catch(() => {
        if (!stale) setRecords({ status: "error" });
      });
    return () => {
      stale = true;
      controller.abort();
    };
  }, [source, patientId, kind, attempt]);
  return records;
}

interface PickerProps {
  readonly picker: ClinicalLinkPickerState;
  readonly links: readonly DraftClinicalLink[];
  readonly disabled: boolean;
  readonly onAdd: (link: DraftClinicalLink) => void;
  /** Focus goes back to the composer after the popover closes. */
  readonly onClosed: () => void;
}

export function ClinicalLinkPicker({
  picker,
  links,
  disabled,
  onAdd,
  onClosed,
}: PickerProps): JSX.Element | null {
  const { enabled, source, patientId, open, setOpen } = picker;
  const [step, setStep] = useState<Step>({ name: "kinds" });
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const popoverId = useId();
  const atCap = links.length >= MAX_DRAFT_CLINICAL_LINKS;
  const recordKind = step.name === "records" ? step.kind : null;
  const records = useCandidates(source, patientId, open ? recordKind : null, attempt);

  const options = useMemo(() => {
    if (step.name === "kinds") {
      return source.kinds.map((kind) => ({ id: kind, label: CLINICAL_LINK_KIND_LABEL[kind] }));
    }
    if (records.status !== "ready") return [];
    const needle = query.trim().toLowerCase();
    return records.items
      .filter(
        (item) => !needle || `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle),
      )
      .map((item) => ({
        id: item.entityId,
        label: item.label,
        detail: item.detail,
        item,
        linked: links.some((l) => l.kind === item.kind && l.entityId === item.entityId),
      }));
  }, [step, source.kinds, records, query, links]);
  const activeIdx = Math.min(activeIndex, Math.max(options.length - 1, 0));
  const active = options[activeIdx];

  // A fresh open starts at the kind list with the search box focused.
  useEffect(() => {
    if (!open) return;
    setStep({ name: "kinds" });
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, setOpen]);

  if (!enabled) return null;

  function close(): void {
    setOpen(false);
    onClosed();
  }
  function choose(index: number): void {
    const option = options[index];
    if (!option) return;
    if (step.name === "kinds") {
      setStep({ name: "records", kind: option.id as ClinicalLinkKind });
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
      return;
    }
    if (!("item" in option) || option.linked) return;
    onAdd(option.item);
    close();
  }
  function onInputKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + delta + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIdx);
    } else if (event.key === "Backspace" && query === "" && step.name === "records") {
      setStep({ name: "kinds" });
      setActiveIndex(0);
    }
  }
  function onPopoverKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }
  function onPickerBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget as Node | null;
    if (open && next && !event.currentTarget.contains(next)) setOpen(false);
  }

  const optionId = (index: number): string => `${listId}-${index}`;
  const label =
    step.name === "kinds"
      ? "Choose a record type"
      : `Find a ${CLINICAL_LINK_KIND_LABEL[step.kind].toLowerCase()}`;
  const stateText =
    step.name === "records" && records.status === "loading"
      ? "Loading records"
      : step.name === "records" && records.status === "error"
        ? "Records could not be loaded."
        : `${options.length} ${options.length === 1 ? "option" : "options"}`;

  return (
    <div className="wx-clinical-link-picker" ref={rootRef} onBlur={onPickerBlur}>
      <button
        type="button"
        className="wx-clinical-link-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled || atCap}
        title={atCap ? `At most ${MAX_DRAFT_CLINICAL_LINKS} linked records per message` : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Glyph name="link" size={16} /> <span>Link record</span>
      </button>
      {open ? (
        <div
          id={popoverId}
          className="wx-clinical-link-popover"
          // biome-ignore lint/a11y/useSemanticElements: a non-modal anchored popover; <dialog> adds top-layer and backdrop semantics
          role="dialog"
          aria-label="Link a record"
          onKeyDown={onPopoverKey}
        >
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={label}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(activeIdx) : undefined}
            placeholder={label}
            value={query}
            readOnly={step.name === "kinds"}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKey}
          />
          <output className="wx-clinical-link-state" aria-live="polite">
            {stateText}
          </output>
          {step.name === "records" && records.status === "error" ? (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          ) : null}
          {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search box; arrow keys drive the active option (combobox pattern) */}
          <div
            className="wx-clinical-link-list"
            id={listId}
            // biome-ignore lint/a11y/useSemanticElements: a native select cannot render a label plus detail
            role="listbox"
            aria-label={label}
          >
            {options.map((option, index) => {
              const linked = "linked" in option && option.linked;
              return (
                <button
                  key={`${step.name}:${option.id}`}
                  id={optionId(index)}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: a native option cannot render the label and detail markup
                  role="option"
                  tabIndex={-1}
                  aria-selected={option === active}
                  aria-disabled={linked || undefined}
                  className={option === active ? "is-active" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                >
                  <strong>{option.label}</strong>
                  {"detail" in option && option.detail ? <small>{option.detail}</small> : null}
                  {linked ? <small>Already linked</small> : null}
                </button>
              );
            })}
          </div>
          {step.name === "records" && records.status === "ready" && options.length === 0 ? (
            <p className="wx-clinical-link-state">No records to link.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The links chosen for the draft, each removable. Shows the cap when it is reached. */
export function ClinicalLinkTray({
  links,
  onRemove,
}: {
  links: readonly DraftClinicalLink[];
  onRemove: (link: DraftClinicalLink) => void;
}): JSX.Element | null {
  if (links.length === 0) return null;
  return (
    <>
      <ul className="wx-clinical-link-tray" aria-label="Linked records">
        {links.map((link) => (
          <li key={`${link.kind}:${link.entityId}`}>
            <span>
              {CLINICAL_LINK_KIND_LABEL[link.kind]}: {link.label}
            </span>
            <button
              type="button"
              aria-label={`Remove link to ${CLINICAL_LINK_KIND_LABEL[link.kind]} ${link.label}`}
              onClick={() => onRemove(link)}
            >
              <Glyph name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {links.length >= MAX_DRAFT_CLINICAL_LINKS ? (
        <output className="wx-clinical-link-state">
          Link limit reached ({MAX_DRAFT_CLINICAL_LINKS} per message).
        </output>
      ) : null}
    </>
  );
}
