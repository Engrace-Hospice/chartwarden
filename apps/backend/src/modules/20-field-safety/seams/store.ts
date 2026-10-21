// apps/backend/src/modules/20-field-safety/seams/store.ts — M20-T05, the data PORT the seven §4.3
// published seams (`SafetyDashboardProvider` · `SafetyContextReader` · `SafetyIncidentReader` ·
// `SafetyMetricsProvider` · `SafetyCheckInProvider` · `SafetyPolicyProvider` ·
// `SafetySupervisorProvider`) compose over, plus an in-memory slice for tests and a DB-less boot.
//
// The providers (./providers.ts) are pure orchestration over this port; production injects the
// Drizzle-backed store (./store-drizzle.ts), which reads M20's rows under the CONSUMER's ambient request
// context — the providers never switch tenants; RLS scopes every read by `app.org_id` (§3.5). This is the
// M9…M19 / M21 read-seam store precedent.
//
// ── FIVE SHAPES HERE DELIBERATELY DO NOT MATCH THEIR SEAM DTO ─────────────────────────────────────────
//
//  1. THE BOARD ROW CARRIES NO BADGE. `SafetyClinicianBoardFacts` returns `nextExpectedCheckInAt` and the
//     obligation's `windowMinutes`; `overdueState` is computed by the provider from the D4 rung oracles
//     (`overdueTierAt` / `overdueBadgeFor`, ../lifecycle/check-in-overdue) against the policy the
//     provider already resolved. Pushing the ladder into SQL would put the one value a supervisor acts on
//     somewhere no unit test can reach, and would re-implement a ladder that already exists as a pure
//     function T03 pinned.
//
//  2. METRICS ARE COUNTS, NEVER RATES. Every rate method's port sibling returns a numerator and a
//     denominator (`MeasureCounts`) or a raw sample array; the provider divides. This is the M15/M19/M30
//     lesson: a bare rate cannot express small-N suppression, and back-computing a denominator from a
//     rate is how a number that should have been withheld gets published. It is also why the §4.3 DTOs
//     grew `sampleSize` / `visitCount` fields the spec's own signatures omit (M20-T01).
//
//  3. THE P95 PORT RETURNS SAMPLES, NOT A PERCENTILE. `sosResponseSeconds` hands back the per-alert
//     press→acknowledgment latencies and `percentileOf` (pure, ./providers.ts) computes the median and
//     p95. §9.7's response-time target is asserted against an OBSERVED alert, and `percentile_cont` in
//     SQL would interpolate a latency no SOS actually had.
//
//  4. THE AFTER-HOURS COUNT IS SAMPLES + THE ALERT'S OWN WINDOW, NOT A COUNT. `afterHoursSosSamples`
//     returns each alert's `postedAt` together with the after-hours hours off the policy version THAT
//     ALERT PINNED — not today's. A 2031 read of 2026 must judge a 2026 press against the 2026 window,
//     which is the entire reason `safety_policy_version_id` is on the row (§2.2.4). The provider applies
//     `isAfterHours` (../lifecycle/policy) with the org's IANA zone, which is a REQUIRED dependency and
//     has no default — reading a bare hour integer off UTC puts a Pacific agency's night shift at 10 a.m.
//
//  5. THE INCIDENT GEO ROW CARRIES CIPHERTEXT, NOT COORDINATES. §8.6's projection needs a coarse
//     `latitude3`/`longitude3` and the only geography an incident has is on its linked SOS
//     (`posted_coordinates_cipher`, §3.3 gives `safety_incident` no coordinate column at all). The store
//     hands the cipher up and the provider decrypts-then-rounds INSIDE M20's boundary, through an
//     injected decipher — the per-tenant DEK never leaves this module and no full-precision coordinate
//     exists on the consumer side of the seam.
//
// ── THE COVERAGE DENOMINATOR IS A JUDGEMENT AND IT IS STATED HERE ─────────────────────────────────────
//
// `SafetyCoverageSubjectFacts.isFieldEligible` (../lifecycle/coverage-gap) has no column behind it: M2's
// `membership` carries no field-eligibility flag, and M20 may not read M3's role assignments across a
// module boundary. The Drizzle store's answer is the closest TRUE statement available — an `active`
// membership with a `default_provider_entity_id` — because `SafetyCoverageSubjectFacts` requires a PE and
// a membership with none has no coverage obligation to be gapped against in the first place. That
// over-reports: an office-only coordinator who happens to carry a PE is reported as an uncovered
// clinician. The over-report is the direction ../lifecycle/coverage-gap declares ("over-reporting costs
// the DON a false page; under-reporting costs a clinician her only escalation path"), and it is visible
// in the data rather than hidden behind a heuristic.
import type {
  IsoDate,
  IsoInstant,
  MeasureCounts,
  MembershipId,
  ProviderEntityId,
  SafetyCheckInKind,
  SafetyCheckInStatus,
  SafetyConsentPurpose,
  SafetyIncidentCategory,
  SafetyIncidentSeverity,
  SafetyMetricsWindow,
  SafetySosAlertId,
  SafetySosLifecycleState,
} from "@chartwarden/types";
import type {
  SafetyCoverageSubjectFacts,
  SafetySubscriptionFacts,
} from "../lifecycle/coverage-gap";
import type { SafetyPolicyVersionFacts } from "../lifecycle/policy";

