// M36 WP 2.8 - the composer's saved-reply picker. A disclosure button opens a small combobox: a search box that owns
// focus, a listbox of the caller's replies (platform, organization, personal), arrow keys to move, Enter to insert,
// Escape to close and hand focus back to the composer. Choosing a reply only calls `onInsert(body)`: the composer puts
// the text in the draft, the user may edit it, and what is sent is an ordinary message (nothing links it to the reply).
import { Glyph } from "@wardenx/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusEvent, JSX, KeyboardEvent } from "react";
import { CATEGORY_LABEL, SCOPE_LABEL, type SavedReply } from "./saved-replies-types";
import { useSavedReplies } from "./use-saved-replies";
import "./saved-replies.css";

export interface TemplatePickerProps {
  readonly disabled: boolean;
  /** Put this text in the draft at the caret. */
  readonly onInsert: (body: string) => void;
  /** Focus goes back to the composer after the picker closes. */
  readonly onClosed: () => void;
}

export function matchesQuery(reply: SavedReply, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    reply.title.toLowerCase().includes(needle) ||
    reply.body.toLowerCase().includes(needle) ||
    CATEGORY_LABEL[reply.category].toLowerCase().includes(needle)
  );
}

export function TemplatePicker({ disabled, onInsert, onClosed }: TemplatePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const replies = useSavedReplies(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const popoverId = useId();

  const visible = useMemo(
    () => replies.items.filter((reply) => matchesQuery(reply, query)),
    [replies.items, query],
  );
  const active = visible[Math.min(activeIndex, Math.max(visible.length - 1, 0))];

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Keep the option the arrow keys landed on visible inside the scrolling list.
  const activeId = active?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active reply's id is the trigger
  useEffect(() => {
    if (!open || !activeId) return;
    document.getElementById(`${listId}-${activeId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);

  // A press outside the picker closes it without stealing focus from where the user went.
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function openPicker(): void {
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }

  function closePicker(): void {
    setOpen(false);
    onClosed();
  }

  function choose(reply: SavedReply | undefined): void {
    if (!reply) return;
    setOpen(false);
    onInsert(reply.body);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (visible.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + step + visible.length) % visible.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  }

  // Escape closes from anywhere inside the popover (an option, Try again), and focus goes back to the composer.
  function onPopoverKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  }

  // Focus leaving the picker altogether (Tab out) closes it without taking focus back from where the user went.
  function onPickerBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget as Node | null;
    if (open && next && !event.currentTarget.contains(next)) setOpen(false);
  }

  const optionId = (reply: SavedReply): string => `${listId}-${reply.id}`;
  const statusText =
    replies.status === "error"
      ? "Saved replies could not be loaded."
      : replies.status === "loading" && replies.items.length === 0
        ? "Loading saved replies"
        : `${visible.length} saved ${visible.length === 1 ? "reply" : "replies"}`;

  return (
    <div className="wx-template-picker" ref={rootRef} onBlur={onPickerBlur}>
      <button
        type="button"
        className="wx-template-picker-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        onClick={() => (open ? closePicker() : openPicker())}
      >
        <Glyph name="scroll" size={16} /> <span>Saved replies</span>
      </button>
      {open ? (
        <div
          id={popoverId}
          className="wx-template-popover"
          // biome-ignore lint/a11y/useSemanticElements: a non-modal anchored popover; <dialog> adds top-layer and backdrop semantics
          role="dialog"
          aria-label="Saved replies"
          onKeyDown={onPopoverKey}
        >
          <input
            ref={searchRef}
            className="wx-template-search"
            type="text"
            role="combobox"
            aria-label="Search saved replies"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            placeholder="Search saved replies"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKey}
          />
          <output className="wx-template-status" aria-live="polite">
            {statusText}
          </output>
          {replies.status === "error" ? (
            <button type="button" className="wx-template-retry" onClick={replies.reload}>
              Try again
            </button>
          ) : null}
          {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search box; arrow keys drive the active option (combobox pattern) */}
          <div
            className="wx-template-list"
            id={listId}
            // biome-ignore lint/a11y/useSemanticElements: a native select cannot render the title, scope and preview of each reply
            role="listbox"
            aria-label="Saved replies"
          >
            {visible.map((reply) => (
              <button
                key={reply.id}
                id={optionId(reply)}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: a native option cannot render the title, scope and preview markup
                role="option"
                tabIndex={-1}
                aria-selected={reply.id === active?.id}
                className={
                  reply.id === active?.id ? "wx-template-option is-active" : "wx-template-option"
                }
                // mousedown would blur the search box before the click lands; the click does the work.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(reply)}
              >
                <strong>{reply.title}</strong>
                <small>
                  {SCOPE_LABEL[reply.scope]} · {CATEGORY_LABEL[reply.category]}
                </small>
                <span>{reply.body}</span>
              </button>
            ))}
          </div>
          {replies.status === "ready" && visible.length === 0 ? (
            <p className="wx-template-empty">
              {query.trim()
                ? "No saved reply matches that search."
                : "No saved replies yet. Add some on the Saved replies page."}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
