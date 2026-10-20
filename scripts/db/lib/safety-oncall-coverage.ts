/**
 * Pure row builders for `db:seed:safety-oncall` — kept free of IO so the unit test can feed them to the
 * M20 / M19 watchdogs' own predicates.
 */
export const DEMO_SUPERVISION_SUBSCRIPTION_ID = "66666666-0000-4000-8000-000000000001";
export const DEMO_RN_COVERAGE_SHIFT_ID = "66666666-0000-4000-8000-000000000002";

/** Every alert class `safety_supervisor_subscription.alert_kinds` allows (CHECK m20_sss_alert_kinds_vocab). */
export const ALL_SAFETY_ALERT_KINDS = ["sos", "overdue", "incident", "high_risk_area"] as const;

const MS_PER_DAY = 86_400_000;
const COVERAGE_BACKFILL_DAYS = 1;
// ponytail: a fixed 10-year window, not a recurring rotation (oncall_rotation_entry has no recurrence and
// would make the roster sync authoritative). Re-running the seed / a prod reseed extends it.
const COVERAGE_HORIZON_DAYS = 3650;

/** One org-wide ("role" scope) row: the DON-watches-everyone layer, which covers every field clinician. */
export function buildSupervisionSubscription(
  supervisorMembershipId: string,
  organizationId: string,
) {
  return {
    id: DEMO_SUPERVISION_SUBSCRIPTION_ID,
    organizationId,
    supervisorMembershipId,
    scopeKind: "role" as const,
    alertKinds: [...ALL_SAFETY_ALERT_KINDS],
  };
}

/** A long-running active `clinical_rn` shift for the demo ProviderEntity. */
export function buildRnCoverageShift(input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly rnMembershipId: string;
  readonly now: Date;
}) {
  const startsAt = new Date(input.now.getTime() - COVERAGE_BACKFILL_DAYS * MS_PER_DAY);
  return {
    id: DEMO_RN_COVERAGE_SHIFT_ID,
    organizationId: input.organizationId,
    providerEntityId: input.providerEntityId,
    rnMembershipId: input.rnMembershipId,
    shiftStartsAt: startsAt,
    shiftEndsAt: new Date(input.now.getTime() + COVERAGE_HORIZON_DAYS * MS_PER_DAY),
    openedAt: startsAt,
  };
}