/** One clinician's M20-OWNED board facts. The cross-module half (current visit, patient first name, last
 *  known location, spoof badge) is resolved by ../consumers/seam-context and merged by the provider. */
export interface SafetyClinicianBoardFacts {
  readonly membershipId: MembershipId;
  /** `user.name`, or the empty string when the account has never set one. NOT a patient name. */
  readonly displayName: string;
  readonly lastCheckInAt: IsoInstant | null;
  readonly lastCheckInStatus: SafetyCheckInStatus | null;
  /** The next unfulfilled obligation's `expected_at`, or null when she owes nothing. */
  readonly nextExpectedCheckInAt: IsoInstant | null;
  /** That obligation's `window_minutes` — the D4 badge needs it to tell `reminder` from `on_time`. */
  readonly nextExpectedWindowMinutes: number | null;
  readonly activeSosAlert: {
    readonly id: SafetySosAlertId;
    readonly raisedAt: IsoInstant;
    readonly lifecycleState: SafetySosLifecycleState;
  } | null;
}

/** One `safety_check_in_schedule` row as the §4.3 per-visit badge trio reads it. */
export interface SafetyVisitScheduleFacts {
  readonly kind: SafetyCheckInKind;
  readonly expectedAt: IsoInstant;
  readonly windowMinutes: number;
  /** `proposed` | `recorded` | `overdue` | `escalated` | `superseded` — the provider maps it to the
   *  four-value {@link SafetyCheckInBadge}, which is a NARROWER vocabulary on purpose (§4.3). */
  readonly state: string;
}

/** The M20-owned half of an incident summary. The DTO is assembled by the provider. */
export interface SafetyIncidentSummaryFacts {
  readonly incidentId: string;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly lifecycleState: string;
  readonly occurredAt: IsoInstant;
  readonly affectedClinicianMembershipId: MembershipId;
  readonly visitId: string | null;
  readonly linkedSosAlertId: SafetySosAlertId | null;
  readonly oshaReportable: boolean;
}

/** §8.6 — one incident plus the CIPHERTEXT of its linked SOS's coordinates. See shape (5) in the header. */
export interface SafetyIncidentGeoFacts {
  readonly incidentId: string;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly occurredAt: IsoInstant;
  /** NULL for a freestanding incident — the dog bite reported the next morning has no geography at all,
   *  which is a real limit of the D12 suggestion model and not something the seam papers over. */
  readonly linkedSosCoordinatesCipher: Uint8Array | null;
}

/** One SOS press with the after-hours window off the policy version IT pinned. See shape (4). */
export interface SafetySosAfterHoursSample {
  readonly postedAt: IsoInstant;
  readonly afterHoursStartHour: number;
  readonly afterHoursEndHour: number;
}

/** The M20-owned emergency-contact row (M20-F06), as the terminus dial path reads it. */
export interface SafetyEmergencyContactFacts {
  readonly consentId: string;
  readonly clinicianMembershipId: MembershipId;
  readonly consentPurpose: SafetyConsentPurpose;
  readonly grantedAt: IsoInstant;
  readonly expiresAt: IsoInstant | null;
  /** `consent_scope_detail` VERBATIM — application-layer ciphertext (§3.3). M20 hands it to the dial
   *  effect and never opens it here; the value is a spouse's phone number. */
  readonly consentScopeDetail: unknown;
}

