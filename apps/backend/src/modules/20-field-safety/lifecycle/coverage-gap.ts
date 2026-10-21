// apps/backend/src/modules/20-field-safety/lifecycle/coverage-gap.ts — M20-T03 (§2.2.5, §4.8
// `m20.coverage-gap-watchdog.cron`, §7.8, D8).
//
// The watchdog that answers the question no dashboard asks: not "is this clinician OK?" but "if she were
// not, would anybody's phone ring?". §7.8's scenario is a newly-provisioned RN who is visible on every board
// and subscribed to by nobody — every screen shows her as fine, and her SOS at 22:00 would resolve to an
// empty recipient list.
//
// D8'S SUBSCRIPTION MODEL IS LAYERED AND THE LAYERS ARE ADDITIVE. A clinician is covered if ANY active row
// reaches her:
//   • `explicit`        — the row names her directly;
//   • `location`        — the row names a location she works at;
//   • `provider_entity` — the row names her provider entity;
//   • `role`            — the DON-watches-everyone layer; it carries no selector and covers the whole org.
// §2.2.5's uniqueness rule (and migration 0110's `NULLS NOT DISTINCT` index) keeps one row per pair, so a
// clinician covered twice is a configuration to review, not a bug this watchdog reports.
//
// THE ALERT IS SYSTEM-LOCKED AND CRITICAL (§4.9), SO THE REASON IS A CLOSED UNION. A free-text reason cannot
// be triaged by the DON it wakes at 3 a.m.; `SafetyCoverageGapReason` (@chartwarden/types) has exactly three
// members and each one implies a different fix:
//   • `no_subscription`               — nobody ever subscribed. Add a row.
//   • `all_subscriptions_deactivated` — somebody did, and every one of those rows is now deactivated or
//                                       superseded (the supervisor left). Re-point them.
//   • `vacation_forwards_unresolved`  — she IS covered, but every covering row forwards to a target that is
//                                       not an active supervisor. This is the WORST of the three, because
//                                       the configuration LOOKS complete: the row exists, the resolver
//                                       returns it, and M36 delivers to a membership that will not answer.
//
// FAIL DIRECTION: a clinician the watchdog cannot classify is reported as a GAP. Over-reporting costs the
// DON a false page; under-reporting costs a clinician her only escalation path.
import type {
  MembershipId,
  SafetyAlertKind,
  SafetyCoverageGapDto,
  SafetyCoverageGapReason,
} from "@chartwarden/types";

/** One `safety_supervisor_subscription` row as the watchdog sees it (active rows only — the caller's query
 *  already applies `superseded_at IS NULL AND deactivated_at IS NULL` through `sss_clinician_idx`). */
export interface SafetySubscriptionFacts {
  readonly supervisorMembershipId: MembershipId;
  readonly scopeKind: "explicit" | "location" | "provider_entity" | "role";
  readonly clinicianMembershipId: MembershipId | null;
  readonly locationId: string | null;
  readonly providerEntityId: string | null;
  readonly alertKinds: readonly string[];
  readonly isVacationForwarding: boolean;
  readonly vacationForwardToMembershipId: MembershipId | null;
}

/** One field-eligible clinician the watchdog checks. */
export interface SafetyCoverageSubjectFacts {
  readonly membershipId: MembershipId;
  /** Every location she works at — a traveling clinician has more than one, and a location-scoped row
   *  covering ANY of them covers her. */
  readonly locationIds: readonly string[];
  readonly providerEntityId: string;
  /** §2.2.5 — the watchdog only asks about clinicians who may be in the field. */
  readonly isFieldEligible: boolean;
  /** Whether this clinician has ever had a subscription row, active or not. Distinguishes
   *  `no_subscription` from `all_subscriptions_deactivated`; a `deactivated_at IS NOT NULL` row does not
   *  come back in the active query, so the caller counts them separately. */
  readonly hasInactiveSubscriptions: boolean;
}

/**
 * D8's SCOPE layering alone — does this row's scope selector reach this clinician, ignoring which alert
 * kinds it pages on?
 *
 * Split out from {@link subscriptionCovers} for M20-T06's `supervises_clinician` ABAC predicate, and the
 * split is a decision rather than a refactor: AUTHORIZATION and PAGING ask different questions of the same
 * row. "May this supervisor read her safety record?" is answered by the SCOPE — a supervisor subscribed
 * only to `overdue` still watches this clinician, and 403-ing her out of the SOS she is looking at because
 * her row does not page on `sos` would be an authorization rule nobody wrote. "Whose phone rings tonight?"
 * additionally requires the alert kind, which is what {@link subscriptionCovers} adds on top.
 *
 * One switch, two callers — duplicating it in `abac-predicates.ts` would let a paging rule and an access
 * rule drift apart, which is worse than either version of it.
 */
