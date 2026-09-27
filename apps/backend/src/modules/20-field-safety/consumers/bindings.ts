// apps/backend/src/modules/20-field-safety/consumers/bindings.ts — the live `OutboxConsumerBinding`s for
// M20's §4.8 visit consumers (F-043 / #103).
//
// WHAT WAS MISSING. The four deciders beside this file — `planVisitCadence`, `decideVisitReassigned`,
// `decideVisitCompleted`, `decideVisitNoShow`, `decideEvvCheckIn`, `decideEvvCheckOut` — were complete,
// unit-tested, exported from `./index`, and called by NOTHING but `field-safety-consumers.test.ts`. There
// was no factory yielding a binding, so `check-outbox-bindings.ts` found no live consumer for m20 and the
// dispatcher marked every one of M20's declared events `deferred`: the row finalizes `pending` with
// `attemptCount - 1`, never dead-letters, and is re-claimed every thirty minutes forever.
//
// The visible cost was one layer down and larger than a stuck row. `safety_check_in_schedule` had no
// INSERT anywhere in the repository (`./schedule-store`), so the §4.2 supervisor board, the §4.3 badge
// trio, the §4.8 overdue detector and the clinician's own `/me/today` have always read an empty set — the
// board answered "nobody is overdue" because nobody was ever OBLIGED, which is indistinguishable from
// everyone being fine and is exactly the reading a safety surface must never invite.
//
// ── THE SEAM READ CANNOT USE `./seam-context`'s HELPER, AND THE REASON IS THE POINT ──────────────────
//
// `readVisitAnchors` was written for these consumers and returns `null` on BOTH "no such visit" and "the
// seam threw", deliberately, so the §4.2 board cannot leak whether another tenant's visit exists. From a
// CONSUMER those two must not collapse: a delivery that silently materializes nothing because M17 was
// briefly unavailable is a safety obligation that never existed and never will, and the outbox's whole
// retry machinery is built to make that case recoverable. So the bindings read the seam directly, treat
// `null` as "the visit is gone — nothing to do" and let a throw fail the delivery.
//
// M17's `SchedulingSeamStore` opens `withOrgContextFromRequest`, which THROWS outside a request scope, and
// `binding.handle` is called by the relay with no ambient context at all. A binding that simply called the
// seam would therefore have caught that throw in `readVisitAnchors` and no-op'd on every single delivery —
// working code, green tests, nothing written, forever. Each handler establishes the scope itself with
// `runWithRequestContext` before any seam call.
//
// ── ATTRIBUTION ──────────────────────────────────────────────────────────────────────────────────────
//
// `userId` is empty, the dispatcher's own convention (`DISPATCHER_USER_ID`): §3.3's attribution rule says
// a system transition records no actor, and a materialization triggered by a visit publishing at 06:00 is
// nobody's act. The M4 write-audit triggers record the row writes either way.
//
// ── WHY THE EFFECTS STILL GO THROUGH THE RUNNER ──────────────────────────────────────────────────────
//
// Five of the six decisions declare only `withAudit([])`, which the runner no-ops (its rule 3 — the M4
// trigger owns the audit row), so running them looks like ceremony. It is not: the runner's rules 1 and 5
// are what stop a decider that later declares an outbox event or a new effect kind from having it silently
// dropped by a consumer that only knew about mutations. `decideVisitNoShow` already declares two, and they
// are the §4.9 warn-severity supervisor inquiry — the one thing this whole surface exists to raise.
import type { DbClient } from "@wardenx/db";
import { runWithRequestContext, withOrgContext } from "@wardenx/tenancy";
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  SafetyPolicyEffectiveDto,
  VisitId,
} from "@wardenx/types";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { type EffectPatch, runEffects } from "../routes/effects-runner";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";
import { getVisitReader } from "../seams/consumed";
import { decideVisitNoShow } from "./m17-no-show";
import { decideVisitCompleted, decideVisitReassigned, planVisitCadence } from "./m17-visit-cadence";
import { decideEvvCheckIn, decideEvvCheckOut } from "./m18-evv-brackets";
import type { SafetyClinicianSignalCache } from "./m18-gps-spoof";
import { buildSosDeliveryFailureConsumer } from "./m36-delivery-failed";
import type { SafetyConsumerDecision, SafetyVisitAnchors } from "./schedule-plan";
import {
  applyScheduleMutations,
  ensurePolicyVersionForConsumer,
  scheduleRowsForVisit,
} from "./schedule-store";
import { visitAnchorsFrom } from "./seam-context";

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** What the live M20 visit consumers need. */
export interface FieldSafetyConsumerDeps {
  readonly db: DbClient;
  /** M20's own §4.3 policy provider — the ONLY read path to the effective thresholds (§2.2.4). */
  readonly policy: {
    effectivePolicy(orgId: OrgId, asOfIso?: IsoInstant): Promise<SafetyPolicyEffectiveDto>;
  };
  readonly outbox: WriteOutboxPort;
  /** §4.9 — best-effort by construction; absent means the board is the only surfacing. */
  readonly alerts?: AlertPort;
  /** §7.7 — the process-local spoof-badge cache the supervisor board reads. */
  readonly signals?: SafetyClinicianSignalCache;
  readonly now?: () => Date;
}

