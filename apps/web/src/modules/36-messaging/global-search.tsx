// WP 2.7b: search across every conversation the user can currently open (ADR-0058). It finds WHOLE WORDS and the
// BEGINNING of a word only, and says so. Results are rendered as plain text (never HTML) exactly as the API returns
// them; the server re-checks access on every request. The entry point is always offered: a non-admin has no
// availability read (the settings route needs `messaging.global_search.manage`), so the search call's own refusal is the
// only truth, and it is shown in the panel as "not turned on" (no reason, no hint about who can enable it).
// The query lives in this component's state only: no storage, no URL, no analytics.
import { Button, Glyph } from "@chartwarden/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent, MouseEvent } from "react";
import { absoluteTime } from "./messaging-utils";
import {
  GLOBAL_SEARCH_MIN_CHARS,
  type GlobalSearchFailure,
  type GlobalSearchState,
  isGlobalSearchable,
  useGlobalSearch,
} from "./use-global-search";
import "./global-search.css";

interface GlobalSearchProps {
  /** The conversation's label, or null when it is not in the loaded list. */
  readonly channelName: (channelId: string) => string | null;
  /** Opens the conversation at the message; resolves false when it could not be opened. */
  readonly onOpenHit: (channelId: string, messageId: string) => Promise<boolean>;
}

const UNKNOWN_CHANNEL = "A conversation you can no longer open";
const SKELETON_KEYS = ["a", "b", "c", "d"] as const;

const FAILURE_COPY: Record<Exclude<GlobalSearchFailure["kind"], "invalid">, string> = {
  off: "Search is not turned on for your organisation.",
  unavailable: "Search is temporarily unavailable.",
  "rate-limited": "Too many searches, wait a moment.",
  offline: "You appear to be offline. Check your connection and try again.",
  other: "Search could not be completed.",
};

export function failureText(failure: GlobalSearchFailure): string {
  if (failure.kind === "invalid") return failure.message;
  if (failure.kind === "rate-limited" && failure.retryAfterSeconds !== null) {
    return `${FAILURE_COPY[failure.kind]} Try again in ${failure.retryAfterSeconds} seconds.`;
  }
  return FAILURE_COPY[failure.kind];
}

function statusText(query: string, state: GlobalSearchState): string {
  const trimmed = query.trim();
  if (trimmed.length > 0 && !isGlobalSearchable(query)) {
    return `Type at least ${GLOBAL_SEARCH_MIN_CHARS} characters to search.`;
  }
  if (state.status === "loading") return "Searching…";
  if (state.status !== "ready") return "";
  if (state.refine) return "Too many matches - try a more specific word.";
  if (state.results.length === 0) return "No matches.";
  const count = `${state.results.length} ${state.results.length === 1 ? "match" : "matches"}`;
  return state.scanCapped ? `${count}. Search stopped early; refine to see more.` : count;
}

export function GlobalSearch({ channelName, onOpenHit }: GlobalSearchProps): JSX.Element {
  const panelId = useId();
  const helpId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [openFailed, setOpenFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const openingRef = useRef(false);
  const { state, retry, loadMore } = useGlobalSearch(query, open);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    setQuery("");
    setOpenFailed(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const links = (): HTMLAnchorElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  const onPanelKey = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close(true);
  };
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    links()[0]?.focus();
  };
  const onLinkKey = (event: KeyboardEvent<HTMLAnchorElement>, index: number): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (event.key === "ArrowDown") links()[index + 1]?.focus();
    else (index === 0 ? inputRef.current : links()[index - 1])?.focus();
  };
  const onPick = (event: MouseEvent, channelId: string, messageId: string): void => {
    // Ctrl/Cmd/Shift/Alt-click and middle-click keep the browser's own link behaviour.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    if (openingRef.current) return;
    openingRef.current = true;
    setOpenFailed(false);
    void onOpenHit(channelId, messageId)
      .then((opened) => {
        if (opened) close(false);
        else setOpenFailed(true);
      })
      .catch(() => setOpenFailed(true))
      .finally(() => {
        openingRef.current = false;
      });
  };

  const canRetry =
    state.failure !== null && state.failure.kind !== "off" && state.failure.kind !== "invalid";

  return (
    <div className="wx-gsearch">
      <button
        ref={triggerRef}
        type="button"
        className="wx-gsearch-trigger"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <Glyph name="search" size={16} />
        <span>Search all conversations</span>
      </button>
      {open ? (
        <form
          id={panelId}
          className="wx-gsearch-panel"
          // biome-ignore lint/a11y/useSemanticElements: role="search" on the form is the intended, widely-supported pattern.
          role="search"
          aria-label="Search all conversations"
          onKeyDown={onPanelKey}
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="wx-gsearch-row">
            <input
              ref={inputRef}
              type="search"
              className="wx-gsearch-input"
              aria-label="Search all conversations"
              aria-describedby={helpId}
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKey}
            />
            <button
              type="button"
              className="wx-gsearch-close"
              aria-label="Close search"
              onClick={() => close(true)}
            >
              <Glyph name="close" size={16} />
            </button>
          </div>
          <p id={helpId} className="wx-gsearch-help">
            Finds whole words and the beginning of a word only (for example, "hosp" finds
            "hospice"). It does not find letters from the middle of a word or similar spellings.
            Searches the conversations you can open now.
          </p>

          {/* biome-ignore lint/a11y/useSemanticElements: <output> allows phrasing content only. */}
          <div className="wx-gsearch-status" role="status" aria-live="polite">
            {statusText(query, state)}
          </div>

          {state.status === "loading" ? (
            <div className="wx-gsearch-skeleton" aria-hidden="true">
              {SKELETON_KEYS.map((key) => (
                <span key={key} className="wx-gsearch-skeleton-row" />
              ))}
            </div>
          ) : null}

          {state.failure ? (
            <div className="wx-gsearch-error" role="alert">
              <span>{failureText(state.failure)}</span>
              {canRetry ? (
                <Button size="sm" tone="secondary" onClick={retry}>
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}

          {openFailed ? (
            <div className="wx-gsearch-error" role="alert">
              <span>That conversation is no longer available to you.</span>
            </div>
          ) : null}

          {state.status === "ready" && state.results.length > 0 ? (
            <ul ref={listRef} className="wx-gsearch-results" aria-label="Search results">
              {state.results.map((hit, index) => {
                const name = channelName(hit.channelId) ?? UNKNOWN_CHANNEL;
                return (
                  <li key={hit.messageId}>
                    <a
                      href={`?channelId=${encodeURIComponent(hit.channelId)}&messageId=${encodeURIComponent(hit.messageId)}`}
                      onClick={(event) => onPick(event, hit.channelId, hit.messageId)}
                      onKeyDown={(event) => onLinkKey(event, index)}
                    >
                      <span className="wx-gsearch-meta">
                        <strong>{name}</strong>
                        {hit.archived ? <span className="wx-gsearch-tag">Archived</span> : null}
                        <span>{hit.authorDisplayName || "Staff member"}</span>
                        <time dateTime={hit.createdAt}>{absoluteTime(hit.createdAt)}</time>
                      </span>
                      <span className="wx-gsearch-snippet">{hit.body}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {state.moreFailure ? (
            <div className="wx-gsearch-error" role="alert">
              <span>{failureText(state.moreFailure)}</span>
            </div>
          ) : null}

          {state.status === "ready" && state.nextCursor ? (
            <div className="wx-gsearch-more">
              <Button size="sm" tone="secondary" onClick={loadMore} disabled={state.loadingMore}>
                {state.loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
