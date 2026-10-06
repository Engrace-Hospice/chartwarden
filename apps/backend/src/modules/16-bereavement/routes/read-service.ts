// apps/backend/src/modules/16-bereavement/routes/read-service.ts — the M16 READ service interface
// (the §4.1 GET surface) + its response DTOs.
//
// Every DTO here is the WIRE shape the M16-T07 screens and the generated client consume. Two rules the
// shapes encode rather than merely document:
//
//   • Every enum-valued field is typed against the frozen `@wardenx/types` union (which mirrors the
//     `@wardenx/db` pgEnum), NEVER a bare `string`. A wire enum published as a string is a silent lie the
//     next consumer inherits.
//   • The risk fields are OPTIONAL on every DTO, because the D10 volunteer scope and the §7.13 Part 2 gate
//     genuinely remove them. `currentRiskTier: null` would say "no tier has been computed"; ABSENT says
//     "not disclosed to you", and the `redactedCategories` envelope says which gate did it.
import type {
  BereavedContactId,
  BereavedContactRelationship,
  BereavedContactStatus,
  BereavementAnniversaryMark,
  BereavementConfidenceBand,
  BereavementDataCompleteness,
  BereavementExternalSourceMetadata,
  BereavementOutreachId,
  BereavementOutreachKind,
  BereavementOutreachStatus,
  BereavementPlanClosureReason,
  BereavementPlanId,
  BereavementPlanPauseKind,
  BereavementPlanStatus,
  BereavementRiskScoreId,
  BereavementRiskScoreKind,
  BereavementRiskTier,
  DocumentId,
  EncounterId,
  IsoInstant,
  LocalDate,
  LocationId,
  M16OutreachStats,
  MembershipId,
  PatientId,
  ProviderEntityId,
} from "@wardenx/types";
import type { M16ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";
import type { BereavementRedactedCategory } from "./disclosure";
import type {
  CounselorDashboardQuery,
  OutreachListQuery,
  PlanListQuery,
  RiskScoreListQuery,
  SupervisorDashboardQuery,
} from "./m16-typebox";

/** Route 1 — one row of the plan worklist. */
export interface BereavementPlanListItem {
  readonly planId: BereavementPlanId;
  readonly patientId: PatientId;
  readonly admissionId: string;
  readonly status: BereavementPlanStatus;
  readonly deathDate: LocalDate;
  /** D4 — `death_date + 396 days`, derived by the ONE pure window function (never a stored column). */
  readonly windowEndsAt: IsoInstant;
  readonly assignedCounselorUserId: MembershipId | null;
  readonly assignedVolunteerUserId: MembershipId | null;
  /** Absent when the D10 volunteer scope or §7.13 withheld it (see the module header). */
  readonly currentRiskTier?: BereavementRiskTier | null;
  readonly contactsActiveCount: number;
  readonly nextOutreachDueAt: IsoInstant | null;
  readonly overdueOutreachCount: number;
  /** D18 — true while an external-source plan still awaits its medical-director cosign. */
  readonly externalSourceCosignPending: boolean;
  readonly version: number;
  readonly updatedAt: IsoInstant;
}

/** One survivor as the plan detail / roster renders them. */
export interface BereavedContactRowView {
  readonly contactId: BereavedContactId;
  readonly planId: BereavementPlanId;
  readonly status: BereavedContactStatus;
  readonly displayName: string;
  readonly relationshipCode: BereavedContactRelationship;
  readonly preferredLanguageIso639: string;
  readonly portalAccountId: string | null;
  readonly consentRecordId: string | null;
  readonly allowedOutreachKinds: readonly BereavementOutreachKind[];
  readonly volunteerVisibleOnly: boolean;
  readonly confirmedAt: IsoInstant | null;
  readonly optedOutAt: IsoInstant | null;
  readonly unreachableAt: IsoInstant | null;
  /** §4.9 — the nightly detector proposes (never applies) `markUnreachable`; true while a proposal is stamped and the contact is not already unreachable. */
  readonly unreachableProposed: boolean;
  /** `contact_at` of the newest no-response row behind the proposal; null when not proposed. */
  readonly unreachableProposedAt: IsoInstant | null;
  readonly deceasedAt: IsoInstant | null;
  /** D9 — true while the 90-day self-service rescind window is still open on the active opt-out row. */
  readonly mayRescindOptOut: boolean;
  /** Absent under the D10 volunteer scope / §7.13 redaction. */
  readonly currentRiskTier?: BereavementRiskTier | null;
  readonly version: number;
}

/** Route 2 — the plan header with its rolled-up roster + risk. */
export interface BereavementPlanDetail {
  readonly planId: BereavementPlanId;
  readonly patientId: PatientId;
  readonly admissionId: string;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId | null;
  readonly status: BereavementPlanStatus;
  readonly deathDate: LocalDate;
  readonly deathTime: IsoInstant | null;
  readonly windowEndsAt: IsoInstant;
  readonly openedAt: IsoInstant | null;
  readonly pausedAt: IsoInstant | null;
  readonly pauseKind: BereavementPlanPauseKind | null;
  readonly closedAt: IsoInstant | null;
  readonly assignedCounselorUserId: MembershipId | null;
  readonly assignedCounselorAssignedAt: IsoInstant | null;
  readonly assignedVolunteerUserId: MembershipId | null;
  readonly assignedVolunteerAssignedAt: IsoInstant | null;
  readonly externalSource: BereavementExternalSourceMetadata | null;
  /** §4.3.2 / D18 — false while the counselor's first-contact button must stay locked. */
  readonly firstContactAllowed: boolean;
  /** The §4.3.2 machine-readable denial code when `firstContactAllowed` is false; null otherwise. */
  readonly firstContactGateReason: string | null;
  readonly contacts: readonly BereavedContactRowView[];
  readonly stats: M16OutreachStats;
  readonly currentRiskTier?: BereavementRiskTier | null;
  readonly currentRiskComputedAt?: IsoInstant | null;
  readonly legalHoldId: string | null;
  /** GAP-047 / D7 — a pending early-close request awaiting the supervisor cosign (narrative never exposed). */
  readonly earlyCloseRequest?: {
    readonly reason: BereavementPlanClosureReason;
    readonly requestedAt: IsoInstant;
    readonly requestedByUserId: MembershipId;
  } | null;
  readonly version: number;
  readonly updatedAt: IsoInstant;
  /** §7.13 — which confidentiality categories were withheld from this body, if any. */
  readonly redactedCategories: readonly BereavementRedactedCategory[];
}

/** Route 10 — the §3.3.7 closure record (§7.15 survey reconstruction). */
export interface BereavementClosureView {
  readonly closureId: string;
  readonly planId: BereavementPlanId;
  readonly reason: BereavementPlanClosureReason;
  readonly closeKind: string;
  readonly closedAt: IsoInstant;
  readonly closedByUserId: MembershipId | null;
  readonly cosignedByUserId: MembershipId | null;
  readonly cosignedAt: IsoInstant | null;
  readonly stats: M16OutreachStats;
  readonly bereavementSummaryDocumentId: DocumentId | null;
}

/** Route 19 — one scheduled or historical touchpoint. */
export interface BereavementOutreachRowView {
  readonly outreachId: BereavementOutreachId;
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly kind: BereavementOutreachKind;
  readonly status: BereavementOutreachStatus;
  readonly anniversaryMark: BereavementAnniversaryMark | null;
  readonly dueAt: IsoInstant;
  readonly lateGraceUntil: IsoInstant;
  readonly startedAt: IsoInstant | null;
  readonly completedAt: IsoInstant | null;
  readonly cancelledAt: IsoInstant | null;
  readonly assigneeUserId: MembershipId | null;
  readonly renderedDocumentId: DocumentId | null;
  readonly sourceEncounterId: EncounterId | null;
  readonly version: number;
}

/** Route 29 — one immutable row of the append-only score ledger. */
export interface BereavementRiskScoreView {
  readonly scoreId: BereavementRiskScoreId;
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId | null;
  readonly scoreKind: BereavementRiskScoreKind;
  readonly assessedAt: IsoInstant;
  readonly assessedByUserId: MembershipId | null;
  readonly tier: BereavementRiskTier;
  /** The rubric's own tier before any §7.3 counselor override moved `rule_tier` off it. */
  readonly deterministicTier: BereavementRiskTier;
  /** The 0..100 INTEGER column (`rule_score`) — the UI unscales it, the ledger stores it. */
  readonly ruleScore: number;
  readonly dataCompleteness: BereavementDataCompleteness;
  readonly confidenceBand: BereavementConfidenceBand;
  /** D17 — the tri-state factor vector. ABSENT entirely when §7.13 / D10 withheld clinical risk content. */
  readonly factors?: Record<string, boolean | "unknown">;
  readonly pg13Score: number | null;
  readonly ipgrScore: number | null;
  /** True when a seam was unreadable, so the `unknown`s are an outage rather than an unasked question. */
  readonly evidenceDegraded: boolean;
  /** §7.13 — categories the reader was not cleared for on this row. */
  readonly redactedCategories: readonly BereavementRedactedCategory[];
}

/** Route 30 — the counselor's own caseload plus what is coming due. */
export interface CounselorDashboardView {
  readonly counselorUserId: MembershipId;
  readonly caseloadCount: number;
  readonly dueWithinDays: number;
  readonly dueSoon: readonly BereavementOutreachRowView[];
  readonly overdue: readonly BereavementOutreachRowView[];
  readonly tierDistribution: { readonly [K in BereavementRiskTier]: number };
  readonly externalSourceCosignPendingCount: number;
}

/** Route 31 — the full-tenant rollups (COUNTS, never rates — CMS small-N suppression lives downstream). */
export interface SupervisorDashboardView {
  readonly planCountsByStatus: { readonly [K in BereavementPlanStatus]: number };
  readonly outreachCountsByStatus: {
    readonly [K in BereavementOutreachStatus]: number;
  };
  /** CoP 418.64(d): completed-on-time touchpoints ÷ touchpoints owed, as the raw PAIR. */
  readonly copCounts: { readonly numerator: number; readonly denominator: number };
  readonly tierDistribution: { readonly [K in BereavementRiskTier]: number };
  readonly closureCountsByReason: { readonly [K in BereavementPlanClosureReason]: number };
  readonly unassignedPlanCount: number;
  readonly externalSourceCosignPendingCount: number;
}

/**
 * The §4.1 GET surface. Implemented over Drizzle in prod (RLS-scoped per `withOrgContext`).
 *
 * Every plan-scoped read answers `null` when the plan is absent OR outside the caller's reach, and the
 * route turns that into a 404 — an off-caseload bereavement plan must be indistinguishable from one that
 * does not exist, because "this plan 403s" tells an unauthorized caller that a particular patient died.
 */
export interface M16ReadService {
  listPlans(
    actor: M16ReadActor,
    query: PlanListQuery,
  ): Promise<CursorPage<BereavementPlanListItem>>;
  getPlan(actor: M16ReadActor, planId: string): Promise<BereavementPlanDetail | null>;
  getClosure(actor: M16ReadActor, planId: string): Promise<BereavementClosureView | null>;
  listOutreach(
    actor: M16ReadActor,
    planId: string,
    query: OutreachListQuery,
  ): Promise<CursorPage<BereavementOutreachRowView> | null>;
  listRiskScores(
    actor: M16ReadActor,
    planId: string,
    query: RiskScoreListQuery,
  ): Promise<CursorPage<BereavementRiskScoreView> | null>;
  counselorDashboard(
    actor: M16ReadActor,
    query: CounselorDashboardQuery,
  ): Promise<CounselorDashboardView>;
  supervisorDashboard(
    actor: M16ReadActor,
    query: SupervisorDashboardQuery,
  ): Promise<SupervisorDashboardView>;
}

/**
 * §4.9 — derive the read-only "unreachable proposed" flags from a contact row. The nightly detector only
 * stamps `unreachable_proposed_through_at`; the counselor's `markUnreachable` is what changes status, so
 * a proposal stops being surfaced once the contact is already unreachable.
 */
export function unreachableProposalOf(row: {
  readonly status: string;
  readonly unreachableProposedThroughAt: Date | string | null;
  /** Route 34 — the counselor's "keep trying" stamp; dismissed while it is >= the proposal stamp. */
  readonly unreachableProposalDismissedAt?: Date | string | null;
}): { unreachableProposed: boolean; unreachableProposedAt: IsoInstant | null } {
  const stamp = row.unreachableProposedThroughAt;
  if (stamp === null || row.status === "unreachable") {
    return { unreachableProposed: false, unreachableProposedAt: null };
  }
  const dismissed = row.unreachableProposalDismissedAt ?? null;
  if (dismissed !== null && new Date(dismissed).getTime() >= new Date(stamp).getTime()) {
    return { unreachableProposed: false, unreachableProposedAt: null };
  }
  const at = (stamp instanceof Date ? stamp : new Date(stamp)).toISOString() as IsoInstant;
  return { unreachableProposed: true, unreachableProposedAt: at };
}
