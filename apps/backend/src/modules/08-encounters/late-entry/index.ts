// apps/backend/src/modules/08-encounters/late-entry — M8-T07 (§2.5 D4 late-entry tiers).
//
// The pure §2.5 late-entry domain: the three-tier clock (`tiers.ts` — computed at finalize-time and
// reified on `encounter.late_entry_tier`) and the two override workflows + the sign-gate guard
// (`override.ts` — §7.5 significant 3–14d Clinical Supervisor override, §7.6 administrative >14d Director
// override). Every fact (the org-local finalize day, the caller's role, step-up freshness) is injected,
// so the tier binning and the override guards are deterministic and unit-testable with no DB. The service
// layer (M8-T09) composes `computeLateEntryTier` into the finalize transition's `set_late_entry_tier`
// effect, `checkLateEntryOverrideSatisfied` into the sign gate (§2.3 check 5), and the override deciders
// behind routes 15/16.
export {
  LATE_ENTRY_TIER_DAY_CEILINGS,
  computeLateEntryTier,
  daysLate,
  lateEntryBanner,
} from "./tiers";
export {
  checkLateEntryOverrideSatisfied,
  decideAdministrativeLateOverride,
  decideSignificantLateOverride,
  requiresLateEntryOverride,
} from "./override";
