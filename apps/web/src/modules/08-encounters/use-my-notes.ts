// apps/web/src/modules/08-encounters — the author's open notes for My notes (ADR-0113), kept fresh. `GET /api/v1/encounters/my-drafts`
// carries the SERVER's stage and deadline per note, and a stage changes with the clock (On track becomes At risk becomes Overdue) while
// the screen is open, so one read at mount would leave a pill claiming "On track" under a banner that already says overdue. The list is
// read again when the person returns to the tab and on a slow interval (the shell's refresh cues). The refresh is stale-while-revalidate:
// the rows stay on screen (no spinner, no flash), and a refresh that fails keeps them. One rule for what a read is (see
// shell/use-refresh-cues.ts): opening the screen is the person's, an ordinary request; a cue's read is background work, so it never
// extends an idle session (GAP-002).
import { BACKGROUND_REQUEST_HEADERS, type operations, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRefreshCues } from "../../shell/use-refresh-cues";
import { useIsMounted } from "./use-is-mounted";

/** One open note as `GET /encounters/my-drafts` sends it, straight from the generated contract. */
export type MyNoteRow =
  operations["getApiV1EncountersMydrafts"]["responses"][200]["content"]["application/json"]["encounters"][number];

/** What a row without a `closure` is: a legacy note (no clock, no deadline, never alerts). */
const LEGACY_CLOSURE: MyNoteRow["closure"] = {
  clockStartedAt: null,
  deadlineAt: null,
  stage: "ok",
};

/**
 * A backend replica from before the clock (a deploy overlap) or a stale cache sends rows with no `closure`; the screen reads it on every
 * row, so a missing one is a legacy note, never an exception that takes the whole screen to the error boundary.
 */
const withClosure = (row: MyNoteRow): MyNoteRow => ({
  ...row,
  closure: row.closure ?? LEGACY_CLOSURE,
});

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
  const mounted = useIsMounted();
  const [items, setItems] = useState<readonly MyNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const read = useCallback(
    async (background: boolean): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { data, error: refused } = background
          ? await client.GET("/api/v1/encounters/my-drafts", {
              headers: BACKGROUND_REQUEST_HEADERS,
            })
          : await client.GET("/api/v1/encounters/my-drafts");
        if (!mounted.current) return;
        if (refused || !data) {
          // A failed refresh keeps the rows already shown; only a first read with nothing to show is an error.
          if (!background) setError(MY_NOTES_LOAD_ERROR);
          return;
        }
        setItems(data.encounters.map(withClosure));
        setError(null);
      } catch {
        if (mounted.current && !background) setError(MY_NOTES_LOAD_ERROR);
      } finally {
        inFlight.current = false;
        if (mounted.current) setLoading(false);
      }
    },
    [client, mounted],
  );

  useEffect(() => {
    void read(false);
  }, [read]);
  useRefreshCues(() => void read(true), MY_NOTES_REFRESH_MS);

  return { items, loading, error };
}
