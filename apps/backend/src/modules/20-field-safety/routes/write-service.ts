// apps/backend/src/modules/20-field-safety/routes/write-service.ts — M20-T06, the §4.1 WRITE port + its
// command inputs. The Drizzle implementation is ./write-service-drizzle.ts.
//
// SHAPE OF EVERY COMMAND, without exception: open `withOrgContext` (RLS pins app.org_id) → load the
// aggregate row → run the PURE §2.2 decision (`../lifecycle`) over already-resolved facts → execute the
// transition's DECLARED side effects (`./effects-runner`) and apply the row change under the §2.5
// optimistic-concurrency guard → emit the §4.10 outbox event on the SAME tx. No business rule lives in
// SQL, and no event can outlive a rolled-back write (§2.4).
//
// THE ACTING MEMBERSHIP IS NEVER AN INPUT. Every command takes an `M20WriteActor` the route extracted from
// `request.context`, and every attribution column is stamped from it. The ONE membership id a caller may
// supply is `affectedClinicianMembershipId` on the incident CREATE (§2.2.3's supervisor-opens-on-behalf-of
// path) and the two on a subscription row (which by definition name a SECOND and THIRD person); each is
// gated by its own §4.7 predicate.
//
// THE M4 WRITE-AUDIT TRIGGERS (migration 0111) record every mutation with the per-table §3.6 denylist, so
// this layer never hand-writes an audit row — the denylisted columns (`concern_note`,
// `resolution_narrative_cipher`, `acknowledger_dispatch_payload_cipher`, `narrative_cipher`,
// `witnesses_cipher`, `action_plan_cipher`, `location_description`, `reopen_reason`, `action_taken`,
// `advisory_message`, `consent_scope_detail`, `edit_reason`, the coordinate ciphers) are scrubbed at the
// trigger, which is why they may be written here in full.
//
// ── THE SOS PRESS IS THE ONE COMMAND WITH NO PRE-EXISTING ROW AND NO IDEMPOTENCY ─────────────────────
//
// §2.6 / M20-F10: every press writes its own row and fans out on its own. `raiseSos` therefore takes no
// `expectedVersion`, has no "find the existing alert" branch, and never returns an already-created row —
// the only dedupe it honours is D15's `localIdempotencyKey`, and ONLY when `offlineSync` is set, because
// that is a REPLAY of a press already made rather than a second press.
import type {
  IsoInstant,
  M20EventName,
  SafetyAlertKind,
  SafetyCheckInKind,
  SafetyCheckInStatus,
  SafetyConsentPurpose,
  SafetyCoverageGapDto,
  SafetyHighRiskAreaPolicy,
  SafetyHighRiskCategory,
  SafetyIncidentCategory,
  SafetyIncidentSeverity,
  SafetyIncidentState,
  SafetyPolicyEffectiveDto,
  SafetyPolygonRings,
  SafetySosLifecycleState,
  SafetySosOutcome,
  SafetySubscriptionModel,
  SafetySubscriptionScopeKind,
} from "@chartwarden/types";
import type { M20WriteActor } from "./actor";
import type {
  SafetyCheckInView,
  SafetyConsentView,
  SafetyHighRiskAreaView,
  SafetyIncidentView,
  SafetySosAlertView,
  SafetySubscriptionView,
} from "./read-service";

/**
 * The transactional-outbox emission the write service publishes on the mutation's own tx (§4.10).
 *
 * `organizationId` is on the envelope AND repeated inside every payload (`M20SafetyEventBase.orgId`), and
 * both are deliberate: `outbox_event.organization_id` is NOT NULL and is what the dispatcher's RLS scopes
 * delivery by, while the payload copy is what M36's alert router, M17's cancellation handler and M22's
 * renderer read when they have the payload alone.
 */
