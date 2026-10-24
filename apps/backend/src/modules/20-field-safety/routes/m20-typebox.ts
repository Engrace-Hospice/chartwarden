// apps/backend/src/modules/20-field-safety/routes/m20-typebox.ts — M20-T06 (§4.2) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 Field Safety routes. Named
// `m20-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one — the M21-T01 gotcha, where even the WORD "alerts" in a comment tripped `arch:tables`.
//
// The string-literal unions MIRROR the frozen `@chartwarden/types` unions (`packages/types/src/safety.ts`,
// M20-T01), which themselves mirror the `@chartwarden/db` pgEnums and the §3.3 CHECK vocabularies. The DB wins
// on conflict, and where §4.2's own sketch disagrees with either, the sketch loses. FIVE places where it
// does, recorded rather than silently reconciled:
//
//   1. §4.2's `CreateIncidentRequest` types `category` and `severity` as bare `Type.String()`. Both are
//      §3.2 pgEnums with closed member sets. A bare string is a 500 from the driver on a typo, at the
//      moment a clinician is filing a dog-bite report; the closed unions below make it a 422 naming the
//      field. This is the M30 "a wire enum published as `Type.String()` is a silent lie" lesson.
//   2. §4.2's `RecordCheckInResponse.state` is likewise `Type.String()`. Same treatment.
//   3. §4.2's `RaiseSosRequest` makes `postedCoordinates` REQUIRED. M20-F16 makes the opposite true: a
//      clinician who declined `sos_coordinates` consent still presses the button and the alert still fans
//      out, with the recipients told there is no location. A required field here would either refuse her
//      press (the one refusal S13 forbids) or force the client to fabricate a coordinate. It is OPTIONAL.
//   4. §4.2's `ResolveSosRequest.openIncidentFromOutcome` is a boolean beside `outcome`. §2.2.2 makes
//      `resolved` and `incident_opened` DIFFERENT terminal states reached by DIFFERENT commands, so the
//      flag is kept (§4.2 is explicit) and the route dispatches on it rather than the write service
//      inventing a second meaning for `outcome: 'incident_opened'`.
//   5. §4.2 has no schema for the D6 location-stream read, the consent surface, the subscriptions or the
//      high-risk-area editor — §4.1 has the rows and §4.2 shows only four representative blocks. Those are
//      authored here against §3.3's columns, which is the authority §4.2 defers to anyway.
//
// NOTHING HERE ACCEPTS AN ORG OR AN ACTING MEMBERSHIP. Both are server-side (`routes/actor.ts`), which is
// what makes §8.3's spoofing controls structural. `oshaReportable` is absent from `CreateIncidentBody` for
// the same class of reason: D9 makes the sign-off a SEPARATE, step-up'd act by a supervisor, so a create
// body that could assert it would file with a state agency on the clinician's own say-so.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@chartwarden/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/**
 * Validate a request BODY at the route boundary. Deliberately does NOT run `Value.Convert`: a JSON body
 * already carries real types, and coercing would silently repair genuinely wrong input — here that would
 * mean accepting `"37.7"` for a latitude that every downstream consumer treats as a number.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting the declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const UuidOpt = Type.Optional(Type.String({ format: "uuid" }));
const Instant = Type.String({ format: "date-time" });
const InstantOpt = Type.Optional(Type.String({ format: "date-time" }));
/** §3.6-denylisted free text. The cap is the column's practical maximum, not a validation opinion. */
const FreeText = (min: number, max: number) => Type.String({ minLength: min, maxLength: max });

// ── §3.2 / §3.3 vocabulary mirrors (`packages/types/src/safety.ts` is the source of truth) ────────────

/** `safety_check_in_kind`. */
export const CheckInKind = Type.Union([
  Type.Literal("pre_visit"),
  Type.Literal("mid_visit"),
  Type.Literal("post_visit"),
  Type.Literal("between_visits"),
  Type.Literal("ad_hoc"),
]);

/** `safety_check_in_status`. */
export const CheckInStatus = Type.Union([
  Type.Literal("ok"),
  Type.Literal("concerned_continue"),
  Type.Literal("concerned_stop"),
]);

/** `safety_check_in_state` (decision 2 — a closed union, not `Type.String()`). */
export const CheckInState = Type.Union([
  Type.Literal("proposed"),
  Type.Literal("recorded"),
  Type.Literal("overdue"),
  Type.Literal("escalated"),
  Type.Literal("superseded"),
  Type.Literal("incident_opened"),
]);

/** §3.3 `safety_sos_alert.outcome`. */
export const SosOutcome = Type.Union([
  Type.Literal("no_action_needed"),
  Type.Literal("clinician_safe_continued"),
  Type.Literal("visit_cancelled"),
  Type.Literal("incident_opened"),
  Type.Literal("911_called"),
  Type.Literal("other"),
]);

/** §3.3 `safety_acknowledgment.outcome` — the FIRST act, distinct from the SOS outcome (the last). */
export const AcknowledgmentOutcome = Type.Union([
  Type.Literal("reached_clinician_by_phone"),
  Type.Literal("dispatched_supervisor"),
  Type.Literal("911_called"),
  Type.Literal("no_action_needed"),
  Type.Literal("other"),
]);