/**
 * The §4.3 data port. Every method is scoped to the CALLER's org by RLS, never by an argument — the seam
 * signatures take an `orgId` because §4.3 says so, and the providers assert it against the ambient scope
 * rather than using it to select rows (`assertCallerOrg`, ./providers.ts).
 */
export interface SafetySeamStore {
  // ── SafetyPolicyProvider (§2.2.4) ──────────────────────────────────────────────────────────────────
  /** The version row in force at `asOfIso`. `null` ⇒ the tenant has no policy row yet, which the
   *  provider answers with the platform floor rather than an error (see ./providers.ts). */
  policyVersionAt(asOfIso: IsoInstant): Promise<SafetyPolicyVersionFacts | null>;

  // ── SafetyDashboardProvider (§4.2) ─────────────────────────────────────────────────────────────────
  /** Every field-eligible clinician in the org at `asOfIso`, with the scope selectors the location- and
   *  supervisor-scoped board filters need. Also the coverage watchdog's subject roster (§7.8). */
  coverageSubjects(asOfIso: IsoInstant): Promise<readonly SafetyCoverageSubjectFacts[]>;
  /** The M20-owned board facts for a specific set of clinicians, at `asOfIso`. */
  boardFactsForMemberships(
    membershipIds: readonly MembershipId[],
    asOfIso: IsoInstant,
  ): Promise<readonly SafetyClinicianBoardFacts[]>;

  // ── SafetyContextReader (§4.3) ─────────────────────────────────────────────────────────────────────
  /** The OPEN incident bracketing one visit, newest first; `null` when none is open. */
  openIncidentForVisit(visitId: string): Promise<SafetyIncidentSummaryFacts | null>;
  /** Every incident affecting one clinician that OCCURRED on `asOfDate` (org-local date boundaries are
   *  the caller's — the store compares against the date as supplied, see ./store-drizzle.ts). */
  incidentsForClinicianOnDate(
    clinicianMembershipId: MembershipId,
    asOfDate: IsoDate,
  ): Promise<readonly SafetyIncidentSummaryFacts[]>;

  // ── SafetyIncidentReader (§8.6) ────────────────────────────────────────────────────────────────────
  incidentGeoFactsSince(sinceIso: IsoInstant): Promise<readonly SafetyIncidentGeoFacts[]>;
  incidentGeoFactsForClinicianSince(
    clinicianMembershipId: MembershipId,
    sinceIso: IsoInstant,
  ): Promise<readonly SafetyIncidentGeoFacts[]>;

