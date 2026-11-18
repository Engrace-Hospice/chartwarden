// apps/web/src/modules/21-supplies — one write's `busy` flag, held for the WHOLE call and released on every path.
//
// `FormDrawer` refuses Cancel / Close / Escape while `busy` and marks the page inert, so a `busy` that never comes
// back strands the drawer (and every Save) until a reload. `client.POST` REJECTS on a network failure (there is no
// error middleware), so the release lives in a `finally` and a rejection is turned into a refusal message the screen
// shows like any server refusal.
import { useCallback, useState } from "react";
import { errorMessage } from "./supplies-api";

/** Resolves to the refusal's message, or null when the write succeeded. */
export type RunWrite = (
  write: () => Promise<{ error: unknown }>,
  failure: string,
) => Promise<string | null>;

export function useWrite(): { busy: boolean; run: RunWrite } {
  const [busy, setBusy] = useState(false);
  const run = useCallback<RunWrite>(async (write, failure) => {
    setBusy(true);
    try {
      const { error } = await write();
      return error ? errorMessage(error, failure) : null;
    } catch (thrown) {
      return errorMessage(thrown, failure);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
