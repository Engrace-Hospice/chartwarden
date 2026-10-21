// @chartwarden/quality · consumers — the §4.10 UPSTREAM-event handlers (PURE, port-injected).
//
// One pure handler per subscribed topic (`./subscription-map.ts`). Each projects the structurally-minimal
// upstream event into its M30 effect — a row-draft to insert, or a debounced measure-recompute request —
// and fans it out through the injected {@link M30ConsumerPorts}. This is the exact mirror of M33's
// `refresh/outbox-subscriber.ts` `handleUpstreamInvalidation`: a pure projection + a thin port-injected
// orchestrator, unit-testable against in-memory ports.
//
// PURITY / BOUNDARIES (RULE 1 & 2): NO DB, NO BullMQ, NO Fastify, NO direct M5–M23 import — the upstream
// event STRING + its payload SHAPE is the entire contract. The effect ports are INJECTED; at the
// composition root the integrator binds them to the real Drizzle repositories (recompute queue, mortality
// store, CAHPS candidate set, incident store), and any unlanded port stays a LAZY fail-closed thunk so a
// throw happens only when a JOB RUNS, never at port-bundle construction (RULE 2 / the M34 eager-bind
// gotcha). These handlers are NOT boot-wired to a running subscriber (RULE 3(d)) — they ship pure + the
// subscription map; the live inbound dispatcher is a later platform phase.
import type { schema } from "@chartwarden/db";
import type { DecedentDeathSource } from "../cahps/sampler";
import { type IncidentTriggerEvent, buildIncidentDraftFromEvent } from "../incidents/auto_creator";
import { MEASURE_CATALOG, type MeasureFamily } from "../measures/registry";
import {
  type DischargeDeathEvent,
  type MortalityReviewAutoCreateResult,
  buildMortalityReviewFromDeath,
} from "../mortality_review/auto_creator";
import { type M30SubscriptionEffect, effectsForTopic } from "./subscription-map";

// ── effect request shapes (what a handler hands its port) ───────────────────────────────────────────────

/**
 * A debounced measure-recompute request the {@link M30ConsumerPorts.enqueueRecompute} port collapses onto
 * the §3.3 `measure_recompute_queue`. The handler resolves the concrete `measureCodes` from the effect's
 * families (pure, against {@link MEASURE_CATALOG}); the bound port resolves the active reporting period +
 * provider scope and issues the debounced upsert (the partial-UNIQUE collapses a burst into one row).
 */
export interface RecomputeEnqueueRequest {
  /** Canonical tenant scope (`app.org_id` RLS key). */
  readonly organizationId: string;
  /** The M40 provider entity the recompute is scoped to. */
  readonly providerEntityId: string;
  /** The measure families that dirtied (provenance / the port may widen the scan). */
  readonly families: readonly MeasureFamily[];
  /** The concrete measure codes to recompute (resolved from `families` against the catalog). */
  readonly measureCodes: readonly string[];
  /** Human provenance note (the §4.10 subscriber-table cell). */
  readonly reason: string;
  /** The originating upstream outbox-event id (→ recompute-row provenance + §2.6 idempotency). */
  readonly triggeringEventId: string;
}

/**
 * A decedent seeded into the next monthly CAHPS sample candidate set (§4.13 / WF-04). The lightweight feed
 * record — the monthly sampler later enriches it with the CMS-exclusion facts + encrypted caregiver
 * contact. Mirrors the death event's keys (no PHI beyond the logical FKs).
 */
export interface CahpsCandidateAddRequest {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly deceasedPatientId: string;
  readonly deceasedAdmissionId: string;
  /** The instant of death (anchors the candidate to its sample month). */
  readonly deathAt: Date;
  /** §4.13 source marker — drives the QAPI spot-check of external-source decedents. */
  readonly deathSource: DecedentDeathSource;
  /** The originating `m6.discharge.death` outbox-event id (§2.6 idempotency on the candidate set). */
  readonly triggeringEventId: string;
}

// ── the injected effect ports (bound to Drizzle repositories at the composition root) ────────────────────

/**
 * The effect ports the handlers fan out through (INJECTED at boot, RULE 2). Each is `async` so the binding
 * can wrap the write in `withOrgContext` + the transactional outbox; the pure handlers never touch the DB.
 * An unlanded port binds to a LAZY fail-closed thunk (throws only when the handler runs), never a no-op.
 */
