// M36 WP 2.8 - the composer's saved-reply picker. A disclosure button opens a small combobox: a search box that owns
// focus, a listbox of the caller's replies (platform, organization, personal), arrow keys to move, Enter to insert,
// Escape to close and hand focus back to the composer. Choosing a reply only calls `onInsert(body)`: the composer puts
// the text in the draft, the user may edit it, and what is sent is an ordinary message (nothing links it to the reply).
import { Glyph } from "@chartwarden/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FocusEvent, JSX, KeyboardEvent, RefObject } from "react";
import { type Locale, translate } from "./i18n/catalog";
import { pickTemplateText } from "./i18n/template-translations";
import { EnTag, Txt, currentLocale } from "./i18n/use-messaging-locale";
import { CATEGORY_LABEL, SCOPE_LABEL, type SavedReply } from "./saved-replies-types";
import { useSavedReplies } from "./use-saved-replies";
import "./saved-replies.css";

export interface TemplatePickerProps {
  readonly disabled: boolean;
  /** Put this text in the draft at the caret. */
  readonly onInsert: (body: string) => void;
  /** Focus goes back to the composer after the picker closes. */
  readonly onClosed: () => void;
  /** WP 3.3: when set, an "SBAR" item tops the list; choosing it calls this (the composer opens the SBAR form). */
  readonly onChooseSbar?: () => void;
  /** Called each time the menu opens (the composer re-reads a transiently failed SBAR policy). */
  readonly onOpened?: () => void;
  /** The toggle button, so the SBAR form can hand focus back to it. */
  readonly toggleRef?: RefObject<HTMLButtonElement>;
  /** WP 6.4: override the resolved locale (tests); default is the user preference, then the browser. */
  readonly locale?: Locale;
}

export function matchesQuery(
  reply: SavedReply,
  query: string,
  locale: Locale = "en",
  translations?: Parameters<typeof pickTemplateText>[2],
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const shown = pickTemplateText(reply, locale, translations); // what the user reads, not only the English source
  return [reply.title, reply.body, shown.title, shown.body, CATEGORY_LABEL[reply.category]].some(
    (text) => text.toLowerCase().includes(needle),
  );
}

const SBAR_LABEL = "SBAR";
const matchesSbar = (query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return !needle || "sbar situation background assessment recommendation".includes(needle);
};
const SBAR_DESCRIPTION = "Situation, Background, Assessment, Recommendation";

export function TemplatePicker({
  disabled,
  onInsert,
  onClosed,
  onChooseSbar,
  onOpened,
  toggleRef,
  locale: localeProp,
}: TemplatePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [detected] = useState(currentLocale);
  const locale = localeProp ?? detected;
  const tr = (key: Parameters<typeof translate>[1]): string => translate(locale, key).text;
  const trLang = (key: Parameters<typeof translate>[1]): string => translate(locale, key).lang;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const replies = useSavedReplies(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const popoverId = useId();

  const visible = useMemo(
    () => replies.items.filter((reply) => matchesQuery(reply, query, locale)),
    [replies.items, query, locale],
  );
  // The SBAR item is entry 0 while it is offered and matches the search; replies follow.
  const sbarShown = Boolean(onChooseSbar) && matchesSbar(query);
  const offset = sbarShown ? 1 : 0;
  const entryCount = visible.length + offset;
  const entryIndex = Math.min(activeIndex, Math.max(entryCount - 1, 0));
  const sbarActive = sbarShown && entryIndex === 0;
  const active = sbarActive ? undefined : visible[entryIndex - offset];

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Keep the option the arrow keys landed on visible inside the scrolling list.
  const activeId = sbarActive ? "sbar" : active?.id;
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
    onOpened?.();
  }

  function closePicker(): void {
    setOpen(false);
    onClosed();
  }

  function chooseSbar(): void {
    setOpen(false);
    onChooseSbar?.();
  }

  function choose(reply: SavedReply | undefined): void {
    if (!reply) return;
    setOpen(false);
    onInsert(pickTemplateText(reply, locale).body);
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (entryCount === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + step + entryCount) % entryCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (sbarActive) chooseSbar();
      else choose(active);
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
  const activeDescendant = sbarActive ? `${listId}-sbar` : active ? optionId(active) : undefined;
  const statusText =
    replies.status === "error"
      ? tr("picker.loadFailed")
      : replies.status === "loading" && replies.items.length === 0
        ? tr("picker.loading")
        : translate(locale, visible.length === 1 ? "picker.count.one" : "picker.count.other", {
            n: visible.length,
          }).text;
  const statusLang =
    translate(locale, "picker.count.other").lang;

  return (
    <div className="wx-template-picker" ref={rootRef} onBlur={onPickerBlur}>
      <button
        type="button"
        ref={toggleRef}
        className="wx-template-picker-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        onClick={() => (open ? closePicker() : openPicker())}
      >
        <Glyph name="scroll" size={16} /> <Txt k="picker.toggle" locale={locale} />
      </button>
      {open ? (
        <div
          id={popoverId}
          className="wx-template-popover"
          // biome-ignore lint/a11y/useSemanticElements: a non-modal anchored popover; <dialog> adds top-layer and backdrop semantics
          role="dialog"
          aria-label={tr("picker.toggle")}
          lang={trLang("picker.toggle")}
          onKeyDown={onPopoverKey}
        >
          <input
            ref={searchRef}
            className="wx-template-search"
            type="text"
            role="combobox"
            lang={trLang("picker.search")}
            aria-label={tr("picker.search")}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeDescendant}
            placeholder={tr("picker.search")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKey}
          />
          <output className="wx-template-status" aria-live="polite" lang={statusLang}>
            {statusText}
          </output>
          {replies.status === "error" ? (
            <button type="button" className="wx-template-retry" onClick={replies.reload}>
              <Txt k="picker.retry" locale={locale} />
            </button>
          ) : null}
          {/* biome-ignore lint/a11y/useFocusableInteractive: focus stays in the search box; arrow keys drive the active option (combobox pattern) */}
          <div
            className="wx-template-list"
            id={listId}
            // biome-ignore lint/a11y/useSemanticElements: a native select cannot render the title, scope and preview of each reply
            role="listbox"
            lang={trLang("picker.toggle")}
            aria-label={tr("picker.toggle")}
          >
            {sbarShown ? (
              <button
                id={`${listId}-sbar`}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: a native option cannot render the title and description markup
                role="option"
                tabIndex={-1}
                aria-selected={sbarActive}
                className={sbarActive ? "wx-template-option is-active" : "wx-template-option"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={chooseSbar}
              >
                <strong>{SBAR_LABEL}</strong>
                <span>{SBAR_DESCRIPTION}</span>
              </button>
            ) : null}
            {visible.map((reply) => {
              const text = pickTemplateText(reply, locale);
              return (
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
                <strong lang={text.lang}>
                  {text.title}
                  {text.fallback ? <EnTag /> : null}
                </strong>
                <small>
                  {SCOPE_LABEL[reply.scope]} · {CATEGORY_LABEL[reply.category]}
                </small>
                <span lang={text.lang}>{text.body}</span>
              </button>
              );
            })}
          </div>
          {replies.status === "ready" && visible.length === 0 ? (
            <p className="wx-template-empty">
              <Txt k={query.trim() ? "picker.noMatch" : "picker.none"} locale={locale} />
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
