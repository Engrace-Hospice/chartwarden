// apps/backend/src/modules/20-field-safety/routes/read-service.ts — M20-T06, the §4.1 READ port + its
// projections. The Drizzle implementation is ./read-service-drizzle.ts.
//
// ── NO DTO IN THIS FILE CARRIES A COORDINATE, WITH EXACTLY ONE EXCEPTION ───────────────────────────────
//
// The exception is {@link SosLocationStreamPage}, which is the whole point of §4.1 row 10: its own
// permission (`safety.sos.read_coords`), its own predicate, its own `warn`-severity read-audit row and its
// own visibility on the clinician's self-service surface (§8.7). Every other read — the board, the alert
// detail, the check-in detail — answers "when did we last hear from her, and how", which needs a timestamp
// and a source, not a latitude. That asymmetry is D6's boundary expressed as TYPES: rendering the board can
// never trip the coordinate audit path because there is no field on the board's DTO to put a coordinate in.
//
// ── THE INCIDENT NARRATIVE IS A CIPHER AND STAYS ONE UNTIL A DECIPHER IS BOUND ─────────────────────────
//
// `safety_incident.narrative_cipher` / `witnesses_cipher` / `action_plan_cipher` and
// `safety_sos_alert.resolution_narrative_cipher` all ride the per-tenant DEK envelope. Phase 1 has no
// key-management binding for M20, so the decrypt port is INJECTED and the default REFUSES rather than
// returning the stored bytes. Returning ciphertext as though it were plaintext would put an unreadable blob
// on a clinician's screen and — worse — would make the per-access audit row claim a decrypt happened. The
// DTOs therefore carry `narrative: string | null` with `narrativeAvailable: boolean` beside it, so "there
// is no narrative" and "we cannot open it here" are different answers on the wire (the M19-T08 three-state
// rule).
import type {
  IsoInstant,
  SafetyAlertKind,
  SafetyCheckInKind,
  SafetyCheckInState,
  SafetyCheckInStatus,
  SafetyConsentPurpose,
  SafetyDashboardSnapshot,
  SafetyEmergencyContactConsentStatus,
  SafetyHighRiskAreaPolicy,
  SafetyHighRiskCategory,
  SafetyIncidentCategory,
  SafetyIncidentSeverity,
  SafetyIncidentState,
  SafetyPolicyEffectiveDto,
  SafetyPolygonRings,
  SafetySosCancelStatus,
  SafetySosLifecycleState,
  SafetySosOutcome,
  SafetySubscriptionScopeKind,
} from "@wardenx/types";
import type { M20ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

/** §4.2 `RecordCheckInResponse`'s read sibling — one `safety_check_in` row. */
export interface SafetyCheckInView {
  readonly id: string;
  readonly scheduleId: string | null;
  readonly visitId: string | null;
  readonly postedByMembershipId: string;
  readonly postedAt: IsoInstant;
  readonly kind: SafetyCheckInKind;
  readonly status: SafetyCheckInStatus;
  /** §3.6-denylisted free text; present only for a caller who passed the per-row ABAC gate. */
  readonly concernNote: string | null;
  /** D11 — whether a coordinate was captured, NEVER the coordinate (see the module header). */
  readonly coordinatesCaptured: boolean;
  readonly isPartOfSosBracket: boolean;
  readonly correctsCheckInId: string | null;
  readonly supersededAt: IsoInstant | null;
  readonly supersededByCheckInId: string | null;
  /** §4.1 row 3 — whether the 5-minute amendment grace is still open at the moment of the read. */
  readonly amendableUntil: IsoInstant | null;
}

/** §4.1 row 4 — the clinician's own day: her obligations and what she has posted against them. */
export interface SafetyMyDayView {
  readonly asOf: IsoInstant;
  readonly obligations: readonly {
    readonly scheduleId: string;
    readonly visitId: string | null;
    readonly kind: SafetyCheckInKind;
    readonly expectedAt: IsoInstant;
    readonly windowMinutes: number;
    readonly state: SafetyCheckInState;
    readonly fulfilledByCheckInId: string | null;
  }[];
  readonly recentCheckIns: readonly SafetyCheckInView[];
}

/** §4.2's SOS detail. */
export interface SafetySosAlertView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly postedByMembershipId: string;
  readonly postedAt: IsoInstant;
  readonly lastKnownVisitId: string | null;
  readonly lifecycleState: SafetySosLifecycleState;
  readonly cancelWindowExpiredAt: IsoInstant;
  readonly cancelStatus: SafetySosCancelStatus;
  readonly cancelAttemptedAt: IsoInstant | null;
  readonly acknowledgedAt: IsoInstant | null;
  readonly acknowledgedByMembershipId: string | null;
  readonly resolvedAt: IsoInstant | null;
  readonly resolvedByMembershipId: string | null;
  readonly outcome: SafetySosOutcome | null;
  /** See the module header on the cipher pair. */
  readonly resolutionNarrative: string | null;
  readonly resolutionNarrativeAvailable: boolean;
  readonly linkedIncidentId: string | null;
  /** M20-F16 — false when the clinician declined `sos_coordinates`. The alert fanned out either way. */
  readonly coordinatesCaptured: boolean;
  readonly version: number;
  /** §2.2.2 — the ordered ledger a deposition reads end to end. */
  readonly stateHistory: readonly {
    readonly fromState: SafetySosLifecycleState | null;
    readonly toState: SafetySosLifecycleState;
    readonly transitionedAt: IsoInstant;
    readonly transitionedByMembershipId: string | null;
  }[];
  /** §2.2.6 — every act of acknowledging this alert. */
  readonly acknowledgments: readonly {
    readonly id: string;
    readonly acknowledgedByMembershipId: string;
    readonly acknowledgedAt: IsoInstant;
    readonly actionTaken: string;
    readonly outcome: string | null;
  }[];
}