export interface OutboxEmission {
  readonly eventName: M20EventName;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The catalog-validating publisher the composition root binds (`callerModule` pinned to `m20`). */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

/**
 * The §4.9 typed M36 alert port. BEST-EFFORT and outside the transaction's failure path: M36 owns
 * delivery, retry and DLQ, and an SOS press must not roll back because an SMS gateway is down. §2.7's
 * degraded path — the tenant's own emergency number surfaced to the supervisor (M20-F01) — is the designed
 * answer to that outage, not a failed write.
 */
export interface AlertPort {
  emit(input: {
    organizationId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * The per-tenant DEK envelope (D14) every `*_cipher` column rides.
 *
 * The default REFUSES to encrypt rather than storing plaintext in a column named `_cipher`. A column that
 * says "cipher" and holds cleartext is worse than an absent value: the §3.7 eraser's redaction would
 * report the narrative destroyed while the plaintext sat in a backup. Each write path therefore states
 * what it does without a bound port, and none of them silently persists cleartext.
 */
export interface SafetyCipherPort {
  encrypt(input: { readonly organizationId: string; readonly plaintext: string }): Promise<Buffer>;
}

/** Every state-transition command echoes the `If-Match` version it read (§2.5). */
interface Versioned {
  /** The row `version` the caller read, from `If-Match`. A mismatch is 409 `STALE_LIFECYCLE_STATE`. */
  readonly expectedVersion?: number;
}

/** §4.2's coordinate sample. Encrypted before persist; never stored in the clear. */
export interface CoordinateInput {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM: number;
}

export interface RecordCheckInInput {
  readonly visitId?: string;
  readonly scheduleId?: string;
  readonly kind: SafetyCheckInKind;
  readonly status: SafetyCheckInStatus;
  readonly concernNote?: string;
  readonly postedCoordinates?: CoordinateInput;
  readonly postedViaDeviceId?: string;
}

/** §4.2's `RecordCheckInResponse` — the write's own answer, beyond the row. */
export interface RecordCheckInResult {
  readonly checkIn: SafetyCheckInView;
  /** §2.2.1 — did this post fulfil (and therefore close) a `safety_check_in_schedule` obligation? */
  readonly scheduleClosed: boolean;
  /**
   * §4.2's `warningsSurfaced`. Non-blocking facts the clinician should see: a coordinate that was
   * DROPPED because she has not consented (M20-F16), a schedule that was already overdue, an
   * unattested device. Each is a recorded fact and none is a refusal — that asymmetry is S13.
   */
  readonly warningsSurfaced: readonly { readonly code: string; readonly message: string }[];
}

export interface AmendCheckInInput {
  readonly status?: SafetyCheckInStatus;
  readonly concernNote?: string;
  readonly amendmentReason: string;
}

export interface RaiseSosInput {
  readonly postedViaDeviceId?: string;
  readonly postedCoordinates?: CoordinateInput;
  readonly lastKnownVisitId?: string;
  readonly capturedAt?: string;
  readonly localIdempotencyKey?: string;
  readonly offlineSync?: boolean;
}

/** §4.2's `RaiseSosResponse`. */
export interface RaiseSosResult {
  readonly id: string;
  readonly postedAt: IsoInstant;
  readonly cancelWindowExpiresAt: IsoInstant;
  readonly lifecycleState: SafetySosLifecycleState;
  /**
   * §4.2 names this `acknowledgersDispatched`. It is the size of the recipient set the §4.5 composed
   * resolver produced, NOT a delivery count — M36 owns delivery and the press must answer in the §9.7
   * 300 ms budget, which is well under a fan-out round trip. `null` means the resolver could not be
   * consulted at all, which the mobile client renders as the D15 `tel:` direct-dial fallback rather than
   * as "0 recipients" — the difference between "nobody is subscribed" and "we could not ask" is the whole
   * M20-F01 degraded path.
   */
  readonly acknowledgersDispatched: number | null;
  readonly warningsSurfaced: readonly { readonly code: string; readonly message: string }[];
}

export interface CancelSosInput {
  readonly biometricVerificationToken?: string;
}

/** §4.2's `CancelSosResponse`. A REJECTED cancel is a 200, not a 4xx — see the write service's header. */
export interface CancelSosResult {
  readonly id: string;
  readonly cancelStatus: "cancelled_in_window" | "cancel_attempted_but_rejected";
  readonly lifecycleState: SafetySosLifecycleState;
}

export interface AcknowledgeSosInput extends Versioned {
  readonly actionTaken: string;
  readonly outcome?: string;
  readonly outreachPhoneNumberMasked?: string;
}

export interface ResolveSosInput extends Versioned {
  readonly resolutionNarrative: string;
  readonly outcome: SafetySosOutcome;
  readonly openIncidentFromOutcome?: boolean;
}

export interface CreateIncidentInput {
  readonly affectedClinicianMembershipId: string;
  readonly category: SafetyIncidentCategory;
  readonly severity: SafetyIncidentSeverity;
  readonly visitId?: string;
  readonly patientId?: string;
  readonly occurredAt: string;
  readonly locationDescription?: string;
  readonly narrative: string;
  readonly witnesses?: string;
  readonly linkedSosAlertId?: string;
  readonly workersCompClaimInitiated?: boolean;
  readonly workersCompClaimReference?: string;
}

export interface PatchIncidentInput extends Versioned {
  readonly category?: SafetyIncidentCategory;
  readonly severity?: SafetyIncidentSeverity;
  readonly occurredAt?: string;
  readonly locationDescription?: string;
  readonly narrative?: string;
  readonly witnesses?: string;
  readonly workersCompClaimInitiated?: boolean;
  readonly workersCompClaimReference?: string;
}

export interface SubmitIncidentInput extends Versioned {
  readonly oshaReportable: boolean;
  readonly finalNarrative?: string;
}

export interface TransitionIncidentInput extends Versioned {
  readonly toState: Exclude<SafetyIncidentState, "draft" | "submitted">;
  readonly reason: string;
  readonly actionPlan?: string;
}

/** §7.6 / D9 — the OSHA-equivalent classification sign-off (step-up at the route). */
export interface OshaSignoffInput extends Versioned {
  readonly oshaReportable: boolean;
  readonly reason: string;
  /** State-specific; M20 holds no OSHA rule table (see ../alerts.ts on why these are not derived). */
  readonly stateCode: string;
  readonly reportingWindowHours: number;
}

/** §4.1 row 19 — the tenant policy edit. Every knob optional; `editReason` is not. */
export interface PatchPolicyInput extends Versioned {
  readonly midVisitCadenceMinutes?: number;
  readonly midVisitMinVisitDurationMinutes?: number;
  readonly preVisitWindowMinutes?: number;
  readonly postVisitWindowMinutes?: number;
  readonly gentleReminderMinutes?: number;
  readonly supervisorAlertMinutes?: number;
  readonly escalationMinutes?: number;
  readonly sosEquivalentMinutes?: number;
  readonly sosCancelWindowSeconds?: number;
  readonly sosCancelRequiresBiometric?: boolean;
  readonly sosContinuousLocationEnabled?: boolean;
  readonly sosContinuousLocationSampleSeconds?: number;
  readonly sosContinuousLocationMaxDurationHours?: number;
  readonly sosTier1SlaSeconds?: number;
  readonly sosTier2SlaSeconds?: number;
  readonly sosTier3SlaSeconds?: number;
  readonly subscriptionModel?: SafetySubscriptionModel;
  readonly afterHoursStartHour?: number;
  readonly afterHoursEndHour?: number;
  readonly oshaReportableAutoFlagCategories?: readonly SafetyIncidentCategory[];
  readonly editReason: string;
}

export interface CreateSubscriptionInput {
  readonly supervisorMembershipId: string;
  readonly scopeKind: SafetySubscriptionScopeKind;
  readonly clinicianMembershipId?: string;
  readonly locationId?: string;
  readonly providerEntityId?: string;
  readonly alertKinds: readonly SafetyAlertKind[];
  readonly isVacationForwarding?: boolean;
  readonly vacationForwardToMembershipId?: string;
}

/**
 * §4.1 row 22's answer.
 *
 * `coverageGapsCreated` is the point of the DTO. §2.2.5's `wouldDeactivationCreateGap` exists so the DON
 * learns at the moment of deactivation — the only moment it is cheap to fix — which clinicians this row
 * was the last cover for. The delete SUCCEEDS either way: refusing it would leave a departed supervisor's
 * row in place, which is the `all_subscriptions_deactivated` failure one step earlier. The gaps ride the
 * response AND the §7.8 watchdog's own critical alert, because a DON who ignored the response still gets
 * woken.
 */
export interface DeleteSubscriptionResult {
  readonly id: string;
  readonly deactivatedAt: IsoInstant;
  readonly coverageGapsCreated: readonly SafetyCoverageGapDto[];
}

export interface CreateHighRiskAreaInput {
  readonly riskCategory: SafetyHighRiskCategory;
  readonly advisoryMessage: string;
  readonly polygon: SafetyPolygonRings;
  readonly policyForVisitsToArea?: SafetyHighRiskAreaPolicy;
  readonly effectiveFrom?: string;
  readonly effectiveTo?: string;
}

export interface PatchHighRiskAreaInput {
  readonly riskCategory?: SafetyHighRiskCategory;
  readonly advisoryMessage?: string;
  readonly polygon?: SafetyPolygonRings;
  readonly policyForVisitsToArea?: SafetyHighRiskAreaPolicy;
  readonly effectiveTo?: string;
}

export interface GrantConsentInput {
  readonly purpose: SafetyConsentPurpose;
  readonly acknowledgmentTextSnapshot: string;
  readonly expiresAt?: string;
  readonly contact?: {
    readonly name: string;
    readonly phone: string;
    readonly relationship?: string;
  };
}

export interface RevokeConsentInput {
  readonly purpose: SafetyConsentPurpose;
  readonly reason?: string;
}

/** The §4.1 WRITE surface. */
export interface M20WriteService {
  // §4.1 rows 1, 3
  recordCheckIn(actor: M20WriteActor, input: RecordCheckInInput): Promise<RecordCheckInResult>;
  amendCheckIn(
    actor: M20WriteActor,
    checkInId: string,
    input: AmendCheckInInput,
  ): Promise<SafetyCheckInView>;

  // §4.1 rows 5-8
  raiseSos(actor: M20WriteActor, input: RaiseSosInput): Promise<RaiseSosResult>;
  cancelSos(
    actor: M20WriteActor,
    sosAlertId: string,
    input: CancelSosInput,
  ): Promise<CancelSosResult>;
  acknowledgeSos(
    actor: M20WriteActor,
    sosAlertId: string,
    input: AcknowledgeSosInput,
  ): Promise<SafetySosAlertView>;
  resolveSos(
    actor: M20WriteActor,
    sosAlertId: string,
    input: ResolveSosInput,
  ): Promise<SafetySosAlertView>;

  // §4.1 rows 12, 14-17
  createIncident(actor: M20WriteActor, input: CreateIncidentInput): Promise<SafetyIncidentView>;
  patchIncident(
    actor: M20WriteActor,
    incidentId: string,
    input: PatchIncidentInput,
  ): Promise<SafetyIncidentView>;
  submitIncident(
    actor: M20WriteActor,
    incidentId: string,
    input: SubmitIncidentInput,
  ): Promise<SafetyIncidentView>;
  transitionIncident(
    actor: M20WriteActor,
    incidentId: string,
    input: TransitionIncidentInput,
  ): Promise<SafetyIncidentView>;
  oshaSignoff(
    actor: M20WriteActor,
    incidentId: string,
    input: OshaSignoffInput,
  ): Promise<SafetyIncidentView>;

  // §4.1 row 19
  patchPolicy(actor: M20WriteActor, input: PatchPolicyInput): Promise<SafetyPolicyEffectiveDto>;

  // §4.1 rows 21, 22
  createSubscription(
    actor: M20WriteActor,
    input: CreateSubscriptionInput,
  ): Promise<SafetySubscriptionView>;
  deleteSubscription(
    actor: M20WriteActor,
    subscriptionId: string,
  ): Promise<DeleteSubscriptionResult>;

  // §4.1 rows 24, 25
  createHighRiskArea(
    actor: M20WriteActor,
    input: CreateHighRiskAreaInput,
  ): Promise<SafetyHighRiskAreaView>;
  patchHighRiskArea(
    actor: M20WriteActor,
    areaId: string,
    input: PatchHighRiskAreaInput,
  ): Promise<SafetyHighRiskAreaView>;

  // §4.1 rows 28, 29
  grantConsent(actor: M20WriteActor, input: GrantConsentInput): Promise<SafetyConsentView>;
  revokeConsent(actor: M20WriteActor, input: RevokeConsentInput): Promise<SafetyConsentView>;
}
