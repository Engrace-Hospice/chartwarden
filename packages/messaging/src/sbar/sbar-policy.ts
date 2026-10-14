// @wardenx/messaging - the tenant SBAR policy (M36 WP 3.3): tighten-only over the platform floor.
//
// A tenant may raise a section's minimum length, require a patient (care_team) channel and re-word the per-section hint.
// It may not go below the floor and may not turn SBAR off (the `messaging.sbar` ops flag is the off switch).
// `effectiveSbarPolicy` re-applies the floor on EVERY read, so a stored value written under an older floor, or edited in
// the database, can never loosen the current one. Hints are PHI-linted on save (`prepareSbarPolicy`) and on read.
import {
  type EffectiveSbarPolicy,
  SBAR_PLATFORM_FLOOR,
  SBAR_SECTION_KEYS,
  type SbarSectionKey,
  WardenXError,
} from "@wardenx/types";
import {
  PHI_FINDING_MESSAGES,
  lintTemplateText,
  stripInvisibleCharacters,
} from "../templates/phi-lint";

/** The tenant-settable ceiling for a section minimum; the SQL CHECK says the same (pinned by a test). */
export const SBAR_MIN_CHARS_CEILING = 500;
export const SBAR_HINT_MAX_CHARS = 200;

/** Channel kinds that never carry SBAR (broadcast / bereavement). */
export const SBAR_DENIED_CHANNEL_KINDS: readonly string[] = ["announcement", "bereavement"];

export const PLATFORM_SBAR_HINTS: Readonly<Record<SbarSectionKey, string>> = {
  situation: "What is happening right now?",
  background: "What is the relevant context?",
  assessment: "What do you think the problem is?",
  recommendation: "What do you need, and by when?",
};

/** What the tenant row holds. `hints` carries only customised sections. */
export interface StoredSbarPolicy {
  readonly minChars: Readonly<Record<SbarSectionKey, number>>;
  readonly requirePatientChannel: boolean;
  readonly hints: Readonly<Partial<Record<SbarSectionKey, string>>>;
}

export interface SbarPolicyInput {
  readonly minChars?: Readonly<Partial<Record<SbarSectionKey, number>>> | undefined;
  readonly requirePatientChannel?: boolean | undefined;
  readonly hints?: Readonly<Partial<Record<SbarSectionKey, string | null>>> | undefined;
}

const passesLint = (text: string): boolean => lintTemplateText(text).length === 0;

/** The policy in force: the floor, tightened by the stored row (when there is one). Never below the floor. */
export function effectiveSbarPolicy(stored: StoredSbarPolicy | null): EffectiveSbarPolicy {
  const minChars = {} as Record<SbarSectionKey, number>;
  const hints = {} as Record<SbarSectionKey, string>;
  for (const key of SBAR_SECTION_KEYS) {
    const raw = stored?.minChars[key];
    const tightened = Number.isFinite(raw) ? Math.floor(raw as number) : 0;
    minChars[key] = Math.max(SBAR_PLATFORM_FLOOR.minChars[key], tightened);
    const custom = stored?.hints[key]?.trim();
    hints[key] = custom && passesLint(custom) ? custom : PLATFORM_SBAR_HINTS[key];
  }
  return {
    minChars,
    requirePatientChannel:
      SBAR_PLATFORM_FLOOR.requirePatientChannel || stored?.requirePatientChannel === true,
    hints,
  };
}

const invalid = (field: string, message: string): WardenXError =>
  new WardenXError("VALIDATION_FAILED", "request validation failed", 422, [
    { field, code: "INVALID", message },
  ]);

function prepareHint(key: SbarSectionKey, raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const field = `hints.${key}`;
  const text = stripInvisibleCharacters(raw).trim();
  if (text.length === 0) return undefined;
  if (text.length > SBAR_HINT_MAX_CHARS)
    throw invalid(field, `must be at most ${SBAR_HINT_MAX_CHARS} characters`);
  const codes = lintTemplateText(text);
  if (codes.length > 0) {
    throw new WardenXError(
      "SBAR_HINT_PHI_DETECTED",
      "SBAR hints must not contain patient identifiers.",
      422,
      codes.map((code) => ({ field, code: `PHI_${code}`, message: PHI_FINDING_MESSAGES[code] })),
    );
  }
  return text;
}

/**
 * Validate a full-replace policy write. A minimum below the floor is 422 SBAR_POLICY_FLOOR_VIOLATION (the tenant cannot
 * loosen); above the ceiling or a non-integer is 422 VALIDATION_FAILED. Omitted minimums are the floor.
 */
export function prepareSbarPolicy(input: SbarPolicyInput): StoredSbarPolicy {
  const minChars = {} as Record<SbarSectionKey, number>;
  const hints: Partial<Record<SbarSectionKey, string>> = {};
  const below: string[] = [];
  for (const key of SBAR_SECTION_KEYS) {
    const value = input.minChars?.[key] ?? SBAR_PLATFORM_FLOOR.minChars[key];
    if (!Number.isInteger(value) || value > SBAR_MIN_CHARS_CEILING)
      throw invalid(`minChars.${key}`, `must be a whole number up to ${SBAR_MIN_CHARS_CEILING}`);
    if (value < SBAR_PLATFORM_FLOOR.minChars[key]) below.push(key);
    minChars[key] = value;
    const hint = prepareHint(key, input.hints?.[key]);
    if (hint !== undefined) hints[key] = hint;
  }
  if (below.length > 0) {
    throw new WardenXError(
      "SBAR_POLICY_FLOOR_VIOLATION",
      "A tenant policy cannot go below the platform floor.",
      422,
      below.map((key) => ({
        field: `minChars.${key}`,
        code: "BELOW_FLOOR",
        message: `must be at least ${SBAR_PLATFORM_FLOOR.minChars[key as SbarSectionKey]}`,
      })),
    );
  }
  return { minChars, requirePatientChannel: input.requirePatientChannel === true, hints };
}
