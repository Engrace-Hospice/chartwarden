// @wardenx/ui core — the in-memory hand-off for a search needle (GAP-080).
//
// WHY A STORE AND NOT A URL PARAM. A patient/global search needle is PHI: it is a patient name or
// an MRN, typed by a clinician. Carried as `?q=…` — which is how the shell top-nav search reached
// the results screen — it lands in the browser address bar, the back/forward history entry, the
// omnibox autocomplete corpus, and the profile's on-disk session-restore state, where it outlives
// the session on a shared or forensically-recovered device. That is the same exposure the results
// screen already refuses for its "recent searches" list ("MUST NOT be persisted — no
// localStorage/sessionStorage"), reached by a different door; the 2026-06-27 audit's finding #5
// flagged it as a follow-on and it was never done.
//
// react-router's `location.state` is NOT the fix: it is serialized into the same history entry and
// persisted with it. Neither is scrubbing the URL after the fact — by then it has already been
// written. The needle simply must never enter navigation state at all.
//
// So it lives here: a module-scoped variable, the same lifetime and posture as the results screen's
// in-memory `recentTerms` array. It dies on reload, on tab close, and on navigation away from the
// SPA. Nothing serializes it.
//
// A STORE rather than a one-shot "stage it, then take it": the results screen must react to a term
// staged while it is ALREADY mounted (searching again from the top-nav bar without leaving the
// page), and a read-and-clear hand-off consumed in an effect or a `useState` initializer is
// double-invoked under StrictMode in development — the second mount would find it already taken and
// render an empty search. `useSyncExternalStore` has neither problem.
import { useSyncExternalStore } from "react";

let currentTerm = "";
const listeners = new Set<() => void>();

/** Stage the needle for the search-results screen, then navigate to it WITHOUT a query string. */
export function setSearchTerm(term: string): void {
  const next = term.trim();
  if (next === currentTerm) return;
  currentTerm = next;
  for (const listener of listeners) listener();
}

/** Drop the staged needle — used when leaving the search surface deliberately. */
export function clearSearchTerm(): void {
  setSearchTerm("");
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): string => currentTerm;

/**
 * The staged search needle. Empty string when nothing is staged — which is what a cold load of
 * `/search` sees, by design: a search URL is not bookmarkable, because a bookmarkable search URL
 * is a PHI leak with a nicer name.
 */
export function useSearchTerm(): string {
  // Same snapshot on the server as on the client: nothing is staged during SSR/prerender.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test seam — reset the module-scoped needle between cases. */
export function __resetSearchTermForTest(): void {
  currentTerm = "";
  listeners.clear();
}