function recordOf(consumer: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${consumer}: payload must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(consumer: string, payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${consumer}: '${key}' must be a non-empty string`);
  }
  return value;
}

function instantOf(consumer: string, payload: Record<string, unknown>, key: string): IsoInstant {
  const value = stringOf(consumer, payload, key);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${consumer}: '${key}' is not an instant — '${value}'`);
  }
  return value as IsoInstant;
}

/**
 * The visit behind an M17/M18 trigger, or `null` when it no longer exists.
 *
 * A seam FAILURE propagates (see the header): the delivery fails, the row retries, and the obligation is
 * eventually materialized rather than silently skipped.
 */
async function readAnchors(
  organizationId: OrgId,
  visitId: VisitId,
): Promise<SafetyVisitAnchors | null> {
  const visit = await getVisitReader().visitForEncounter(organizationId, visitId);
  return visit === null ? null : visitAnchorsFrom(visit);
}

/** A decision's effect list may not carry a column patch — every consumer write NAMES its row. */
function assertNoUnroutedPatch(consumer: string, patch: EffectPatch): void {
  const keys = Object.keys(patch);
  if (keys.length > 0) {
    throw new Error(
      `${consumer}: decision declared column effect(s) [${keys.join(", ")}] with no row to apply them to; a consumer mutation must name its target schedule`,
    );
  }
}

/** What a decider hands back beside its decision: the outbox/alert envelope its effects need. */
interface DecisionEnvelope {
  readonly decision: SafetyConsumerDecision;
  /** The aggregate the emitted event is about. Defaults to the visit — a materialization is about the
   *  visit, not about any one of the three rows it made. */
  readonly aggregateId?: string;
  readonly payloads?: Record<string, Record<string, unknown>>;
  readonly alertPayloads?: Record<string, Record<string, unknown>>;
}

/**
 * Run one decision: apply its row mutations, then its effects, in one transaction.
 *
 * The decider runs INSIDE the transaction because every one of them reads the visit's current obligations
 * first — deciding against rows read outside it would let a concurrent delivery of the same event
 * materialize between the read and the write.
 */
async function commitDecision(
  deps: FieldSafetyConsumerDeps,
  consumer: string,
  ctx: {
    readonly organizationId: OrgId;
    readonly anchors: SafetyVisitAnchors;
    readonly at: Date;
  },
  decide: (tx: DbClient) => Promise<DecisionEnvelope>,
): Promise<void> {
  await withOrgContext(
    deps.db,
    { organizationId: ctx.organizationId, userId: CONSUMER_USER_ID },
    async (handle) => {
      const tx = handle as DbClient;
      const envelope = await decide(tx);
      await applyScheduleMutations(tx, ctx.organizationId, envelope.decision.mutations, ctx.at);
      const patch = await runEffects(tx, envelope.decision.effects, {
        organizationId: ctx.organizationId,
        providerEntityId: ctx.anchors.providerEntityId,
        locationId: ctx.anchors.locationId,
        // A check-in-schedule transition hangs off no SOS alert; the runner only reads this for the
        // `sos_state_history` effect, which none of these decisions declares.
        sosAlertId: "",
        at: ctx.at,
        actorMembershipId: null,
        reason: null,
        outbox: deps.outbox,
        ...(deps.alerts ? { alerts: deps.alerts } : {}),
        aggregateKind: "safety_check_in_schedule",
        aggregateId: envelope.aggregateId ?? ctx.anchors.visitId,
        payloads: (envelope.payloads ?? {}) as never,
        ...(envelope.alertPayloads ? { alertPayloads: envelope.alertPayloads } : {}),
      });
      assertNoUnroutedPatch(consumer, patch);
    },
  );
}