/** §4.1 row 10 — the D6 coordinate stream. The ONE DTO in this module that carries a latitude. */
export interface SosLocationStreamPage {
  readonly sosAlertId: string;
  readonly samples: readonly {
    readonly id: string;
    readonly sampledAt: IsoInstant;
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracyM: number;
  }[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  /**
   * §7.9's banner text, rendered verbatim by the §5 screen: "Coordinate access is logged; <name> will see
   * this access on her self-service surface." Carried on the RESPONSE rather than hard-coded in the client
   * so the promise the screen makes and the audit row the server writes are one decision.
   */
  readonly auditWarningBanner: string;
}

/** §4.1 row 11 — the active-SOS board tile. */
export interface ActiveSosView {
  readonly alerts: readonly {
    readonly id: string;
    readonly postedByMembershipId: string;
    readonly postedByFirstName: string;
    readonly postedAt: IsoInstant;
    readonly lifecycleState: SafetySosLifecycleState;
    readonly minutesOpen: number;
    readonly acknowledgedAt: IsoInstant | null;
  }[];
  readonly fetchedAt: IsoInstant;
}

/** §4.2's incident detail. */
export interface SafetyIncidentView {
  readonly id: string;
  readonly providerEntityId: string;
  readonly affectedClinicianMembershipId: string;
  readonly reportedByMembershipId: string;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly visitId: string | null;
  readonly patientId: string | null;
  readonly occurredAt: IsoInstant;
  readonly reportedAt: IsoInstant;
  readonly locationDescription: string | null;
  readonly narrative: string | null;
  readonly narrativeAvailable: boolean;
  readonly witnesses: string | null;
  readonly oshaReportable: boolean;
  readonly oshaReportableSignedOffByMembershipId: string | null;
  readonly oshaReportableSignedOffAt: IsoInstant | null;
  readonly workersCompClaimInitiated: boolean;
  readonly workersCompClaimReference: string | null;
  readonly linkedSosAlertId: string | null;
  readonly lifecycleState: SafetyIncidentState;
  readonly submittedAt: IsoInstant | null;
  readonly reviewedByMembershipId: string | null;
  readonly reviewedAt: IsoInstant | null;
  readonly actionPlan: string | null;
  readonly actionPlanAvailable: boolean;
  readonly closedAt: IsoInstant | null;
  readonly reopenReason: string | null;
  readonly version: number;
  readonly stateHistory: readonly {
    readonly fromState: SafetyIncidentState | null;
    readonly toState: SafetyIncidentState;
    readonly transitionedAt: IsoInstant;
    readonly transitionedByMembershipId: string | null;
    readonly reason: string | null;
  }[];
}

/** §4.1 row 20 — one subscription row. */
export interface SafetySubscriptionView {
  readonly id: string;
  readonly supervisorMembershipId: string;
  readonly clinicianMembershipId: string | null;
  readonly locationId: string | null;
  readonly providerEntityId: string | null;
  readonly scopeKind: SafetySubscriptionScopeKind;
  readonly alertKinds: readonly SafetyAlertKind[];
  readonly isVacationForwarding: boolean;
  readonly vacationForwardToMembershipId: string | null;
  readonly createdAt: IsoInstant;
}

/** §4.1 row 23 — one advisory polygon (D12). */
export interface SafetyHighRiskAreaView {
  readonly id: string;
  readonly riskCategory: SafetyHighRiskCategory;
  readonly advisoryMessage: string;
  readonly polygon: SafetyPolygonRings;
  readonly policyForVisitsToArea: SafetyHighRiskAreaPolicy;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
  readonly createdByMembershipId: string | null;
}

/** §4.1 row 27 — the clinician's own consent surface (§2.2.8 / M20-F06). */
export interface SafetyConsentView {
  readonly purpose: SafetyConsentPurpose;
  readonly status: SafetyEmergencyContactConsentStatus;
  readonly grantedAt: IsoInstant;
  readonly revokedAt: IsoInstant | null;
  readonly expiresAt: IsoInstant | null;
  /** NOT denylisted, deliberately (§3.3): it is the one thing a consent dispute turns on. */
  readonly acknowledgmentTextSnapshot: string;
  /**
   * `emergency_contact_call` only. The stored `consent_scope_detail` is application-layer CIPHERTEXT and
   * M20 never opens it on a read path — the terminus dial effect hands it straight to the telephony
   * adapter. A boolean is the honest projection: "we hold a contact for you" is the fact the self-service
   * surface exists to confirm, and re-displaying a spouse's phone number on every consent screen would
   * widen the disclosure the consent was given for.
   */
  readonly contactOnFile: boolean;
}

/** §7.9 / §8.7 — the clinician's own view of who read her coordinates. */
export interface SafetyConsentSurface {
  readonly consents: readonly SafetyConsentView[];
  readonly asOf: IsoInstant;
}

/** Filters the §4.1 list routes take (server-side; nothing here selects an org). */
export interface CheckInFilters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface IncidentFilters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly lifecycleState?: SafetyIncidentState;
  readonly oshaReportable?: boolean;
}