export interface M30ConsumerPorts {
  /** Enqueue (debounced) a measure recompute onto the §3.3 work list. */
  readonly enqueueRecompute: (request: RecomputeEnqueueRequest) => Promise<void>;
  /** Persist an auto-created `mortality_review` draft (the §4.12 build result carries clock/retention). */
  readonly createMortalityReviewDraft: (result: MortalityReviewAutoCreateResult) => Promise<void>;
  /** Seed a decedent into the next monthly CAHPS sample candidate set. */
  readonly addCahpsSampleCandidate: (request: CahpsCandidateAddRequest) => Promise<void>;
  /** Persist an auto-created `draft` `incident_report` row (the D8 auto-incident path). */
  readonly createIncidentDraft: (row: schema.NewIncidentReport) => Promise<void>;
}

// ── pure projection helpers ──────────────────────────────────────────────────────────────────────────────

/**
 * The active measure codes belonging to any of the named families (PURE, against {@link MEASURE_CATALOG}).
 * Deterministic catalog order; deduped. CAHPS-family measures are vendor-survey-derived (not recompute-
 * queue driven) and never appear in a recompute fan-out, but the filter stays family-general.
 */
export function measureCodesForFamilies(families: readonly MeasureFamily[]): readonly string[] {
  const wanted = new Set<MeasureFamily>(families);
  return MEASURE_CATALOG.filter((entry) => wanted.has(entry.family)).map((entry) => entry.code);
}

/** Map the M6 discharge `source` discriminator onto the §4.13 CAHPS `DecedentDeathSource`. */
function cahpsDeathSourceOf(event: DischargeDeathEvent): DecedentDeathSource {
  return (event.source ?? "internal_clinician_recorded") === "hl7_external"
    ? "external_import"
    : "admission_discharge";
}

// ── per-topic handlers (PURE projection + port fan-out) ─────────────────────────────────────────────────

/** The structured result of handling one upstream event — the effects applied, for the §4.10 fan-out test. */
export interface UpstreamConsumeReport {
  readonly eventName: string;
  /** The effect kinds the topic projected to (in order). */
  readonly effects: readonly M30SubscriptionEffect["kind"][];
}

/**
 * `m6.discharge.death` → draft a `mortality_review` AND seed the next CAHPS sample (§4.10). Reuses the pure
 * {@link buildMortalityReviewFromDeath} (which derives the W-M30-27 completion clock + W-M30-28 retention
 * decision) and projects the lightweight CAHPS candidate. Idempotency rides the death event's
 * `eventIdempotencyKey` (the mortality row's `created_via_event_idempotency_key` + the candidate-set key).
 */
export async function handleDischargeDeath(
  event: DischargeDeathEvent,
  ports: M30ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const mortality = buildMortalityReviewFromDeath(event);
  await ports.createMortalityReviewDraft(mortality);
  await ports.addCahpsSampleCandidate({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    deceasedPatientId: event.deceasedPatientId,
    deceasedAdmissionId: event.admissionId,
    deathAt: event.deathAt,
    deathSource: cahpsDeathSourceOf(event),
    triggeringEventId: event.eventIdempotencyKey,
  });
  return {
    eventName: "m6.discharge.death",
    effects: ["mortality_review_draft", "cahps_candidate_add"],
  };
}

/**
 * GAP-089 — the mortality-draft HALF of {@link handleDischargeDeath}, bindable on its own: the CAHPS half
 * (`addCahpsSampleCandidate`) is blocked on the M1 caregiver-contact DEK, and calling both in one handler
 * made the whole `m6.discharge.death` binding impossible. Only `ports.createMortalityReviewDraft` is used.
 */
export async function handleDischargeDeathMortality(
  event: DischargeDeathEvent,
  ports: Pick<M30ConsumerPorts, "createMortalityReviewDraft">,
): Promise<UpstreamConsumeReport> {
  await ports.createMortalityReviewDraft(buildMortalityReviewFromDeath(event));
  return { eventName: "m6.discharge.death", effects: ["mortality_review_draft"] };
}

/** The minimal `m6.election.signed` payload M30 reads (§4.10). */
export interface ElectionSignedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The patient whose election shifts the HCI denominators (logical FK M5). */
  readonly patientId: string;
}

/** `m6.election.signed` → enqueue an HCI recompute (a new election shifts the HCI denominators). */
export async function handleElectionSigned(
  event: ElectionSignedEvent,
  ports: M30ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  await enqueueFamilyRecompute(event, ["hci"], "m6.election.signed — HCI denominator shift", ports);
  return { eventName: "m6.election.signed", effects: ["recompute"] };
}