/** `safety_incident_category` (decision 1). */
export const IncidentCategory = Type.Union([
  Type.Literal("physical_assault"),
  Type.Literal("verbal_assault"),
  Type.Literal("threatened"),
  Type.Literal("dog_bite"),
  Type.Literal("animal_other"),
  Type.Literal("vehicle_accident_on_duty"),
  Type.Literal("theft_during_visit"),
  Type.Literal("medical_emergency_clinician_self"),
  Type.Literal("weather_emergency"),
  Type.Literal("environmental_hazard"),
  Type.Literal("near_miss"),
  Type.Literal("other"),
]);

/** `safety_incident_severity` (decision 1). */
export const IncidentSeverity = Type.Union([
  Type.Literal("minor"),
  Type.Literal("moderate"),
  Type.Literal("serious"),
  Type.Literal("life_threatening"),
]);

/**
 * `safety_incident_state` MINUS the states a route may not name.
 *
 * `draft` and `submitted` are absent because they are reached by their OWN routes (create / submit), and a
 * transition body that could name them would let a supervisor un-submit an incident — the immutability
 * entry point §2.2.3 puts at `submitted`. The five below are exactly §4.2's `TransitionIncidentRequest`
 * union, verbatim.
 */
export const IncidentTransitionState = Type.Union([
  Type.Literal("under_review"),
  Type.Literal("returned_to_clinician"),
  Type.Literal("closed_with_action_plan"),
  Type.Literal("closed_no_action"),
  Type.Literal("reopened"),
]);

/** `safety_high_risk_category`. */
export const HighRiskCategory = Type.Union([
  Type.Literal("documented_prior_incident"),
  Type.Literal("community_self_reported_unsafe"),
  Type.Literal("nighttime_only_advisory"),
  Type.Literal("weather_advisory_seasonal"),
  Type.Literal("general_caution"),
]);

/** §3.3 `safety_high_risk_area.policy_for_visits_to_area`. */
export const HighRiskAreaPolicy = Type.Union([
  Type.Literal("advisory_only"),
  Type.Literal("requires_pre_visit_check_in"),
  Type.Literal("requires_buddy_visit"),
]);

/** §3.3 `safety_supervisor_subscription.scope_kind`. */
export const SubscriptionScopeKind = Type.Union([
  Type.Literal("explicit"),
  Type.Literal("location"),
  Type.Literal("provider_entity"),
  Type.Literal("role"),
]);

/** §3.3 `safety_supervisor_subscription.alert_kinds[]`. */
export const AlertKind = Type.Union([
  Type.Literal("sos"),
  Type.Literal("overdue"),
  Type.Literal("incident"),
  Type.Literal("high_risk_area"),
]);

/** §3.3 `safety_emergency_contact_consent.consent_purpose`. */
export const ConsentPurpose = Type.Union([
  Type.Literal("sos_coordinates"),
  Type.Literal("continuous_location_during_sos"),
  Type.Literal("emergency_contact_call"),
]);

/** §4.2 — a WGS-84 coordinate sample with its accuracy. Never persisted in the clear (§3.3's ciphers). */
export const Coordinates = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  accuracyM: Type.Integer({ minimum: 0, maximum: 10000 }),
});

// ── path params ──────────────────────────────────────────────────────────────────────────────────────

export const CheckInIdParams = Type.Object({ checkInId: Uuid });
export const SosIdParams = Type.Object({ sosAlertId: Uuid });
export const IncidentIdParams = Type.Object({ incidentId: Uuid });
export const SubscriptionIdParams = Type.Object({ subscriptionId: Uuid });
export const AreaIdParams = Type.Object({ areaId: Uuid });

// ── §4.1 rows 1-4: check-ins ─────────────────────────────────────────────────────────────────────────

/**
 * §4.2 `RecordCheckInRequest`.
 *
 * `concernNote` is `minLength: 20` because §3.3's `m20_sci_concern_note` CHECK enforces exactly that
 * floor for any non-`ok` status — validating it here turns a driver-level constraint violation into a 422
 * naming the field. The CONDITIONAL half (required only when the status is not `ok`) is the write
 * service's: a TypeBox `If` over a sibling field would encode a rule the DB already owns, in a second
 * place, in a different dialect.
 */
export const RecordCheckInBody = Type.Object({
  visitId: UuidOpt,
  scheduleId: UuidOpt,
  kind: CheckInKind,
  status: CheckInStatus,
  concernNote: Type.Optional(FreeText(20, 2000)),
  /** D11 — coordinates are OFF by default and require the clinician's `sos_coordinates` consent. */
  postedCoordinates: Type.Optional(Coordinates),
  /** M2 logical FK. ADVISORY (§2.2.2): an unattested device still records. */
  postedViaDeviceId: UuidOpt,
});

/** §4.1 row 3 — the 5-minute amendment grace. The grace WINDOW is the write service's (it needs the row's
 *  `posted_at`); the shape is here. A correction supersedes rather than mutating (§2.2.1). */
export const AmendCheckInBody = Type.Object({
  status: Type.Optional(CheckInStatus),
  concernNote: Type.Optional(FreeText(20, 2000)),
  amendmentReason: FreeText(10, 500),
});

export const CheckInListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  from: InstantOpt,
  to: InstantOpt,
});

// ── §4.1 rows 5-11: SOS ──────────────────────────────────────────────────────────────────────────────

