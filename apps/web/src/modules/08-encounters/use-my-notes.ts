// apps/web/src/modules/08-encounters — the author's open notes for My notes (ADR-0113), kept fresh. `GET /api/v1/encounters/my-drafts`
// carries the SERVER's stage and deadline per note, and a stage changes with the clock (On track becomes At risk becomes Overdue) while
// the screen is open, so one read at mount would leave a pill claiming "On track" under a banner that already says overdue. The list is
// read again when the person returns to the tab and on a slow interval. The refresh is stale-while-revalidate: the rows stay on screen
// (no spinner, no flash), and a refresh that fails keeps them. It is marked as background work so it never extends an idle session
// (GAP-002); only the first read, which the person asked for by opening the screen, is an ordinary request.
import { BACKGROUND_REQUEST_HEADERS, type operations, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";

/** One open note as `GET /encounters/my-drafts` sends it, straight from the generated contract. */
export type MyNoteRow =
  operations["getApiV1EncountersMydrafts"]["responses"][200]["content"]["application/json"]["encounters"][number];

/** How often an open My notes list is read again while the tab is visible (a stage can only change by the clock, so a minute is plenty). */
export const MY_NOTES_REFRESH_MS = 60_000;
export const MY_NOTES_LOAD_ERROR = "Could not load your notes.";

export interface MyNotes {
  readonly items: readonly MyNoteRow[];
  /** True only until the first answer: a refresh never flips it back. */
  readonly loading: boolean;
  /** Set only while there is nothing to show because the first read failed; a failed refresh never sets it. */
  readonly error: string | null;
}

export function useMyNotes(): MyNotes {
  const client = useApiClient();
  const [items, setItems] = useState<readonly MyNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const read = async (background: boolean): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { data, error: refused } = background
          ? await client.GET("/api/v1/encounters/my-drafts", {
              headers: BACKGROUND_REQUEST_HEADERS,
            })
          : await client.GET("/api/v1/encounters/my-drafts");
        if (!active) return;
        if (refused || !data) {
          // A failed refresh keeps the rows already shown; only a first read with nothing to show is an error.
          if (!background) setError(MY_NOTES_LOAD_ERROR);
          return;
        }
        setItems(data.encounters);
        setError(null);
      } catch {
        if (active && !background) setError(MY_NOTES_LOAD_ERROR);
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    const refreshWhenVisible = (): void => {
      if (!document.hidden) void read(true);
    };
    void read(false);
    const timer = window.setInterval(refreshWhenVisible, MY_NOTES_REFRESH_MS);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [client]);

  return { items, loading, error };
}
