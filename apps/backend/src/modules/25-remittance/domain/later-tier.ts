// M25 milestone 7a-1 - later-tier (ALJ / Council / federal court) RECORD-KEEPING. PURE.
//
// Facts are recorded, not ruled. The amount in controversy is stored and never compared to a threshold; no window
// or form is encoded here. The 60-day windows M25 already ships for these tiers (`TIER_WINDOW_DAYS`) are untouched
// but not SME-confirmed: `LATER_TIER_WINDOWS_CONFIRMED` is the ONE place that says so, flipped only on SME sign-off,
// and the screens badge every computed later-tier deadline from it. A federal-court civil action is filed by counsel,
// so WardenX renders and sends nothing for that tier (record-only).
import { isRealDay } from "./recorded-deadline";
import type { AppealTier } from "./types";

export const LATER_TIERS = ["alj", "council", "federal_court"] as const;
export type LaterTier = (typeof LATER_TIERS)[number];

/** SME item 1: whether the M1 sign-off covers the tier 3-5 windows. Flip to true per tier only on sign-off. */
export const LATER_TIER_WINDOWS_CONFIRMED: Readonly<Record<LaterTier, boolean>> = {
  alj: false,
  council: false,
  federal_court: false,
};

export const DISPOSITION_KINDS = ["decision", "remand", "dismissal", "other"] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

export const TIER_DETAIL_TEXT_MAX = 200;
export const TIER_DISPOSITION_NOTE_MAX = 500;

export type TierDetailRefusal =
  | "TIER_NOT_LATER"
  | "AMOUNT_INVALID"
  | "HEARING_ON_INVALID"
  | "HEARING_NOT_RECORDED"
  | "FILED_BY_COUNSEL_INVALID"
  | "FEDERAL_ONLY_FIELD"
  | "DISPOSITION_INVALID"
  | "DISPOSITION_KIND_REQUIRED"
  | "DISPOSITION_NOTE_REQUIRED"
  | "TEXT_TOO_LONG";

export function isLaterTier(tier: string): tier is LaterTier {
  return (LATER_TIERS as readonly string[]).includes(tier);
}

/** True for a later-tier deadline whose shipped window is not SME-confirmed (the badge). */
export function windowUnconfirmed(tier: AppealTier): boolean {
  return isLaterTier(tier) && !LATER_TIER_WINDOWS_CONFIRMED[tier];
}

/** Federal court is record-only: a packet is never rendered or submitted for it. */
export function canPacketRender(tier: AppealTier): boolean {
  return tier !== "federal_court";
}

export interface TierDetailInput {
  readonly authorityReference?: string | null;
  readonly amountInControversyCents?: number | null;
  readonly hearingOn?: string | null;
  readonly hearingFormatNote?: string | null;
  readonly dispositionKind?: string | null;
  readonly dispositionNote?: string | null;
  readonly filedByCounselOn?: string | null;
  readonly docketReference?: string | null;
}

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

export function checkTierDetail(tier: string, input: TierDetailInput): TierDetailRefusal | null {
  if (!isLaterTier(tier)) return "TIER_NOT_LATER";
  const a = input.amountInControversyCents;
  if (a !== undefined && a !== null && (!Number.isInteger(a) || a < 0)) return "AMOUNT_INVALID";
  if (present(input.hearingOn)) {
    if (tier === "federal_court") return "HEARING_NOT_RECORDED";
    if (!isRealDay(input.hearingOn as string)) return "HEARING_ON_INVALID";
  }
  if (present(input.hearingFormatNote) && tier === "federal_court") return "HEARING_NOT_RECORDED";
  if (present(input.filedByCounselOn) || present(input.docketReference)) {
    if (tier !== "federal_court") return "FEDERAL_ONLY_FIELD";
    if (present(input.filedByCounselOn) && !isRealDay(input.filedByCounselOn as string)) {
      return "FILED_BY_COUNSEL_INVALID";
    }
  }
  for (const t of [
    input.authorityReference,
    input.hearingFormatNote,
    input.docketReference,
  ] as const) {
    if (typeof t === "string" && t.length > TIER_DETAIL_TEXT_MAX) return "TEXT_TOO_LONG";
  }
  if (
    typeof input.dispositionNote === "string" &&
    input.dispositionNote.length > TIER_DISPOSITION_NOTE_MAX
  ) {
    return "TEXT_TOO_LONG";
  }
  if (present(input.dispositionKind)) {
    if (!(DISPOSITION_KINDS as readonly string[]).includes(input.dispositionKind as string)) {
      return "DISPOSITION_INVALID";
    }
    if (input.dispositionKind === "other" && !present(input.dispositionNote)) {
      return "DISPOSITION_NOTE_REQUIRED";
    }
  } else if (present(input.dispositionNote)) {
    return "DISPOSITION_KIND_REQUIRED";
  }
  return null;
}

/** A remand, dismissal or other disposition is a label only: it spawns nothing and needs a person to look. */
export function dispositionNeedsManualReview(kind: string | null | undefined): boolean {
  return kind === "remand" || kind === "dismissal" || kind === "other";
}