/**
 * §4.2 `RaiseSosRequest` (decision 3 — `postedCoordinates` is OPTIONAL).
 *
 * `capturedAt` is the DEVICE's instant and is carried for the D15 offline replay; the server stamps
 * `posted_at` from its own clock for an online press and from this value for a replayed one. A client that
 * could set `posted_at` directly on the online path could back-date a press past a coverage gap.
 */
export const RaiseSosBody = Type.Object({
  postedViaDeviceId: UuidOpt,
  postedCoordinates: Type.Optional(Coordinates),
  lastKnownVisitId: UuidOpt,
  capturedAt: InstantOpt,
  /** D15 — the device's own key; the ONE dedupe M20-F10 permits, and only for an offline replay. */
  localIdempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  /** D15 — true when this press was captured offline and is being replayed on reconnect. */
  offlineSync: Type.Optional(Type.Boolean()),
});

/**
 * §4.2 `CancelSosRequest`.
 *
 * `biometricVerificationToken` is the DEVICE's verdict passed through M2's step-up surface. It is optional
 * because a tenant may have `sosCancelRequiresBiometric = false`, in which case the machine records
 * `not_required` — which §3.3's vocabulary keeps distinct from `passed` precisely so a forensic read can
 * tell "the platform did not ask" from "her face matched".
 */
export const CancelSosBody = Type.Object({
  biometricVerificationToken: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});

/** §4.2 `AcknowledgeSosRequest`. The ≥40 floor is §2.2.6's CRITICAL-severity tier, above §3.3's ≥20. */
export const AcknowledgeSosBody = Type.Object({
  actionTaken: FreeText(40, 4000),
  outcome: Type.Optional(AcknowledgmentOutcome),
  /** §8.2 — the responder records that she called, never the number. Masked at the client. */
  outreachPhoneNumberMasked: Type.Optional(Type.String({ maxLength: 40 })),
});

/** §4.2 `ResolveSosRequest` (decision 4 — the flag is kept and the route dispatches on it). */
export const ResolveSosBody = Type.Object({
  resolutionNarrative: FreeText(100, 8000),
  outcome: SosOutcome,
  openIncidentFromOutcome: Type.Optional(Type.Boolean()),
});

export const SosListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});

/** §4.1 row 10 — the D6 stream read. Paged, because a 4-hour stream at 30 s is ~480 samples. */
export const LocationStreamQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  /**
   * §6's "Coordinate read post-SOS" workflow — the Compliance-Officer escalation requires "an audit-event
   * narrative ≥40 chars explaining the reason", reviewable by the poster on her self-service surface.
   * Required by the READ SERVICE when the alert is no longer active; declared here at ≥40 so the boundary
   * refuses a two-word reason before the coordinates are ever decrypted.
   */
  accessReason: Type.Optional(FreeText(40, 1000)),
});

// ── §4.1 rows 12-17: incidents ───────────────────────────────────────────────────────────────────────

/** §4.2 `CreateIncidentRequest`. `oshaReportable` is deliberately absent — see the module header. */
export const CreateIncidentBody = Type.Object({
  affectedClinicianMembershipId: Uuid,
  category: IncidentCategory,
  severity: IncidentSeverity,
  visitId: UuidOpt,
  patientId: UuidOpt,
  occurredAt: Instant,
  locationDescription: Type.Optional(Type.String({ maxLength: 500 })),
  narrative: FreeText(200, 16000),
  witnesses: Type.Optional(Type.String({ maxLength: 4000 })),
  linkedSosAlertId: UuidOpt,
  workersCompClaimInitiated: Type.Optional(Type.Boolean()),
  workersCompClaimReference: Type.Optional(Type.String({ maxLength: 200 })),
});

/** §4.1 row 14 — edit a draft (or a supervisor's edit-on-behalf-of). */
export const PatchIncidentBody = Type.Object({
  category: Type.Optional(IncidentCategory),
  severity: Type.Optional(IncidentSeverity),
  occurredAt: InstantOpt,
  locationDescription: Type.Optional(Type.String({ maxLength: 500 })),
  narrative: Type.Optional(FreeText(200, 16000)),
  witnesses: Type.Optional(Type.String({ maxLength: 4000 })),
  workersCompClaimInitiated: Type.Optional(Type.Boolean()),
  workersCompClaimReference: Type.Optional(Type.String({ maxLength: 200 })),
});

/**
 * §4.2 `SubmitIncidentRequest`.
 *
 * `oshaReportable` IS on this body — §7.6 has David set it `false` at submit — and D9's rule is that
 * submitting with `true` requires the supervisor sign-off to ALREADY exist (§3.3's
 * `m20_si_osha_signoff_required` CHECK). So this field can only ever LOWER the bar for the clinician
 * filing; raising it is the step-up'd sign-off route's job, and the write service refuses a `true` here
 * without the signed-off pair rather than letting the driver raise a constraint violation.
 */
export const SubmitIncidentBody = Type.Object({
  oshaReportable: Type.Boolean(),
  finalNarrative: Type.Optional(FreeText(200, 16000)),
});

/** §4.2 `TransitionIncidentRequest`. */
export const TransitionIncidentBody = Type.Object({
  toState: IncidentTransitionState,
  reason: FreeText(30, 2000),
  actionPlan: Type.Optional(FreeText(1, 8000)),
});

