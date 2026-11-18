// apps/web/src/modules/19-oncall — one write behind a form drawer. `FormDrawer` keeps the page inert and the drawer
// undismissable for exactly as long as `busy` is true, so `busy` must cover the WHOLE call and must end even when the
// API client REJECTS (a network failure rejects; it does not resolve with `error`). Otherwise the drawer is stuck.
import { errorMessage } from "./oncall-api";

export const NO_ANSWER_MESSAGE = "That did not go through. Check your connection and try again.";

/**
 * Runs `write` with `busy` true for its whole duration and false after it settles. Clears the drawer's error first,
 * then sets it to the server's refusal (or `NO_ANSWER_MESSAGE` when the call threw). Resolves true only when the
 * write succeeded, so the caller can close the drawer.
 */
export async function runDrawerWrite(
  state: { setBusy: (busy: boolean) => void; setError: (message: string | null) => void },
  write: () => Promise<{ error: unknown }>,
  fallback: string,
): Promise<boolean> {
  state.setBusy(true);
  state.setError(null);
  try {
    const { error } = await write();
    if (!error) return true;
    state.setError(errorMessage(error, fallback));
    return false;
  } catch {
    state.setError(NO_ANSWER_MESSAGE);
    return false;
  } finally {
    state.setBusy(false);
  }
}