export function subscriptionScopeCovers(
  subscription: Pick<
    SafetySubscriptionFacts,
    "scopeKind" | "clinicianMembershipId" | "locationId" | "providerEntityId"
  >,
  subject: Pick<SafetyCoverageSubjectFacts, "membershipId" | "locationIds" | "providerEntityId">,
): boolean {
  switch (subscription.scopeKind) {
    case "explicit":
      return subscription.clinicianMembershipId === subject.membershipId;
    case "location":
      return (
        subscription.locationId !== null && subject.locationIds.includes(subscription.locationId)
      );
    case "provider_entity":
      return subscription.providerEntityId === subject.providerEntityId;
    case "role":
      // The org-wide layer. No selector to match — it covers everyone by construction (D8).
      return true;
    default:
      // Unreachable while `scopeKind` is the closed union; fails toward "not covered" if it ever is not.
      return false;
  }
}

/**
 * Does one subscription row reach this clinician for `alertKind`?
 *
 * The kind DEFAULTS to `sos` because that is the only channel this watchdog's guarantee is about — a row
 * that does not page on `sos` is not coverage for the purpose §7.8 exists to protect, however complete it
 * looks on the subscription matrix. It is a parameter rather than a constant because the §4.3
 * `SafetySupervisorProvider.supervisorsForClinician` resolves the SAME scope layering for `overdue`,
 * `incident` and `high_risk_area` (M20-T05), and duplicating the D8 scope switch there would let the two
 * copies drift — a paging rule that is subtly different depending on which caller asked is worse than
 * either version of it.
 */
export function subscriptionCovers(
  subscription: SafetySubscriptionFacts,
  subject: SafetyCoverageSubjectFacts,
  alertKind: SafetyAlertKind = "sos",
): boolean {
  if (!subscription.alertKinds.includes(alertKind)) return false;
  return subscriptionScopeCovers(subscription, subject);
}

/** §7.8 — the gap verdict for ONE clinician, or `null` when she is covered. */
export function coverageGapFor(input: {
  readonly subject: SafetyCoverageSubjectFacts;
  readonly activeSubscriptions: readonly SafetySubscriptionFacts[];
  /** The memberships that could actually answer a page right now — active supervisors. A vacation forward
   *  to somebody outside this set is a page that lands nowhere. */
  readonly activeSupervisorMembershipIds: ReadonlySet<MembershipId>;
}): SafetyCoverageGapDto | null {
  const { subject } = input;
  if (!subject.isFieldEligible) return null;

  const covering = input.activeSubscriptions.filter((s) => subscriptionCovers(s, subject));

  if (covering.length === 0) {
    const reason: SafetyCoverageGapReason = subject.hasInactiveSubscriptions
      ? "all_subscriptions_deactivated"
      : "no_subscription";
    return { clinicianMembershipId: subject.membershipId, reason };
  }

  // Every covering row reaches a real, on-duty target?
  const reachable = covering.some((s) => {
    const target = s.isVacationForwarding
      ? s.vacationForwardToMembershipId
      : s.supervisorMembershipId;
    return target !== null && input.activeSupervisorMembershipIds.has(target);
  });
  if (!reachable) {
    return {
      clinicianMembershipId: subject.membershipId,
      reason: "vacation_forwards_unresolved",
    };
  }

  return null;
}

/** §4.8 `m20.coverage-gap-watchdog.cron` / §4.3 `SafetySupervisorProvider.coverageGapsForOrg` — the whole
 *  org, in one pass. Deterministically ordered by membership id so two runs over the same data emit the
 *  same alert sequence and a diff of two hourly runs is readable. */
export function detectCoverageGaps(input: {
  readonly subjects: readonly SafetyCoverageSubjectFacts[];
  readonly activeSubscriptions: readonly SafetySubscriptionFacts[];
  readonly activeSupervisorMembershipIds: ReadonlySet<MembershipId>;
}): readonly SafetyCoverageGapDto[] {
  return input.subjects
    .map((subject) =>
      coverageGapFor({
        subject,
        activeSubscriptions: input.activeSubscriptions,
        activeSupervisorMembershipIds: input.activeSupervisorMembershipIds,
      }),
    )
    .filter((gap): gap is SafetyCoverageGapDto => gap !== null)
    .sort((a, b) => a.clinicianMembershipId.localeCompare(b.clinicianMembershipId));
}

/** §2.2.5 — the same question asked the other way, for the subscription editor: deactivating this row, does
 *  the clinician still have somebody? Returned as a verdict rather than a throw so the UI can warn before
 *  the DON commits, which is the only moment the gap is cheap to fix. */
export function wouldDeactivationCreateGap(input: {
  readonly subject: SafetyCoverageSubjectFacts;
  readonly activeSubscriptions: readonly SafetySubscriptionFacts[];
  readonly deactivatingSupervisorMembershipId: MembershipId;
  readonly activeSupervisorMembershipIds: ReadonlySet<MembershipId>;
}): SafetyCoverageGapDto | null {
  const remaining = input.activeSubscriptions.filter(
    (s) => s.supervisorMembershipId !== input.deactivatingSupervisorMembershipId,
  );
  return coverageGapFor({
    subject: input.subject,
    activeSubscriptions: remaining,
    activeSupervisorMembershipIds: input.activeSupervisorMembershipIds,
  });
}