/**
 * §4.1 row 17 / §7.6 / D9 — the OSHA-equivalent sign-off (step-up).
 *
 * `stateCode` and `reportingWindowHours` are REQUIRED, not derived. §7.6's whole point is that the
 * classification is state-specific ("Oregon's regs are different from California's") and the §4.9 alert
 * payload carries both so the compliance officer who receives it knows which clock is running. M20 holds
 * no state-OSHA rule table and inventing a default window would put a number on a filing deadline that
 * nobody chose.
 *
 * `reason` is ≥40: §7.6's own example is a citation of the governing rule, and it is the text a later
 * review reads to understand why an injury was reclassified.
 */
export const OshaSignoffBody = Type.Object({
  oshaReportable: Type.Boolean(),
  reason: FreeText(40, 4000),
  stateCode: Type.String({ minLength: 2, maxLength: 2 }),
  reportingWindowHours: Type.Integer({ minimum: 1, maximum: 720 }),
});

export const IncidentListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  lifecycleState: Type.Optional(
    Type.Union([
      Type.Literal("draft"),
      Type.Literal("submitted"),
      Type.Literal("under_review"),
      Type.Literal("returned_to_clinician"),
      Type.Literal("closed_with_action_plan"),
      Type.Literal("closed_no_action"),
      Type.Literal("reopened"),
    ]),
  ),
  oshaReportable: Type.Optional(Type.Boolean()),
});

// ── §4.1 rows 18-19: policy ──────────────────────────────────────────────────────────────────────────

export const PolicyQuery = Type.Object({ asOf: InstantOpt });

/**
 * §4.1 row 19 — the tenant policy edit (step-up).
 *
 * Every knob is optional and every one is BOUND by `SAFETY_POLICY_BOUNDS`. The bounds are NOT restated as
 * TypeBox `minimum`/`maximum` here, deliberately: `assertPolicyEditValid` (../lifecycle/policy.ts) already
 * validates the merged result against the same constant AND the ladder invariant a per-field range cannot
 * express, and it returns a 422 naming the knob and its band. Two copies of the band would be two things
 * to keep in step, and the one that is not the DB CHECK's sibling is the one that would drift.
 *
 * `editReason` is ≥30 per §2.2.4 — the one thing a later compliance review reads to understand why an
 * agency loosened its own watch.
 */
export const PatchPolicyBody = Type.Object({
  midVisitCadenceMinutes: Type.Optional(Type.Integer()),
  midVisitMinVisitDurationMinutes: Type.Optional(Type.Integer()),
  preVisitWindowMinutes: Type.Optional(Type.Integer()),
  postVisitWindowMinutes: Type.Optional(Type.Integer()),
  gentleReminderMinutes: Type.Optional(Type.Integer()),
  supervisorAlertMinutes: Type.Optional(Type.Integer()),
  escalationMinutes: Type.Optional(Type.Integer()),
  sosEquivalentMinutes: Type.Optional(Type.Integer()),
  sosCancelWindowSeconds: Type.Optional(Type.Integer()),
  sosCancelRequiresBiometric: Type.Optional(Type.Boolean()),
  sosContinuousLocationEnabled: Type.Optional(Type.Boolean()),
  sosContinuousLocationSampleSeconds: Type.Optional(Type.Integer()),
  sosContinuousLocationMaxDurationHours: Type.Optional(Type.Integer()),
  sosTier1SlaSeconds: Type.Optional(Type.Integer()),
  sosTier2SlaSeconds: Type.Optional(Type.Integer()),
  sosTier3SlaSeconds: Type.Optional(Type.Integer()),
  subscriptionModel: Type.Optional(
    Type.Union([
      Type.Literal("location_scoped"),
      Type.Literal("provider_entity_scoped"),
      Type.Literal("role_scoped"),
      Type.Literal("explicit_only"),
    ]),
  ),
  afterHoursStartHour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
  afterHoursEndHour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
  oshaReportableAutoFlagCategories: Type.Optional(Type.Array(IncidentCategory, { maxItems: 12 })),
  editReason: FreeText(30, 2000),
});

// ── §4.1 rows 20-22: supervisor subscriptions ────────────────────────────────────────────────────────

/**
 * §4.1 row 21 — create a subscription.
 *
 * The four scope selectors are all optional at the SCHEMA level because §3.3's `m20_sss_scope_integrity`
 * CHECK is the authority on which one each `scopeKind` requires, and it is a cross-field rule TypeBox
 * would have to restate as a four-arm discriminated union that then had to be kept in step with the
 * CHECK. The write service asserts the pairing and returns a 422 naming the missing selector.
 */
export const CreateSubscriptionBody = Type.Object({
  supervisorMembershipId: Uuid,
  scopeKind: SubscriptionScopeKind,
  clinicianMembershipId: UuidOpt,
  locationId: UuidOpt,
  providerEntityId: UuidOpt,
  alertKinds: Type.Array(AlertKind, { minItems: 1, maxItems: 4 }),
  isVacationForwarding: Type.Optional(Type.Boolean()),
  vacationForwardToMembershipId: UuidOpt,
});

export const SubscriptionListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  clinicianMembershipId: UuidOpt,
  supervisorMembershipId: UuidOpt,
});

// ── §4.1 rows 23-25: high-risk areas ─────────────────────────────────────────────────────────────────