/**
 * The live M20 visit bindings (§4.8).
 *
 * Seven events, six deciders and one cache. Each handler resolves its own tenancy scope, reads the visit
 * back through M17's seam (never from the payload — an `m17.visit.*` trigger carries no
 * `provider_entity_id` or `location_id`, and every `safety_check_in_schedule` row needs both NOT NULL) and
 * commits its decision in one transaction.
 */
export function buildFieldSafetyConsumers(
  deps: FieldSafetyConsumerDeps,
): readonly OutboxConsumerBinding[] {
  const clock = deps.now ?? (() => new Date());

  /** The shared shape: resolve scope + anchors + policy, then decide and commit. */
  const visitConsumer = (
    consumerName: string,
    eventType: string,
    decideFor: (input: {
      readonly tx: DbClient;
      readonly organizationId: OrgId;
      readonly anchors: SafetyVisitAnchors;
      readonly policy: SafetyPolicyEffectiveDto;
      readonly payload: Record<string, unknown>;
      readonly at: Date;
    }) => Promise<DecisionEnvelope>,
  ): OutboxConsumerBinding => ({
    consumerName,
    consumerModule: "m20",
    eventTypes: [eventType],
    async handle(event) {
      const payload = recordOf(consumerName, event.payload);
      const organizationId = event.organizationId as OrgId;
      const visitId = stringOf(consumerName, payload, "visitId") as VisitId;
      const at = clock();

      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
        const anchors = await readAnchors(organizationId, visitId);
        // The visit is gone (cancelled and purged). Nothing to oblige — and NOT an error: a delivery
        // that outlives its subject is the ordinary tail of an at-least-once queue.
        if (anchors === null) return;
        const policy = await deps.policy.effectivePolicy(
          organizationId,
          at.toISOString() as IsoInstant,
        );
        await commitDecision(deps, consumerName, { organizationId, anchors, at }, (tx) =>
          decideFor({ tx, organizationId, anchors, policy, payload, at }),
        );
      });
    },
  });

  return [
    // §4.8 `m20.materialize-cadence.consumer` / §7.1 — the pre/mid/post obligations a published visit owes.
    // THE ONLY PRODUCER of `safety_check_in_schedule` rows on the platform.
    visitConsumer(
      "m20.materialize-cadence",
      "m17.visit.published",
      async ({ tx, organizationId, anchors, policy, at }) => {
        const policyVersionId = await ensurePolicyVersionForConsumer(tx, organizationId, at);
        const existing = await scheduleRowsForVisit(tx, organizationId, anchors.visitId);
        return {
          decision: planVisitCadence({ visit: anchors, policy, policyVersionId, existing }),
        };
      },
    ),

    // §2.2.1 — the visit changed hands; re-point the obligations the new clinician now owes. The NEW
    // clinician is read from the anchors, not from the payload: `m17.visit.assigned` carries
    // `assignedMembershipId`, and the two agree, but a re-point that trusts the payload would write a
    // name the visit row does not have if the events ever arrive out of order.
    visitConsumer(
      "m20.repoint-cadence",
      "m17.visit.assigned",
      async ({ tx, organizationId, anchors }) => ({
        decision: decideVisitReassigned({
          newClinicianMembershipId: anchors.clinicianMembershipId as MembershipId,
          existing: await scheduleRowsForVisit(tx, organizationId, anchors.visitId),
        }),
      }),
    ),

    // Retire the mid-visit prompts a short visit outran. The pre- and post-visit obligations survive on
    // purpose (`./m17-visit-cadence`).
    visitConsumer(
      "m20.retire-cadence",
      "m17.visit.completed",
      async ({ tx, organizationId, anchors, payload }) => ({
        decision: decideVisitCompleted({
          completedAt: instantOf("m20.retire-cadence", payload, "completedAt"),
          existing: await scheduleRowsForVisit(tx, organizationId, anchors.visitId),
        }),
      }),
    ),

    // §4.8 `m20.no-show.consumer` — the warn-severity supervisor inquiry, bounded by what M20 can say.
    // The ONE decision in this file that emits: the anchor obligation becomes the `check_in_overdue`
    // event and alert, and the others are retired so a visit that never happened cannot walk the D4
    // ladder at a clinician who is demonstrably fine.
    visitConsumer(
      "m20.no-show",
      "m17.visit.no_show_detected",
      async ({ tx, organizationId, anchors, payload, at }) => {
        const decision = decideVisitNoShow({
          detectedAt: instantOf("m20.no-show", payload, "scheduledStartedAt"),
          existing: await scheduleRowsForVisit(tx, organizationId, anchors.visitId),
        });
        if (decision.inquiry === null) return { decision };
        const body = {
          orgId: organizationId,
          providerEntityId: anchors.providerEntityId,
          occurredAt: at.toISOString(),
          scheduleId: decision.inquiry.scheduleId,
          clinicianMembershipId: anchors.clinicianMembershipId,
          visitId: anchors.visitId,
          kind: decision.inquiry.kind,
          expectedAt: decision.inquiry.expectedAt,
          minutesOverdue: decision.inquiry.minutesOverdue,
        };
        return {
          decision,
          aggregateId: decision.inquiry.scheduleId,
          payloads: { "m20.safety.check_in_overdue": body },
          alertPayloads: { "m20.safety.check_in_overdue": body },
        };
      },
    ),

    // §7.1 — the arrival re-anchors the mid-visit cadence. See `./m18-evv-brackets` on why the check-in
    // does NOT close an unanswered pre-visit obligation.
    visitConsumer(
      "m20.evv-check-in",
      "m18.evv.check_in_recorded",
      async ({ tx, organizationId, anchors, payload }) => ({
        decision: decideEvvCheckIn({
          visit: anchors,
          checkedInAt: instantOf("m20.evv-check-in", payload, "capturedAt"),
          existing: await scheduleRowsForVisit(tx, organizationId, anchors.visitId),
        }),
      }),
    ),

    // §7.1 — the check-out opens the post-visit window, materializing it if the visit predates M20's
    // cadence materializer (a tenant that enables field safety mid-week).
    visitConsumer(
      "m20.evv-check-out",
      "m18.evv.check_out_recorded",
      async ({ tx, organizationId, anchors, policy, payload, at }) => {
        const policyVersionId = await ensurePolicyVersionForConsumer(tx, organizationId, at);
        return {
          decision: decideEvvCheckOut({
            visit: anchors,
            checkedOutAt: instantOf("m20.evv-check-out", payload, "capturedAt"),
            policy,
            policyVersionId,
            existing: await scheduleRowsForVisit(tx, organizationId, anchors.visitId),
          }),
        };
      },
    ),

    // §7.7 — the twelve-hour defensive badge. No row, no transaction and no seam read: the cache is
    // process-local by specification (M20 owns thirteen tables and none of them is a second system of
    // record for a judgement M18 already keeps). In a split `WORKER_MODE` deployment the badge is
    // recorded in the worker and the board is served from the api process, so it renders only in a
    // single-process boot — a MISSING caveat, never a missing alert, which is the degradation this
    // signal is specified to tolerate.
    {
      consumerName: "m20.gps-spoof-badge",
      consumerModule: "m20",
      eventTypes: ["m18.evv.gps_spoof_suspected"],
      async handle(event) {
        if (!deps.signals) return;
        const payload = recordOf("m20.gps-spoof-badge", event.payload);
        deps.signals.recordGpsSpoofSuspected(
          event.organizationId as OrgId,
          stringOf("m20.gps-spoof-badge", payload, "postingMembershipId") as MembershipId,
          instantOf("m20.gps-spoof-badge", payload, "capturedAt"),
        );
      },
    },

    // §4.8 M36 delivery-failure trigger (#205 follow-up) — a page that never reached the on-call
    // responder for an open SOS alert. See ./m36-delivery-failed's header for why it does not reuse
    // `visitConsumer` (no visit anchor at all) and why `escalation_tier_3` dead-letters rather than
    // completing a transition into `emergency_terminus`. NO PRODUCER EXISTS YET (events-by-m36.ts).
    buildSosDeliveryFailureConsumer({
      db: deps.db,
      outbox: deps.outbox,
      ...(deps.alerts ? { alerts: deps.alerts } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
  ];
}
