// apps/web/src/modules/21-supplies — one write's `busy` flag, held for the WHOLE call and released on every path.
//
// `FormDrawer` refuses Cancel / Close / Escape while `busy` and marks the page inert, so a `busy` that never comes
// back strands the drawer (and every Save) until a reload. `client.POST` REJECTS on a network failure (there is no
// error middleware), so the release lives in a `finally` and a rejection is turned into a message the screen shows like
// any server refusal.
import { useCallback, useState } from "react";
import { errorMessage } from "./supplies-api";

/** A rejected request is a LOST REPLY, not a refusal: the write may have landed, so the copy never says it failed. */
export const NO_ANSWER_MESSAGE =
  "No answer came back; it may not have been recorded. Check your connection, then retry.";

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
    } catch {
      return NO_ANSWER_MESSAGE;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
