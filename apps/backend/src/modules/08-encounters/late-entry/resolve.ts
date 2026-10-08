// apps/backend/src/modules/08-encounters/late-entry/resolve.ts — GAP-013: the one place the §2.5 late-entry
// policy is APPLIED to an encounter.
//
// `computeLateEntryTier`, `checkLateEntryReason` and `checkLateEntryOverrideSatisfied` existed since M8-T07
// and were called by nothing but their own test, so every encounter finalized and signed as `normal` however
// late the note was. This composes them: the tier comes from `service_date` against the org-local day (never
// from the client), the reason is required from `late_entry` up, and — at sign — the matching supervisor /
// director override must already be recorded. Pure; the service injects the org-local day and the facts.
import type { LateEntryTier, LocalDate } from "@wardenx/types";
import { TEXT_MINIMUMS, checkLateEntryReason } from "../lifecycle/validation";
import { checkLateEntryOverrideSatisfied } from "./override";
import { computeLateEntryTier, daysLate } from "./tiers";

export interface LateEntryResolution {
  readonly tier: LateEntryTier;
  readonly daysLate: number;
  /** The reason in force (supplied now, else the one already on the row), trimmed; null when none. */
  readonly reason: string | null;
}

export function resolveLateEntry(input: {
  readonly serviceDate: LocalDate;
  /** The org-local calendar day the note is being finalized / signed. */
  readonly asOfDate: LocalDate;
  readonly persistedReason: string | null;
  readonly suppliedReason: string | null;
  readonly significantOverridePresent: boolean;
  readonly administrativeOverridePresent: boolean;
  /** true at sign (the override must already exist); false at finalize (the reason only). */
  readonly requireOverride: boolean;
}): LateEntryResolution {
  const tier = computeLateEntryTier({
    serviceDate: input.serviceDate,
    asOfDate: input.asOfDate,
  });
  const reason = input.suppliedReason?.trim() || input.persistedReason?.trim() || null;
  checkLateEntryReason({ tier, reason });
  if (input.requireOverride) {
    checkLateEntryOverrideSatisfied({
      tier,
      significantOverridePresent: input.significantOverridePresent,
      administrativeOverridePresent: input.administrativeOverridePresent,
    });
  }
  return { tier, daysLate: daysLate(input.serviceDate, input.asOfDate), reason };
}

const OVERRIDE_TIERS: ReadonlyArray<LateEntryTier> = [
  "significant_late_entry",
  "administrative_override",
];

/**
 * The tier to WRITE to `encounter.late_entry_tier`. The two override tiers are only valid on the row once
 * their override columns exist (the `encounter_*_consistency` CHECKs), and only the override routes write
 * those; so a computed override tier is never reified here, and a tier already raised by an override is
 * never lowered by a re-finalize. `normal` / `late_entry` are reified as computed.
 */
export function reifiableTier(current: LateEntryTier, computed: LateEntryTier): LateEntryTier {
  if (OVERRIDE_TIERS.includes(current)) return current;
  return OVERRIDE_TIERS.includes(computed) ? current : computed;
}

/** Keep the author's own late-entry reason when it already satisfies the >= 40 char CHECK; else use the override's. */
export function keepOrReplaceReason(existing: string | null, overrideReason: string): string {
  return (existing?.trim().length ?? 0) >= TEXT_MINIMUMS.lateEntryReason
    ? (existing as string)
    : overrideReason;
}
