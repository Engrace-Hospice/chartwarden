// apps/backend/src/modules/16-bereavement/care-goals.ts — ADR-0109: a bereaved contact's 1-3 care goals.
//
// Free text a counselor records WITH the family ("get back to the garden"), so it is PHI: sealed with the tenant DEK into
// `bereaved_contact.care_goals_cipher` (cipher column `bereaved_contact.care_goals`), nulled by the eraser, and withheld
// from the D10 volunteer scope and from every portal session. The sealed plaintext is a JSON array of at most three trimmed,
// non-blank strings of at most 280 characters. Pure: the encode / decode / normalize rules, no IO.
import { BereavementStateError } from "./lifecycle/errors";

/** At most this many goals per contact. */
export const CARE_GOALS_MAX = 3;
/** At most this many characters per goal. */
export const CARE_GOAL_MAX_CHARS = 280;

/**
 * The goals to store: each trimmed, none blank or over {@link CARE_GOAL_MAX_CHARS}, at most {@link CARE_GOALS_MAX}. The route's
 * TypeBox schema enforces the same bounds at the wire; this is the defense for any other caller. An empty list clears them.
 */
export function normalizeCareGoals(goals: readonly string[]): readonly string[] {
  const trimmed = goals.map((goal) => goal.trim());
  if (
    trimmed.length > CARE_GOALS_MAX ||
    trimmed.some((goal) => goal.length === 0 || goal.length > CARE_GOAL_MAX_CHARS)
  ) {
    throw new BereavementStateError(
      "CARE_GOALS_INVALID",
      `care goals are at most ${CARE_GOALS_MAX} entries of 1 to ${CARE_GOAL_MAX_CHARS} characters each`,
    );
  }
  return trimmed;
}

/** The plaintext that gets sealed. */
export const encodeCareGoals = (goals: readonly string[]): string => JSON.stringify(goals);

/**
 * The goals out of an opened blob, or null when it is not a short array of strings — a malformed value reads as unavailable,
 * never as a partial list a counselor might overwrite believing it was complete.
 */
export function decodeCareGoals(plaintext: string): readonly string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > CARE_GOALS_MAX ||
    parsed.some((goal) => typeof goal !== "string")
  ) {
    return null;
  }
  return parsed as string[];
}
