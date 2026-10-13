// WP 2.7a: in-conversation search. Ctrl/Cmd+F opens a bar under the header; results list the matching messages of THIS
// conversation only (the server decides what is viewable and returns nothing deleted), and choosing one jumps to it
// with the same jump the pinned bar and thread links use. Not offered in an archived conversation (the server refuses
// it there), so the browser's own find keeps working.
import { Button, Glyph } from "@wardenx/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Message } from "./messaging-types";
import { absoluteTime } from "./messaging-utils";
import { searchWords, snippetSegments } from "./search-snippet";
import {
  NO_FILTERS,
  SEARCH_MIN_CHARS,
  type SearchFilters,
  isRangeInverted,
  isSearchable,
  useMessageSearch,
} from "./use-message-search";
import "./message-search.css";

interface MessageSearchProps {
  readonly channelId: string;
  readonly archived: boolean;
  readonly meId: string;
  /** The loaded messages: only their authors are read, to offer a "From" choice. */
  readonly messages: readonly Message[] | null;
  readonly onJump: (messageId: string) => void;
}

const MODAL_OPEN = '[role="dialog"], [aria-modal="true"], dialog[open]';

/**
 * Ctrl/Cmd+F is ours only when nothing else has claimed the key: not Ctrl+Shift+F, not an event another handler already
 * handled, not while a modal is open (the browser's find and the modal's own keys win), and not from inside the side
 * thread panel (that is a different view than the conversation this searches).
 */
function isFindShortcut(event: globalThis.KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== "f" || event.defaultPrevented) return false;
  if (document.querySelector(MODAL_OPEN)) return false;
  const target = event.target;
  return !(target instanceof Element && target.closest(".wx-thread-panel"));
}