/**
 * The minimal `m16.bereavement.plan_closed_completed` / `.plan_closed_declined` / `.plan_closed_early`
 * payload M30 reads (§4.10, F-160-follow-up / #248). `providerEntityId` is NOT on any of the three
 * catalogued wire payloads (each carries only `{planId, ...}`) — the consumer BINDING resolves it via
 * the new org-explicit `bereavementPlanSitingForOrg` read before calling this handler; the handler stays
 * pure and never sees `planId` alone.
 */
export interface BereavementPlanClosedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The plan that closed (logical FK M16). */
  readonly planId: string;
  /** The catalogued source event name (one of the three `plan_closed_*` topics) — carried through into
   *  the recompute-queue row's `triggering_event_name` provenance rather than a single hardcoded string. */
  readonly sourceEventName: string;
}

/**
 * `m16.bereavement.plan_closed_completed` / `.plan_closed_declined` / `.plan_closed_early` → enqueue a
 * `bereavement_coverage_rate` recompute.
 *
 * NOT a family-wide fan-out (unlike every other `enqueueFamilyRecompute` caller in this file): the three
 * `planClosureCounts` seam calls a plan closure would most directly answer feed NO currently-registered
 * M30 measure ("bound is not computing" — F-115/F-148), so triggering the whole `operational` family
 * here would recompute a dozen measures (missed-dose rate, IDG cadence, …) with no data dependency on a
 * bereavement plan closing. The REAL, mechanically-verified dependency is narrower and indirect: every
 * one of these three transitions runs a `cancel_future_outreach` effect
 * (`apps/backend/src/modules/16-bereavement/lifecycle/plan.ts`) that flips every still-`scheduled`
 * `bereavement_outreach` touchpoint to `cancelled` — and `cancelled` is EXCLUDED from both
 * `COP_NUMERATOR_STATUSES` and `COP_DENOMINATOR_STATUSES` (`16-bereavement/seams/store.ts`), the exact
 * counts `bereavement_coverage_rate`'s calculator reads via `copOutreachCounts`. A plan closure therefore
 * measurably shrinks that measure's denominator for any recompute period whose window still includes the
 * now-cancelled touchpoints' `dueAt`. `measureCodes` names only the one measure this fact actually
 * feeds, rather than going through `measureCodesForFamilies`.
 */
export async function handleBereavementPlanClosed(
  event: BereavementPlanClosedEvent,
  ports: M30ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  await ports.enqueueRecompute({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    families: ["operational"],
    measureCodes: ["bereavement_coverage_rate"],
    reason: `${event.sourceEventName} — plan closure cancels future outreach touchpoints, shifting the CoP 418.64(d) coverage denominator`,
    triggeringEventId: event.eventId,
  });
  return { eventName: event.sourceEventName, effects: ["recompute"] };
}

/** The minimal `m10.hope.submission_accepted` payload M30 reads (§4.10). */
export interface HopeSubmissionAcceptedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The accepted HOPE submission (logical FK M10). */
  readonly submissionId: string;
}

/** `m10.hope.submission_accepted` → enqueue a HOPE-derived (TFP) recompute. */
export async function handleHopeSubmissionAccepted(
  event: HopeSubmissionAcceptedEvent,
  ports: M30ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  await enqueueFamilyRecompute(
    event,
    ["hope_derived"],
    "m10.hope.submission_accepted — TFP measure feed",
    ports,
  );
  return { eventName: "m10.hope.submission_accepted", effects: ["recompute"] };
}

/** The minimal `m23.claim.adjudicated` payload M30 reads (§4.10). */
export interface ClaimAdjudicatedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The adjudicated claim (logical FK M23). */
  readonly claimId: string;
}

/** `m23.claim.adjudicated` → enqueue an HCI claims-derived recompute. */
export async function handleClaimAdjudicated(
  event: ClaimAdjudicatedEvent,
  ports: M30ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  await enqueueFamilyRecompute(
    event,
    ["hci"],
    "m23.claim.adjudicated — HCI claims-derived indicators",
    ports,
  );
  return { eventName: "m23.claim.adjudicated", effects: ["recompute"] };
}

