// UR — what every save in the two review panels shares. The write helpers in doclens-api return a
// result for a refusal, but the API client rethrows when no response arrived at all (offline, reset
// connection): a panel that awaits one bare would stay "Saving" forever and leave the rejection
// unhandled. `settle` turns that rejection into null so the panel can say so and unlock.
import type { ReviewResult, Workspace } from "../doclens-api";

export const UNREACHABLE_DECISION_MESSAGE =
  "Could not reach the server. The decision may not be saved; retry.";

export const REFRESH_FAILED_MESSAGE =
  "Decision saved, but the workspace could not be refreshed. Retry before continuing.";

/** Runs a request that may reject. Null means it rejected or resolved to null: it did not complete. */
export async function settle<T>(run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/**
 * The write behind one safeguard resolution (Part 2 / SUD or a document's patient identity), its
 * refresh, and the busy and error reporting around them. True only when both succeeded.
 */
export async function saveSafeguard<T>({
  write,
  refresh,
  onBusy,
  onError,
  refreshFailedMessage,
}: {
  write: () => Promise<ReviewResult<T>>;
  refresh: () => Promise<Workspace | null>;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  refreshFailedMessage: string;
}): Promise<boolean> {
  onBusy(true);
  onError(null);
  const result = await settle(write);
  if (result === null || !result.ok) {
    onBusy(false);
    onError(result === null ? UNREACHABLE_DECISION_MESSAGE : result.message);
    return false;
  }
  const latest = await settle(refresh);
  onBusy(false);
  if (latest === null) onError(refreshFailedMessage);
  return latest !== null;
}