export function MessageSearch({
  channelId,
  archived,
  meId,
  messages,
  onJump,
}: MessageSearchProps): JSX.Element | null {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const { state, loadMore, retry } = useMessageSearch({
    channelId,
    enabled: open && !archived,
    query,
    filters,
  });

  useEffect(() => {
    if (archived) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!isFindShortcut(event)) return;
      event.preventDefault();
      setOpen(true);
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [archived]);

  // An archived conversation is not searchable: close and forget the query rather than reopen it when it changes back.
  useEffect(() => {
    if (!archived) return;
    setOpen(false);
    setQuery("");
    setFilters(NO_FILTERS);
  }, [archived]);

  // Another conversation is a new search.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `channelId` is the trigger
  useEffect(() => {
    setOpen(false);
    setQuery("");
    setFilters(NO_FILTERS);
  }, [channelId]);

  useEffect(() => {
    // Never pull focus out of a modal that opened meanwhile.
    if (open && !document.querySelector(MODAL_OPEN)) inputRef.current?.focus();
  }, [open]);

  const authors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const message of messages ?? []) {
      if (message.authorUserId && message.authorUserId !== meId) {
        seen.set(message.authorUserId, message.authorDisplayName || "Staff member");
      }
    }
    return [...seen.entries()];
  }, [messages, meId]);

  if (archived) return null;

  const words = searchWords(query);
  const buttons = (): HTMLButtonElement[] =>
    Array.from(resultsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onPanelKey = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons()[0]?.focus();
    }
  };
  const onResultKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const all = buttons();
    if (event.key === "ArrowDown") all[index + 1]?.focus();
    else (index === 0 ? inputRef.current : all[index - 1])?.focus();
  };
  const patch = (change: Partial<SearchFilters>): void =>
    setFilters((current) => ({ ...current, ...change }));

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < SEARCH_MIN_CHARS;
  const searchable = isSearchable(query, filters);
  const inverted = isRangeInverted(filters);
  const nothingFound = state.status === "ready" && state.results.length === 0 && !state.nextCursor;

  return (
    <div className="wx-msg-search">
      <button
        ref={triggerRef}
        type="button"
        className="wx-msg-search-trigger"
        aria-label="Search messages"
        aria-expanded={open}
        aria-controls={panelId}
        aria-keyshortcuts="Control+F Meta+F"
        title="Search messages (Ctrl+F)"
        onClick={() => setOpen((value) => !value)}
      >
        <Glyph name="search" size={16} />
        <span>Search</span>
      </button>
      {open ? (
        <form
          id={panelId}
          className="wx-msg-search-panel"
          // biome-ignore lint/a11y/useSemanticElements: role="search" on the form is the intended, widely-supported pattern.
          role="search"
          aria-label="Search this conversation"
          onKeyDown={onPanelKey}
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="wx-msg-search-row">
            <input
              ref={inputRef}
              type="search"
              className="wx-msg-search-input"
              aria-label="Search this conversation"
              placeholder="Search this conversation"
              autoComplete="off"
              maxLength={100}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKey}
            />
            <button
              type="button"
              className="wx-msg-search-close"
              aria-label="Close search"
              onClick={close}
            >
              <Glyph name="close" size={16} />
            </button>
          </div>
          <div className="wx-msg-search-filters">
            <label>
              <span>From</span>
              <select
                value={filters.sender}
                onChange={(event) => patch({ sender: event.target.value })}
              >
                <option value="">Anyone</option>
                <option value={meId}>Me</option>
                {authors.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>After</span>
              <input
                type="date"
                value={filters.after}
                max={filters.before || undefined}
                onChange={(event) => patch({ after: event.target.value })}
              />
            </label>
            <label>
              <span>Before</span>
              <input
                type="date"
                value={filters.before}
                min={filters.after || undefined}
                onChange={(event) => patch({ before: event.target.value })}
              />
            </label>
            <label className="wx-msg-search-check">
              <input
                type="checkbox"
                checked={filters.hasAttachment}
                onChange={(event) => patch({ hasAttachment: event.target.checked })}
              />
              <span>Has attachment</span>
            </label>
          </div>

          {/* biome-ignore lint/a11y/useSemanticElements: <output> allows phrasing content only; this region holds paragraphs. */}
          <div className="wx-msg-search-status" role="status">
            {inverted ? (
              <p>"After" is later than "Before". Change one of the dates.</p>
            ) : !searchable ? (
              <p>
                {tooShort
                  ? `Type at least ${SEARCH_MIN_CHARS} characters to search.`
                  : "Search the messages you can see in this conversation."}
              </p>
            ) : state.status === "loading" ? (
              <p>Searching…</p>
            ) : nothingFound ? (
              <p>No messages match your search.</p>
            ) : state.status === "ready" && state.results.length > 0 ? (
              <p>
                {state.results.length} {state.results.length === 1 ? "message" : "messages"} found
              </p>
            ) : null}
          </div>

          {state.status === "error" ? (
            <div className="wx-msg-search-error" role="alert">
              <span>{state.error ?? "This conversation could not be searched."}</span>
              <Button size="sm" tone="secondary" onClick={retry}>
                Retry
              </Button>
            </div>
          ) : null}

          {state.status === "ready" && state.results.length > 0 ? (
            <ul ref={resultsRef} className="wx-msg-search-results" aria-label="Search results">
              {state.results.map((result, index) => (
                <li key={result.messageId}>
                  <button
                    type="button"
                    onClick={() => onJump(result.messageId)}
                    onKeyDown={(event) => onResultKey(event, index)}
                  >
                    <span className="wx-msg-search-meta">
                      <strong>{result.authorDisplayName || "Staff member"}</strong>
                      <time dateTime={result.createdAt}>{absoluteTime(result.createdAt)}</time>
                    </span>
                    <span className="wx-msg-search-snippet">
                      {result.body.trim() === "" && (result.attachments?.length ?? 0) > 0
                        ? "Attachment"
                        : snippetSegments(result.body, words).map((segment, at) =>
                            segment.hit ? (
                              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and immutable
                              <mark key={at}>{segment.text}</mark>
                            ) : (
                              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and immutable
                              <span key={at}>{segment.text}</span>
                            ),
                          )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {state.status === "ready" && state.moreError ? (
            <div className="wx-msg-search-error" role="alert">
              <span>{state.moreError}</span>
            </div>
          ) : null}

          {state.status === "ready" && state.nextCursor ? (
            <div className="wx-msg-search-more">
              {state.scanCapped ? (
                <p>
                  {state.scanned > 0 && state.results.length === 0
                    ? `Searched the most recent ${state.scanned} messages.`
                    : `Searched ${state.scanned} messages so far, newest first.`}
                </p>
              ) : null}
              <Button size="sm" tone="secondary" onClick={loadMore} disabled={state.loadingMore}>
                {state.loadingMore
                  ? "Searching…"
                  : state.moreError
                    ? "Try again"
                    : state.scanCapped
                      ? "Search older messages"
                      : "Show more results"}
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