  // ── SafetyMetricsProvider (§4.3) ───────────────────────────────────────────────────────────────────
  sosCount(providerEntityId: ProviderEntityId, window: SafetyMetricsWindow): Promise<number>;
  incidentCount(providerEntityId: ProviderEntityId, window: SafetyMetricsWindow): Promise<number>;
  /**
   * The DENOMINATOR behind both `perHundredVisits` figures: distinct `visit_id`s M20 materialized a
   * check-in obligation for, in the window, for that PE.
   *
   * IT IS NOT M17's VISIT COUNT AND THE DIFFERENCE IS REAL. M17 publishes no per-ProviderEntity visit
   * count (`VisitMetricsProvider` has none), so this is what M20 can honestly count: the visits it
   * OBSERVED. A visit whose cadence never materialized — M17 published it while M20's consumer was down
   * — is absent from the denominator, which biases the rate UPWARD (fewer visits, same numerator). That
   * is why every rate method ships `visitCount` alongside: the consumer sees the denominator it is
   * dividing by and M30's small-N suppression has something to act on.
   */
  observedVisitCount(
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<number>;
  /** Obligations that reached `overdue`/`escalated` ÷ obligations due, in the window, for that PE. */
  overdueCounts(
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<MeasureCounts>;
  /** Obligations fulfilled by a check-in ÷ obligations due, in the window, for that PE. */
  checkInComplianceCounts(
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<MeasureCounts>;
  /** Press → acknowledgment latency in seconds, one entry per ACKNOWLEDGED alert in the window. An alert
   *  nobody ever acknowledged is absent: it has no response time, and counting it as 0 would improve the
   *  median for the worst possible reason. */
  sosResponseSeconds(
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<readonly number[]>;
  afterHoursSosSamples(
    providerEntityId: ProviderEntityId,
    window: SafetyMetricsWindow,
  ): Promise<readonly SafetySosAfterHoursSample[]>;

  // ── SafetyCheckInProvider (§4.3) ───────────────────────────────────────────────────────────────────
  scheduleFactsForVisit(visitId: string): Promise<readonly SafetyVisitScheduleFacts[]>;

  // ── SafetySupervisorProvider (§4.3 / §7.8) ─────────────────────────────────────────────────────────
  /** Every ACTIVE subscription row in the org (`superseded_at IS NULL AND deactivated_at IS NULL`). The
   *  scope match is `subscriptionCovers` (../lifecycle/coverage-gap), a pure function, rather than four
   *  SQL branches that would have to re-state D8's layering. */
  activeSubscriptions(): Promise<readonly SafetySubscriptionFacts[]>;
  /** Clinicians with at least one INACTIVE subscription row — what tells `no_subscription` apart from
   *  `all_subscriptions_deactivated` (§7.8), since a deactivated row never comes back above. */
  membershipsWithInactiveSubscriptions(): Promise<ReadonlySet<MembershipId>>;
  /** Which of `membershipIds` are ACTIVE memberships — the vacation-forward target check (§7.8's
   *  `vacation_forwards_unresolved`, the worst of the three because the configuration LOOKS complete). */
  activeMembershipIds(membershipIds: readonly MembershipId[]): Promise<ReadonlySet<MembershipId>>;

  // ── §4.5 composition + M20-F06 ─────────────────────────────────────────────────────────────────────
  /** The user id behind a membership — M36 delivers to USERS, M20's subscription rows name memberships.
   *  A membership whose user will not resolve is absent from the map (see ./providers.ts). */
  userIdsForMemberships(
    membershipIds: readonly MembershipId[],
  ): Promise<ReadonlyMap<MembershipId, string>>;
  /** M20-F06 — the clinician's `granted`, unexpired `emergency_contact_call` row at `asOfIso`, or null. */
  emergencyContactConsent(
    clinicianMembershipId: MembershipId,
    asOfIso: IsoInstant,
  ): Promise<SafetyEmergencyContactFacts | null>;
}

// ── in-memory slice (tests + a DB-less boot) ───────────────────────────────────────────────────────────

/** The rows an in-memory {@link SafetySeamStore} is seeded from. Every collection defaults to empty. */
export interface SafetySeamSeed {
  readonly policyVersions?: readonly SafetyPolicyVersionFacts[];
  readonly coverageSubjects?: readonly SafetyCoverageSubjectFacts[];
  readonly boardFacts?: readonly SafetyClinicianBoardFacts[];
  readonly incidents?: readonly SafetyIncidentSummaryFacts[];
  readonly incidentGeo?: readonly (SafetyIncidentGeoFacts & {
    readonly affectedClinicianMembershipId: MembershipId;
  })[];
  readonly visitSchedules?: ReadonlyMap<string, readonly SafetyVisitScheduleFacts[]>;
  readonly subscriptions?: readonly SafetySubscriptionFacts[];
  readonly membershipsWithInactiveSubscriptions?: readonly MembershipId[];
  readonly activeMemberships?: readonly MembershipId[];
  readonly userIdsByMembership?: ReadonlyMap<MembershipId, string>;
  readonly emergencyContacts?: readonly SafetyEmergencyContactFacts[];
  readonly metrics?: {
    readonly sosCount?: number;
    readonly incidentCount?: number;
    readonly observedVisitCount?: number;
    readonly overdueCounts?: MeasureCounts;
    readonly checkInComplianceCounts?: MeasureCounts;
    readonly sosResponseSeconds?: readonly number[];
    readonly afterHoursSosSamples?: readonly SafetySosAfterHoursSample[];
  };
}

/** An in-memory {@link SafetySeamStore}. */
export type InMemorySafetySeamStore = SafetySeamStore;

const ZERO_COUNTS: MeasureCounts = { numerator: 0, denominator: 0 };

/**
 * Build an in-memory {@link SafetySeamStore} over a seed.
 *
 * Used by §9.1 and by any caller that wants the providers without a database. It is NOT what a DB-less
 * boot stands over the deny-stubs: `registerFieldSafetySeams` registers nothing without a store, for the
 * reason stated in ./index.ts — an empty board and an empty recipient set are REAL answers here, and
 * manufacturing them out of a missing database is the one failure mode a safety module must not have.
 */
export function createInMemorySafetySeamStore(seed: SafetySeamSeed = {}): InMemorySafetySeamStore {
  const policyVersions = [...(seed.policyVersions ?? [])].sort(
    (a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom),
  );
  const incidents = seed.incidents ?? [];
  const incidentGeo = seed.incidentGeo ?? [];
  const metrics = seed.metrics ?? {};
  const activeMemberships = new Set(seed.activeMemberships ?? []);
  const inactiveSubs = new Set(seed.membershipsWithInactiveSubscriptions ?? []);
  const userIds = seed.userIdsByMembership ?? new Map<MembershipId, string>();
  const emergencyContacts = seed.emergencyContacts ?? [];

  return {
    async policyVersionAt(asOfIso) {
      const at = Date.parse(asOfIso);
      const covering = policyVersions.filter(
        (v) =>
          Date.parse(v.effectiveFrom) <= at &&
          (v.effectiveTo === null || Date.parse(v.effectiveTo) > at),
      );
      return covering.length === 0
        ? null
        : (covering[covering.length - 1] as SafetyPolicyVersionFacts);
    },

    async coverageSubjects() {
      return seed.coverageSubjects ?? [];
    },

    async boardFactsForMemberships(membershipIds) {
      const wanted = new Set(membershipIds);
      return (seed.boardFacts ?? []).filter((f) => wanted.has(f.membershipId));
    },

    async openIncidentForVisit(visitId) {
      const open = incidents.filter(
        (i) =>
          i.visitId === visitId &&
          !["closed_with_action_plan", "closed_no_action"].includes(i.lifecycleState),
      );
      return open.length === 0 ? null : (open[0] as SafetyIncidentSummaryFacts);
    },

    async incidentsForClinicianOnDate(clinicianMembershipId, asOfDate) {
      return incidents.filter(
        (i) =>
          i.affectedClinicianMembershipId === clinicianMembershipId &&
          i.occurredAt.slice(0, 10) === asOfDate,
      );
    },

    async incidentGeoFactsSince(sinceIso) {
      const since = Date.parse(sinceIso);
      return incidentGeo.filter((i) => Date.parse(i.occurredAt) >= since);
    },

    async incidentGeoFactsForClinicianSince(clinicianMembershipId, sinceIso) {
      const since = Date.parse(sinceIso);
      return incidentGeo.filter(
        (i) =>
          i.affectedClinicianMembershipId === clinicianMembershipId &&
          Date.parse(i.occurredAt) >= since,
      );
    },

    async sosCount() {
      return metrics.sosCount ?? 0;
    },
    async incidentCount() {
      return metrics.incidentCount ?? 0;
    },
    async observedVisitCount() {
      return metrics.observedVisitCount ?? 0;
    },
    async overdueCounts() {
      return metrics.overdueCounts ?? ZERO_COUNTS;
    },
    async checkInComplianceCounts() {
      return metrics.checkInComplianceCounts ?? ZERO_COUNTS;
    },
    async sosResponseSeconds() {
      return metrics.sosResponseSeconds ?? [];
    },
    async afterHoursSosSamples() {
      return metrics.afterHoursSosSamples ?? [];
    },

    async scheduleFactsForVisit(visitId) {
      return seed.visitSchedules?.get(visitId) ?? [];
    },

    async activeSubscriptions() {
      return seed.subscriptions ?? [];
    },
    async membershipsWithInactiveSubscriptions() {
      return inactiveSubs;
    },
    async activeMembershipIds(membershipIds) {
      return new Set(membershipIds.filter((id) => activeMemberships.has(id)));
    },

    async userIdsForMemberships(membershipIds) {
      const out = new Map<MembershipId, string>();
      for (const id of membershipIds) {
        const userId = userIds.get(id);
        if (userId !== undefined) out.set(id, userId);
      }
      return out;
    },

    async emergencyContactConsent(clinicianMembershipId, asOfIso) {
      const at = Date.parse(asOfIso);
      const match = emergencyContacts.find(
        (c) =>
          c.clinicianMembershipId === clinicianMembershipId &&
          c.consentPurpose === "emergency_contact_call" &&
          Date.parse(c.grantedAt) <= at &&
          (c.expiresAt === null || Date.parse(c.expiresAt) > at),
      );
      return match ?? null;
    },
  };
}