/**
 * M20-F07 — the polygon is GeoJSON-shaped RINGS as jsonb, `[longitude, latitude]`, SRID 4326. There is no
 * PostGIS (§3.2 Phase F struck it), so ring closure, winding and the ≥4-point minimum are the app's; the
 * schema asserts the SHAPE and the write service runs the validity check the CHECK cannot.
 */
export const PolygonRings = Type.Array(
  Type.Array(
    Type.Tuple([
      Type.Number({ minimum: -180, maximum: 180 }),
      Type.Number({ minimum: -90, maximum: 90 }),
    ]),
    {
      minItems: 4,
      maxItems: 2000,
    },
  ),
  { minItems: 1, maxItems: 20 },
);

export const CreateHighRiskAreaBody = Type.Object({
  riskCategory: HighRiskCategory,
  advisoryMessage: FreeText(1, 200),
  polygon: PolygonRings,
  policyForVisitsToArea: Type.Optional(HighRiskAreaPolicy),
  effectiveFrom: InstantOpt,
  effectiveTo: InstantOpt,
});

export const PatchHighRiskAreaBody = Type.Object({
  riskCategory: Type.Optional(HighRiskCategory),
  advisoryMessage: Type.Optional(FreeText(1, 200)),
  polygon: Type.Optional(PolygonRings),
  policyForVisitsToArea: Type.Optional(HighRiskAreaPolicy),
  effectiveTo: InstantOpt,
});

export const HighRiskAreaListQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  /** Default false — the editor wants history, the pre-visit advisory wants only what is in force. */
  includeExpired: Type.Optional(Type.Boolean()),
});

// ── §4.1 row 26: the supervisor board ────────────────────────────────────────────────────────────────

/**
 * §4.2 `SupervisorDashboardResponse`'s query.
 *
 * `locationId` and `supervisorMembershipId` select WHICH of `SafetyDashboardProvider`'s two reads to make
 * (§4.3 publishes exactly those two). Neither is required: a clinician with no supervisor grant gets her
 * OWN row, which is what §6's "clinicians see their own state only" means and what the read service
 * enforces — the guard's `caseload_or_scope` arm cannot express a row filter.
 */
export const DashboardQuery = Type.Object({
  locationId: UuidOpt,
  supervisorMembershipId: UuidOpt,
  asOf: InstantOpt,
  patientId: UuidOpt,
});

// ── §4.1 rows 27-29: the clinician's own consent surface ─────────────────────────────────────────────

export const ConsentQuery = Type.Object({ purpose: Type.Optional(ConsentPurpose) });

/**
 * §4.1 row 28 — grant one consent purpose.
 *
 * `acknowledgmentTextSnapshot` is REQUIRED and is NOT audit-denylisted (§3.3's own note): it is the policy
 * text the clinician was actually shown, and it is the one thing a consent dispute turns on. A grant with
 * no snapshot would leave the trail able to prove a consent existed and unable to say what was consented
 * to.
 *
 * `contact` is required exactly for `emergency_contact_call` (§3.3's `m20_secc_contact_present`), and it
 * is M20-F06's whole record: M2 has no emergency-contact table, so this consent row IS the contact.
 */
export const GrantConsentBody = Type.Object({
  purpose: ConsentPurpose,
  acknowledgmentTextSnapshot: FreeText(1, 8000),
  expiresAt: InstantOpt,
  contact: Type.Optional(
    Type.Object({
      name: FreeText(1, 200),
      phone: FreeText(1, 40),
      relationship: Type.Optional(Type.String({ maxLength: 100 })),
    }),
  ),
});