/**
 * `m12.medication.error_reported` → auto-file a `medication_error` incident draft (D8). The consumer
 * binding injects the resolved `occurredAt`, the M30 service `reportedByMembershipId`, and the
 * `triggeringEventOutboxId` (the §2.6 idempotency backstop) onto the trigger event before calling; this
 * handler reuses the pure {@link buildIncidentDraftFromEvent} and persists the draft.
 */
export async function handleMedicationErrorReported(
  event: Extract<IncidentTriggerEvent, { type: "m12.medication.error_reported" }>,
  ports: M30ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const row = buildIncidentDraftFromEvent(event);
  await ports.createIncidentDraft(row);
  return { eventName: "m12.medication.error_reported", effects: ["incident_draft"] };
}

/**
 * `m37.restraint.applied` → auto-file a `restraint_use` incident draft (F-185, #248, D8). Exact mirror of
 * {@link handleMedicationErrorReported}: the consumer binding injects the resolved `occurredAt`, the M30
 * service `reportedByMembershipId`, and the `triggeringEventOutboxId`, plus a `providerEntityId` resolved
 * off M37's `ipu_admission` (the payload carries no `providerEntityId` — see the consumer binding's own
 * doc comment); this handler reuses the pure {@link buildIncidentDraftFromEvent} and persists the draft.
 */
export async function handleRestraintApplied(
  event: Extract<IncidentTriggerEvent, { type: "m37.restraint.applied" }>,
  ports: M30ConsumerPorts,
): Promise<UpstreamConsumeReport> {
  const row = buildIncidentDraftFromEvent(event);
  await ports.createIncidentDraft(row);
  return { eventName: "m37.restraint.applied", effects: ["incident_draft"] };
}

/** The minimal `m18.evv.visit_verified` payload M30 reads (§4.10). */
export interface EvvVisitVerifiedEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The patient whose visit was verified (logical FK M5). */
  readonly patientId: string;
  /** The verified visit (logical FK M17/M18). */
  readonly visitId: string;
  /** The instant the visit was EVV-verified. */
  readonly verifiedAt: Date;
  /**
   * Whole days from the verified visit to the nearest decedent's death, as resolved by the consumer
   * BINDING (a quality read at the composition root — NOT in this pure handler). The ±`windowDays` guard
   * short-circuits on it: a number GREATER than the window means no qualifying death is near → SKIP. When
   * `undefined`/`null` (the binding could not resolve proximity) the handler ENQUEUES — the §3.3 debounce
   * (one pending HVLDL row per provider/period) is the storm backstop, so it never silently drops.
   */
  readonly nearestDeathWithinDays?: number | null;
}

/**
 * `m18.evv.visit_verified` → enqueue an HVLDL recompute when the verified visit sits within ±`windowDays`
 * of a death (§4.10). The ±-day guard reads {@link EvvVisitVerifiedEvent.nearestDeathWithinDays} (resolved
 * by the binding); a death strictly outside the window is a deliberate no-op.
 */
export async function handleEvvVisitVerified(
  event: EvvVisitVerifiedEvent,
  ports: M30ConsumerPorts,
  windowDays = 3,
): Promise<UpstreamConsumeReport> {
  const proximity = event.nearestDeathWithinDays;
  const withinWindow = proximity == null || proximity <= windowDays;
  if (!withinWindow) {
    return { eventName: "m18.evv.visit_verified", effects: [] };
  }
  await enqueueFamilyRecompute(
    event,
    ["hvldl"],
    `m18.evv.visit_verified — HVLDL recompute (death within ±${windowDays}d of visit ${event.visitId})`,
    ports,
  );
  return { eventName: "m18.evv.visit_verified", effects: ["hvldl_near_death_recompute"] };
}

/** Shared family-recompute fan-out: resolve the codes, enqueue the debounced request. */
async function enqueueFamilyRecompute(
  event: { eventId: string; organizationId: string; providerEntityId: string },
  families: readonly MeasureFamily[],
  reason: string,
  ports: M30ConsumerPorts,
): Promise<void> {
  await ports.enqueueRecompute({
    organizationId: event.organizationId,
    providerEntityId: event.providerEntityId,
    families,
    measureCodes: measureCodesForFamilies(families),
    reason,
    triggeringEventId: event.eventId,
  });
}

/** The §4.10 effect kinds present in the subscription map for a topic (the dispatcher's routing hint). */
export function effectKindsForTopic(topic: string): readonly M30SubscriptionEffect["kind"][] {
  return effectsForTopic(topic).map((effect) => effect.kind);
}