export interface SubscriptionFilters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly clinicianMembershipId?: string;
  readonly supervisorMembershipId?: string;
}

export interface HighRiskAreaFilters {
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeExpired?: boolean;
}

export interface LocationStreamFilters {
  readonly limit?: number;
  readonly cursor?: string;
  /** §6's post-SOS Compliance-Officer escalation narrative (≥40 chars). Required once the alert closes. */
  readonly accessReason?: string;
}

export interface DashboardFilters {
  readonly locationId?: string;
  readonly supervisorMembershipId?: string;
  readonly asOf?: string;
}

/** The §4.1 READ surface. */
export interface M20ReadService {
  // §4.1 rows 2, 4
  getCheckIn(actor: M20ReadActor, checkInId: string): Promise<SafetyCheckInView>;
  getMyDay(actor: M20ReadActor, filters: CheckInFilters): Promise<SafetyMyDayView>;

  // §4.1 rows 9, 10, 11
  getSosAlert(actor: M20ReadActor, sosAlertId: string): Promise<SafetySosAlertView>;
  getLocationStream(
    actor: M20ReadActor,
    sosAlertId: string,
    filters: LocationStreamFilters,
  ): Promise<SosLocationStreamPage>;
  listActiveSos(actor: M20ReadActor): Promise<ActiveSosView>;

  // §4.1 row 13
  getIncident(actor: M20ReadActor, incidentId: string): Promise<SafetyIncidentView>;
  listIncidents(
    actor: M20ReadActor,
    filters: IncidentFilters,
  ): Promise<CursorPage<SafetyIncidentView>>;

  // §4.1 row 18
  getPolicy(actor: M20ReadActor, asOfIso?: string): Promise<SafetyPolicyEffectiveDto>;

  // §4.1 row 20
  listSubscriptions(
    actor: M20ReadActor,
    filters: SubscriptionFilters,
  ): Promise<CursorPage<SafetySubscriptionView>>;

  // §4.1 row 23
  listHighRiskAreas(
    actor: M20ReadActor,
    filters: HighRiskAreaFilters,
  ): Promise<CursorPage<SafetyHighRiskAreaView>>;

  // §4.1 row 26
  getDashboard(actor: M20ReadActor, filters: DashboardFilters): Promise<SafetyDashboardSnapshot>;

  // §4.1 row 27
  getConsentSurface(
    actor: M20ReadActor,
    purpose?: SafetyConsentPurpose,
  ): Promise<SafetyConsentSurface>;
}