/** §4.1 row 29 — revoke one purpose. `revoked` is not `expired` (§2.2.8); this route only writes the first. */
export const RevokeConsentBody = Type.Object({
  purpose: ConsentPurpose,
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────────
//
// The §4.1 read + write routes returned typed service views (`SafetyCheckInView`, `SafetySosAlertView`,
// `SafetyIncidentView`, the two seam DTOs, the cursor pages) but published NO response contract, so the
// generated client typed every body as `never`. These DTOs mirror the read/write service views 1:1 and are
// pinned to them by the compile-time `Conforms` aliases at the foot of this section, so a view field added
// or renamed breaks `bun run build` rather than silently drifting from the client. Enums are literal unions
// (never `Type.String()` — the M30 "a wire enum published as a bare string is a silent lie" lesson). Every
// id is a plain `string` on the wire (the `@chartwarden/types` id aliases are unbranded), and every `| null`
// service field is a `Type.Union([_, Type.Null()])` — NEVER `Type.Optional`, which would drop the key.
import type {
  SafetyDashboardSnapshot as _SafetyDashboardSnapshot,
  SafetyPolicyEffectiveDto as _SafetyPolicyEffectiveDto,
} from "@chartwarden/types";
import type { CursorPage as _CursorPage } from "./concurrency";
import type {
  ActiveSosView as _ActiveSosView,
  SafetyCheckInView as _SafetyCheckInView,
  SafetyConsentSurface as _SafetyConsentSurface,
  SafetyConsentView as _SafetyConsentView,
  SafetyHighRiskAreaView as _SafetyHighRiskAreaView,
  SafetyIncidentView as _SafetyIncidentView,
  SafetyMyDayView as _SafetyMyDayView,
  SafetySosAlertView as _SafetySosAlertView,
  SafetySubscriptionView as _SafetySubscriptionView,
  SosLocationStreamPage as _SosLocationStreamPage,
} from "./read-service";
import type {
  CancelSosResult as _CancelSosResult,
  DeleteSubscriptionResult as _DeleteSubscriptionResult,
  RaiseSosResult as _RaiseSosResult,
  RecordCheckInResult as _RecordCheckInResult,
} from "./write-service";

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const Str = Type.String();
const IntNum = Type.Integer();
const NumSchema = Type.Number();
const Bool = Type.Boolean();

// Full read-view vocabulary unions (the request schemas above pin the mutating subsets; reads carry more).
/** `safety_sos_lifecycle_state` — the full §2.2.2 chain, incl. `emergency_terminus`. */
export const SosLifecycleState = Type.Union([
  Type.Literal("raised"),
  Type.Literal("cancel_window_open"),
  Type.Literal("acknowledging"),
  Type.Literal("acknowledged"),
  Type.Literal("escalation_tier_1"),
  Type.Literal("escalation_tier_2"),
  Type.Literal("escalation_tier_3"),
  Type.Literal("emergency_terminus"),
  Type.Literal("resolving"),
  Type.Literal("resolved"),
  Type.Literal("cancelled_in_window"),
  Type.Literal("cancel_attempted_but_rejected"),
  Type.Literal("incident_opened"),
]);

/** `safety_sos_cancel_status` — D5. */
export const SosCancelStatus = Type.Union([
  Type.Literal("not_cancelled"),
  Type.Literal("cancelled_in_window"),
  Type.Literal("cancel_attempted_but_rejected"),
]);

/** `safety_incident_state` — the full §2.2.3 set (read view carries `draft`/`submitted`, unlike transitions). */
export const IncidentStateFull = Type.Union([
  Type.Literal("draft"),
  Type.Literal("submitted"),
  Type.Literal("under_review"),
  Type.Literal("returned_to_clinician"),
  Type.Literal("closed_with_action_plan"),
  Type.Literal("closed_no_action"),
  Type.Literal("reopened"),
]);

/** `safety_overdue_badge`. */
export const OverdueBadge = Type.Union([
  Type.Literal("on_time"),
  Type.Literal("reminder"),
  Type.Literal("overdue"),
  Type.Literal("escalated"),
]);

/** `safety_location_source`. */
export const LocationSource = Type.Union([
  Type.Literal("evv_check_in"),
  Type.Literal("evv_check_out"),
  Type.Literal("m20_check_in"),
  Type.Literal("sos_active"),
]);

/** `safety_emergency_contact_consent_status`. */
export const ConsentStatus = Type.Union([
  Type.Literal("granted"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
]);

/** `safety_coverage_gap_reason`. */
export const CoverageGapReason = Type.Union([
  Type.Literal("no_subscription"),
  Type.Literal("all_subscriptions_deactivated"),
  Type.Literal("vacation_forwards_unresolved"),
]);

/** `safety_subscription_model`. */
export const SubscriptionModel = Type.Union([
  Type.Literal("location_scoped"),
  Type.Literal("provider_entity_scoped"),
  Type.Literal("role_scoped"),
  Type.Literal("explicit_only"),
]);

// rows 1-4: check-ins
export const SafetyCheckInResponse = Type.Object({
  id: Str,
  scheduleId: Nullable(Str),
  visitId: Nullable(Str),
  postedByMembershipId: Str,
  postedAt: Str,
  kind: CheckInKind,
  status: CheckInStatus,
  concernNote: Nullable(Str),
  coordinatesCaptured: Bool,
  isPartOfSosBracket: Bool,
  correctsCheckInId: Nullable(Str),
  supersededAt: Nullable(Str),
  supersededByCheckInId: Nullable(Str),
  amendableUntil: Nullable(Str),
});

const WarningSchema = Type.Object({ code: Str, message: Str });

export const RecordCheckInResponse = Type.Object({
  checkIn: SafetyCheckInResponse,
  scheduleClosed: Bool,
  warningsSurfaced: Type.Array(WarningSchema),
});

const MyDayObligation = Type.Object({
  scheduleId: Str,
  visitId: Nullable(Str),
  kind: CheckInKind,
  expectedAt: Str,
  windowMinutes: NumSchema,
  state: CheckInState,
  fulfilledByCheckInId: Nullable(Str),
});

export const SafetyMyDayResponse = Type.Object({
  asOf: Str,
  obligations: Type.Array(MyDayObligation),
  recentCheckIns: Type.Array(SafetyCheckInResponse),
});

// rows 5-11: SOS
export const RaiseSosResponse = Type.Object({
  id: Str,
  postedAt: Str,
  cancelWindowExpiresAt: Str,
  lifecycleState: SosLifecycleState,
  acknowledgersDispatched: Nullable(NumSchema),
  warningsSurfaced: Type.Array(WarningSchema),
});

export const CancelSosResponse = Type.Object({
  id: Str,
  cancelStatus: Type.Union([
    Type.Literal("cancelled_in_window"),
    Type.Literal("cancel_attempted_but_rejected"),
  ]),
  lifecycleState: SosLifecycleState,
});

const SosStateHistoryEntry = Type.Object({
  fromState: Nullable(SosLifecycleState),
  toState: SosLifecycleState,
  transitionedAt: Str,
  transitionedByMembershipId: Nullable(Str),
});

const SosAcknowledgmentEntry = Type.Object({
  id: Str,
  acknowledgedByMembershipId: Str,
  acknowledgedAt: Str,
  actionTaken: Str,
  outcome: Nullable(Str),
});

export const SafetySosAlertResponse = Type.Object({
  id: Str,
  providerEntityId: Str,
  postedByMembershipId: Str,
  postedAt: Str,
  lastKnownVisitId: Nullable(Str),
  lifecycleState: SosLifecycleState,
  cancelWindowExpiredAt: Str,
  cancelStatus: SosCancelStatus,
  cancelAttemptedAt: Nullable(Str),
  acknowledgedAt: Nullable(Str),
  acknowledgedByMembershipId: Nullable(Str),
  resolvedAt: Nullable(Str),
  resolvedByMembershipId: Nullable(Str),
  outcome: Nullable(SosOutcome),
  resolutionNarrative: Nullable(Str),
  resolutionNarrativeAvailable: Bool,
  linkedIncidentId: Nullable(Str),
  coordinatesCaptured: Bool,
  version: IntNum,
  stateHistory: Type.Array(SosStateHistoryEntry),
  acknowledgments: Type.Array(SosAcknowledgmentEntry),
});

const LocationStreamSample = Type.Object({
  id: Str,
  sampledAt: Str,
  latitude: NumSchema,
  longitude: NumSchema,
  accuracyM: NumSchema,
});

export const SosLocationStreamResponse = Type.Object({
  sosAlertId: Str,
  samples: Type.Array(LocationStreamSample),
  next_cursor: Nullable(Str),
  has_more: Bool,
  auditWarningBanner: Str,
});

const ActiveSosAlertEntry = Type.Object({
  id: Str,
  postedByMembershipId: Str,
  postedByFirstName: Str,
  postedAt: Str,
  lifecycleState: SosLifecycleState,
  minutesOpen: NumSchema,
  acknowledgedAt: Nullable(Str),
});

export const ActiveSosResponse = Type.Object({
  alerts: Type.Array(ActiveSosAlertEntry),
  fetchedAt: Str,
});

// rows 12-17: incidents
const IncidentStateHistoryEntry = Type.Object({
  fromState: Nullable(IncidentStateFull),
  toState: IncidentStateFull,
  transitionedAt: Str,
  transitionedByMembershipId: Nullable(Str),
  reason: Nullable(Str),
});

export const SafetyIncidentResponse = Type.Object({
  id: Str,
  providerEntityId: Str,
  affectedClinicianMembershipId: Str,
  reportedByMembershipId: Str,
  category: IncidentCategory,
  severity: IncidentSeverity,
  visitId: Nullable(Str),
  patientId: Nullable(Str),
  occurredAt: Str,
  reportedAt: Str,
  locationDescription: Nullable(Str),
  narrative: Nullable(Str),
  narrativeAvailable: Bool,
  witnesses: Nullable(Str),
  oshaReportable: Bool,
  oshaReportableSignedOffByMembershipId: Nullable(Str),
  oshaReportableSignedOffAt: Nullable(Str),
  workersCompClaimInitiated: Bool,
  workersCompClaimReference: Nullable(Str),
  linkedSosAlertId: Nullable(Str),
  lifecycleState: IncidentStateFull,
  submittedAt: Nullable(Str),
  reviewedByMembershipId: Nullable(Str),
  reviewedAt: Nullable(Str),
  actionPlan: Nullable(Str),
  actionPlanAvailable: Bool,
  closedAt: Nullable(Str),
  reopenReason: Nullable(Str),
  version: IntNum,
  stateHistory: Type.Array(IncidentStateHistoryEntry),
});

export const SafetyIncidentPageResponse = Type.Object({
  data: Type.Array(SafetyIncidentResponse),
  next_cursor: Nullable(Str),
  has_more: Bool,
});

// rows 18-19: policy
export const SafetyPolicyEffectiveResponse = Type.Object({
  organizationId: Str,
  versionId: Str,
  effectiveFrom: Str,
  effectiveTo: Nullable(Str),
  midVisitCadenceMinutes: NumSchema,
  midVisitMinVisitDurationMinutes: NumSchema,
  preVisitWindowMinutes: NumSchema,
  postVisitWindowMinutes: NumSchema,
  gentleReminderMinutes: NumSchema,
  supervisorAlertMinutes: NumSchema,
  escalationMinutes: NumSchema,
  sosEquivalentMinutes: NumSchema,
  sosCancelWindowSeconds: NumSchema,
  sosCancelRequiresBiometric: Bool,
  sosContinuousLocationEnabled: Bool,
  sosContinuousLocationSampleSeconds: NumSchema,
  sosContinuousLocationMaxDurationHours: NumSchema,
  sosTier1SlaSeconds: NumSchema,
  sosTier2SlaSeconds: NumSchema,
  sosTier3SlaSeconds: NumSchema,
  subscriptionModel: SubscriptionModel,
  afterHoursStartHour: NumSchema,
  afterHoursEndHour: NumSchema,
  oshaReportableAutoFlagCategories: Type.Array(IncidentCategory),
});

// rows 20-22: subscriptions
export const SafetySubscriptionResponse = Type.Object({
  id: Str,
  supervisorMembershipId: Str,
  clinicianMembershipId: Nullable(Str),
  locationId: Nullable(Str),
  providerEntityId: Nullable(Str),
  scopeKind: SubscriptionScopeKind,
  alertKinds: Type.Array(AlertKind),
  isVacationForwarding: Bool,
  vacationForwardToMembershipId: Nullable(Str),
  createdAt: Str,
});

export const SafetySubscriptionPageResponse = Type.Object({
  data: Type.Array(SafetySubscriptionResponse),
  next_cursor: Nullable(Str),
  has_more: Bool,
});

const CoverageGapEntry = Type.Object({
  clinicianMembershipId: Str,
  reason: CoverageGapReason,
});

export const DeleteSubscriptionResponse = Type.Object({
  id: Str,
  deactivatedAt: Str,
  coverageGapsCreated: Type.Array(CoverageGapEntry),
});

// rows 23-25: high-risk areas
export const SafetyHighRiskAreaResponse = Type.Object({
  id: Str,
  riskCategory: HighRiskCategory,
  advisoryMessage: Str,
  polygon: PolygonRings,
  policyForVisitsToArea: HighRiskAreaPolicy,
  effectiveFrom: Str,
  effectiveTo: Nullable(Str),
  createdByMembershipId: Nullable(Str),
});

export const SafetyHighRiskAreaPageResponse = Type.Object({
  data: Type.Array(SafetyHighRiskAreaResponse),
  next_cursor: Nullable(Str),
  has_more: Bool,
});

// row 26: the supervisor board
const LastKnownLocationEntry = Type.Object({
  source: LocationSource,
  sampledAt: Str,
  ageMinutes: NumSchema,
});

const ClinicianStatusEntry = Type.Object({
  membershipId: Str,
  displayName: Str,
  currentVisitId: Nullable(Str),
  currentPatientFirstName: Nullable(Str),
  lastKnownLocation: Nullable(LastKnownLocationEntry),
  lastCheckInAt: Nullable(Str),
  lastCheckInStatus: Nullable(CheckInStatus),
  nextExpectedCheckInAt: Nullable(Str),
  overdueState: OverdueBadge,
  activeSosAlert: Nullable(
    Type.Object({ id: Str, raisedAt: Str, lifecycleState: SosLifecycleState }),
  ),
  inHighRiskArea: Nullable(
    Type.Object({ areaId: Str, riskCategory: HighRiskCategory, advisoryMessage: Str }),
  ),
  gpsSpoofSuspected: Bool,
});

export const SafetyDashboardResponse = Type.Object({
  clinicians: Type.Array(ClinicianStatusEntry),
  activeSosCount: NumSchema,
  overdueCount: NumSchema,
  fetchedAt: Str,
});

// rows 27-29: the clinician's own consent surface
export const SafetyConsentResponse = Type.Object({
  purpose: ConsentPurpose,
  status: ConsentStatus,
  grantedAt: Str,
  revokedAt: Nullable(Str),
  expiresAt: Nullable(Str),
  acknowledgmentTextSnapshot: Str,
  contactOnFile: Bool,
});

export const SafetyConsentSurfaceResponse = Type.Object({
  consents: Type.Array(SafetyConsentResponse),
  asOf: Str,
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _CheckIn = Conforms<Static<typeof SafetyCheckInResponse>, _SafetyCheckInView>;
type _RecordCheckIn = Conforms<Static<typeof RecordCheckInResponse>, _RecordCheckInResult>;
type _MyDay = Conforms<Static<typeof SafetyMyDayResponse>, _SafetyMyDayView>;
type _RaiseSos = Conforms<Static<typeof RaiseSosResponse>, _RaiseSosResult>;
type _CancelSos = Conforms<Static<typeof CancelSosResponse>, _CancelSosResult>;
type _SosAlert = Conforms<Static<typeof SafetySosAlertResponse>, _SafetySosAlertView>;
type _LocStream = Conforms<Static<typeof SosLocationStreamResponse>, _SosLocationStreamPage>;
type _ActiveSos = Conforms<Static<typeof ActiveSosResponse>, _ActiveSosView>;
type _Incident = Conforms<Static<typeof SafetyIncidentResponse>, _SafetyIncidentView>;
type _IncidentPage = Conforms<
  Static<typeof SafetyIncidentPageResponse>,
  _CursorPage<_SafetyIncidentView>
>;
type _Policy = Conforms<Static<typeof SafetyPolicyEffectiveResponse>, _SafetyPolicyEffectiveDto>;
type _Subscription = Conforms<Static<typeof SafetySubscriptionResponse>, _SafetySubscriptionView>;
type _SubscriptionPage = Conforms<
  Static<typeof SafetySubscriptionPageResponse>,
  _CursorPage<_SafetySubscriptionView>
>;
type _DeleteSub = Conforms<Static<typeof DeleteSubscriptionResponse>, _DeleteSubscriptionResult>;
type _Area = Conforms<Static<typeof SafetyHighRiskAreaResponse>, _SafetyHighRiskAreaView>;
type _AreaPage = Conforms<
  Static<typeof SafetyHighRiskAreaPageResponse>,
  _CursorPage<_SafetyHighRiskAreaView>
>;
type _Dashboard = Conforms<Static<typeof SafetyDashboardResponse>, _SafetyDashboardSnapshot>;
type _Consent = Conforms<Static<typeof SafetyConsentResponse>, _SafetyConsentView>;
type _ConsentSurface = Conforms<Static<typeof SafetyConsentSurfaceResponse>, _SafetyConsentSurface>;
