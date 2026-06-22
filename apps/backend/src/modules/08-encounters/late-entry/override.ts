// apps/backend/src/modules/08-encounters/late-entry/override.ts — M8-T07 (§2.5 D4, §7.5, §7.6).
//
// The two §2.5 late-entry OVERRIDE workflows that unblock a sign when the computed tier demands an
// elevated approval, plus the sign-gate guard that refuses the sign until one is present:
//   significant_late_entry (72h–14d) → a Clinical Supervisor opens route 15, supplies an own reason ≥ 40
//     chars, step-up authenticates; `m8.encounter.late_entry_override` (warn) publishes (§7.5).
//   administrative_override (>14d)    → a Director (DON/Compliance, perm `encounter.administrative_override`)
//     opens route 16, supplies a reason ≥ 100 chars, step-up authenticates; `m8.encounter.administrative_override`
//     (critical) publishes to the compliance register (§7.6).
// PURE, same shape as the cosignature machine: enumerated guards (each raises the §2.5 code via
// EncounterStateError) returning the §2.8 in-transaction side-effect list the service executes. Every
// fact (the tier, the caller's role/permission, step-up freshness) is injected — no IO, no cross-module
// schema import. The override reified columns (`significant_late_override_by`/`_reason`,
// `administrative_override_by`/`_reason`) back the DB CHECK constraints the service writes within the tx.
import type { LateEntryTier } from "@wardenx/types";
import type { EncounterSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";
import { TEXT_MINIMUMS } from "../lifecycle/validation";

/** The §2.5 tiers that require a recorded override before the encounter may sign. */
const OVERRIDE_REQUIRED_TIERS: ReadonlyArray<LateEntryTier> = [
  "significant_late_entry",
  "administrative_override",
];

/** Whether `tier` demands an override approval before sign (§2.5). */
export function requiresLateEntryOverride(tier: LateEntryTier): boolean {
  return OVERRIDE_REQUIRED_TIERS.includes(tier);
}

/**
 * Apply the §7.5 significant-late-entry override (route 15). Guards: the computed tier must actually be
 * `significant_late_entry` (an override on the wrong tier is `LATE_ENTRY_TIER_MISMATCH`), the caller must
 * be a Clinical Supervisor (perm `encounter.late_entry_override`), supply an own reason ≥ 40 chars, and
 * have a fresh step-up (D13). Returns the side effects that reify the override on the encounter row +
 * audit (`encounter.significant_late_entry_overridden`) + the warn `m8.encounter.late_entry_override`
 * outbox. The encounter still signs through the §2.3 machine afterwards — this only clears the gate.
 */
export function decideSignificantLateOverride(input: {
  readonly tier: LateEntryTier;
  readonly isSupervisor: boolean;
  readonly reason: string;
  readonly stepUpFresh: boolean;
}): ReadonlyArray<EncounterSideEffect> {
  require_(
    input.tier === "significant_late_entry",
    "LATE_ENTRY_TIER_MISMATCH",
    `significant-late override applies only to a 'significant_late_entry' tier, not '${input.tier}'`,
  );
  require_(
    input.isSupervisor,
    "SIGNIFICANT_LATE_OVERRIDE_NOT_PERMITTED",
    "only a Clinical Supervisor (encounter.late_entry_override) may approve a significant late entry",
  );
  require_(
    input.reason.trim().length >= TEXT_MINIMUMS.significantLateOverrideReason,
    "SIGNIFICANT_LATE_OVERRIDE_REASON_TOO_SHORT",
    `significant-late override reason must be ≥ ${TEXT_MINIMUMS.significantLateOverrideReason} characters`,
  );
  require_(input.stepUpFresh, "STEP_UP_AUTH_REQUIRED", "override requires fresh step-up auth");
  return [
    { kind: "set_field", field: "significant_late_override_by" },
    { kind: "set_field", field: "significant_late_override_reason" },
    { kind: "audit" },
    { kind: "outbox", event: "m8.encounter.late_entry_override" },
  ];
}

/**
 * Apply the §7.6 administrative-override (route 16, > 14 days). Guards: the computed tier must be
 * `administrative_override` (else `LATE_ENTRY_TIER_MISMATCH`), the caller must hold the director
 * permission `encounter.administrative_override`, supply a reason ≥ 100 chars, and have a fresh step-up
 * (D13). Returns the side effects reifying the override + audit (`encounter.administrative_late_override`)
 * + the critical `m8.encounter.administrative_override` outbox routed to the M30 compliance register.
 */
export function decideAdministrativeLateOverride(input: {
  readonly tier: LateEntryTier;
  readonly isDirector: boolean;
  readonly reason: string;
  readonly stepUpFresh: boolean;
}): ReadonlyArray<EncounterSideEffect> {
  require_(
    input.tier === "administrative_override",
    "LATE_ENTRY_TIER_MISMATCH",
    `administrative override applies only to an 'administrative_override' tier, not '${input.tier}'`,
  );
  require_(
    input.isDirector,
    "ADMINISTRATIVE_OVERRIDE_NOT_PERMITTED",
    "only a Director (encounter.administrative_override) may approve a >14-day administrative late entry",
  );
  require_(
    input.reason.trim().length >= TEXT_MINIMUMS.administrativeOverrideReason,
    "ADMINISTRATIVE_OVERRIDE_REASON_TOO_SHORT",
    `administrative override reason must be ≥ ${TEXT_MINIMUMS.administrativeOverrideReason} characters`,
  );
  require_(input.stepUpFresh, "STEP_UP_AUTH_REQUIRED", "override requires fresh step-up auth");
  return [
    { kind: "set_field", field: "administrative_override_by" },
    { kind: "set_field", field: "administrative_override_reason" },
    { kind: "audit" },
    { kind: "outbox", event: "m8.encounter.administrative_override" },
  ];
}

/**
 * The §2.3 Layer-3 gate-check (item 5): at sign, a `significant_late_entry`/`administrative_override`
 * encounter must already carry the matching recorded override (route 15/16) — otherwise the sign refuses
 * with the tier-specific code so the UI directs the right approver. Pure: the service resolves whether the
 * override columns are populated and passes the booleans. `normal`/`late_entry` tiers are unaffected.
 */
export function checkLateEntryOverrideSatisfied(input: {
  readonly tier: LateEntryTier;
  readonly significantOverridePresent: boolean;
  readonly administrativeOverridePresent: boolean;
}): void {
  if (input.tier === "significant_late_entry") {
    require_(
      input.significantOverridePresent,
      "SIGNIFICANT_LATE_ENTRY_OVERRIDE_REQUIRED",
      "a significant late entry (3–14 days) requires a Clinical Supervisor override before sign",
    );
  } else if (input.tier === "administrative_override") {
    require_(
      input.administrativeOverridePresent,
      "ADMINISTRATIVE_LATE_OVERRIDE_REQUIRED",
      "an administrative late entry (>14 days) requires a Director override before sign",
    );
  }
}
