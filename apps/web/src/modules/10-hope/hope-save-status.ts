// apps/web/src/modules/10-hope — where the assessment screen's autosave stands, and the "reload the latest version" notice a
// refused (stale) save leaves behind. Kept out of `hope-assessment-detail.tsx` so the rule for when that notice ends is
// one small, testable place.

/**
 * Where the autosave stands. `conflict`: the server refused a save as stale and the page is still the old one (reload it).
 * `reloaded`: the page re-read itself after such a conflict, so it is current, but the refused change was not applied.
 * `failed`: the server refused the save, so it was not applied. `unconfirmed`: no usable answer (a rejection, a timeout, an
 * empty or faulting 5xx), so the save may have been applied: never worded as "failed".
 */
export type SaveStatus =
  | "idle"
  | "saving"
  | "saved"
  | "failed"
  | "unconfirmed"
  | "conflict"
  | "reloaded";

/** What an item shows when its save was refused as stale. */
export const CONFLICT_FIELD_ERROR =
  "This assessment changed elsewhere. Reload the latest version before continuing.";

/** The item messages with the "reload the latest version" ones removed: after a re-read they no longer describe the page. */
export function withoutConflictErrors(errors: Record<string, string>): Record<string, string> {
  const kept = Object.entries(errors).filter(([, message]) => message !== CONFLICT_FIELD_ERROR);
  return kept.length === Object.keys(errors).length ? errors : Object.fromEntries(kept);
}
