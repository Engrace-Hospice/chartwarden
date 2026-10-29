// apps/backend/src/modules/19-oncall/consumers/bindings.ts — the live `OutboxConsumerBinding`s for M19's
// two D10 inbound triggers (F-043 / #103), plus the §4.8 M36 delivery-failure trigger (#205 M36 follow-up).
//
// WHAT WAS MISSING, AND WHAT IT COST. `./m17-no-show` and `./m18-late-checkout` are complete deciders over
// the shared `./inbound-trigger` core, and `./trigger-context` resolves their facts. No factory anywhere
// yielded a binding, so their only callers were `oncall-consumers.test.ts` and, for the no-show path, an
// error-message reference. `check-outbox-bindings.ts` therefore found no live consumer for m19 and the
// relay deferred both triggers forever.
//
// The consequence is not a stuck row. `triage_call.source` has six enum values and the module's two live
// insert paths (`routes/write-service-drizzle.ts`) hardcode `manual` and `paper_origin` — so `no_show`,
// `late_checkout`, `m36_delivery_failure` and `geofence_anomaly` were unreachable, and
// `source_outbox_event_id`, the column the D10 redelivery guard `triage_call_source_dedupe_uq` is built
// on, had never been written by anything. **No proactive triage call had ever been opened.** A clinician
// who never arrived at a dying patient's home, and one who never checked out of it, each raised an event
// that the relay re-claimed every thirty minutes and delivered to nobody.
//
// This also gives `m19.oncall_shift.coverage_gap` its first producer — `events-by-m19.ts`'s header used
// to record it as declared in `M19_EVENT_NAMES` but never actually published anywhere in this codebase;
// updated there now that this file is the producer.
//
// ── TENANCY: THE SCOPE IS ESTABLISHED HERE, NOT INHERITED ────────────────────────────────────────────
//
// `binding.handle` is called by the relay with no ambient request context, and `readTriggerVisit` reaches
// M17's `VisitReader`, whose Drizzle store opens `withOrgContextFromRequest` and THROWS outside a request
// scope. `readTriggerVisit` catches that into `null`, deliberately — the §4.2-style rule that a consumer
// must not learn whether another tenant's visit exists — so a binding that did not establish the scope
// would resolve every visit to null and every delivery would dead-letter as `TRIGGER_VISIT_UNRESOLVED`:
// loud, but wrong, and wrong in a way that looks like an upstream data problem. Each handler opens
// `runWithRequestContext` first, exactly as M20's do (#204).
//
// ── THE FOUR OUTCOMES ARE THE DECIDER'S, AND NONE OF THEM IS A THROW ────────────────────────────────
//
// `idempotent_skip` and `coalesced` write nothing. `open_call` writes the row and runs the §2.4 effects.
// `no_coverage` publishes the coverage gap INSTEAD of a call, because `triage_call.on_call_shift_id` is
// NOT NULL and throwing would park a patient welfare check in a DLQ where nobody clinical will see it.
// Only `TRIGGER_VISIT_UNRESOLVED` / `TRIGGER_ORG_MISMATCH` throw, and both are meant to: they dead-letter
// rather than write a row anchored to a guess.
//
// ── THE M36 DELIVERY-FAILURE TRIGGER IS A FIFTH OUTCOME SET, NOT A REUSE OF THE ABOVE ──────────────────
//
// `./m36-delivery-failed`'s own header explains why it does not reuse `decideInboundTrigger`: a delivery
// failure describes a MESSAGE, not a visit, and its `escalate_existing` outcome is genuinely new — it is
// NOT a `triage_call.state` transition (M19's state machine only legalizes `escalateUnresolved` from
// `disposition_pending`, one of the six states an already-open call can be in). It maps instead onto
// `triage_escalation`, the module's separate append-only escalation ladder: `sla_breach` is already one
// of its four trigger kinds ("the §4.8 callback detector's", `packages/db/src/schema/oncall/
// triage-escalations.ts`), and the decider's own header names exactly this ("escalate the EXISTING call
// one rung (`sla_breach` trigger kind, tier 1)"). The recipient is resolved off the SAME covering-shift
// read the `open_operational_call` path already uses — "tier 1" in this module IS whoever is on-call.
import { type DbClient, schema } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, OrgId, ProviderEntityId, TriageCallId } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildCaseOpenedAlert, buildCoverageGapAlert } from "../alerts";
import { assertRecipientCoherent } from "../lifecycle/escalation";
import { openCallEffects } from "../lifecycle/triage-call";
import { type StateHistoryPort, runEffects } from "../routes/effects-runner";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";
import type { InboundTriggerAction, MachineOpenedCallDraft } from "./inbound-trigger";
import { resolveCoveringShift } from "./inbound-trigger";
import { decideNoShowTrigger } from "./m17-no-show";
import { decideLateCheckoutTrigger } from "./m18-late-checkout";
import {
  type DeliveryFailureAction,
  type DeliveryFailureFacts,
  type M36DeliveryFailedPayload,
  decideDeliveryFailureTrigger,
} from "./m36-delivery-failed";
import type { DeliveryFailureTriggerPorts, InboundTriggerPorts } from "./trigger-context";
import { resolveInboundTriggerFacts } from "./trigger-context";

const CALL = schema.triageCall;
const HISTORY = schema.triageCallStateHistory;
const ESCALATION = schema.triageEscalation;

/** §3.3 — a machine-opened call names no acting membership. */
export const CONSUMER_USER_ID = "";

export interface OncallTriggerConsumerDeps {
  readonly db: DbClient;
  readonly ports: InboundTriggerPorts;
  /** §4.8 M36 delivery-failure trigger's one extra read. */
  readonly deliveryPorts: DeliveryFailureTriggerPorts;
  readonly outbox: WriteOutboxPort;
  /** §4.9 — best-effort by construction; absent means the board is the only surfacing. */
  readonly alerts?: AlertPort;
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

/**
 * The §2.4 state-history writer, the one child row the effects runner owns.
 *
 * A copy of the write service's rather than a shared export: `routes/write-service-drizzle.ts` builds it
 * inside a closure over its own table constants, and lifting it out is a refactor of the production write
 * path that this change has no reason to make.
 */
export function stateHistoryPort(): StateHistoryPort {
  return {
    async insert(tx, row) {
      await (tx as DbClient).insert(HISTORY).values({
        organizationId: row.organizationId,
        providerEntityId: row.providerEntityId,
        locationId: row.locationId,
        triageCallId: row.triageCallId,
        fromState: row.fromState as never,
        toState: row.toState as never,
        transitionedAt: row.transitionedAt,
        actorMembershipId: row.actorMembershipId,
        systemActor: row.systemActor,
        ...(row.autoTimeout ? { autoTimeout: true } : {}),
        commandPayloadDigest: row.commandPayloadDigest,
      });
    },
  };
}

/** Insert the machine-opened call and run its §2.4 effects, in one transaction. */
export async function openMachineCall(
  deps: OncallTriggerConsumerDeps,
  draft: Omit<MachineOpenedCallDraft, "admissionId"> & {
    readonly admissionId: MachineOpenedCallDraft["admissionId"] | null;
  },
  at: Date,
  /** Runs in the SAME transaction as the insert, only when this delivery created the row. */
  alongside?: (tx: DbClient, callId: TriageCallId) => Promise<void>,
): Promise<void> {
  await withOrgContext(
    deps.db,
    { organizationId: draft.organizationId, userId: CONSUMER_USER_ID },
    async (handle) => {
      const tx = handle as DbClient;
      const [row] = await tx
        .insert(CALL)
        .values({
          organizationId: draft.organizationId,
          providerEntityId: draft.providerEntityId,
          locationId: draft.locationId,
          onCallShiftId: draft.onCallShiftId,
          patientId: draft.patientId,
          admissionId: draft.admissionId,
          callerKind: draft.callerKind as never,
          inboundChannel: draft.inboundChannel as never,
          source: draft.source as never,
          sourceOutboxEventId: draft.sourceOutboxEventId,
          chiefComplaintText: draft.chiefComplaintText,
          openedAt: new Date(draft.openedAt),
        })
        // §2.6 / D10 — `triage_call_source_dedupe_uq` is the redelivery guard, and this is what makes a
        // race between two deliveries of one event a no-op rather than a driver-level unique violation
        // inside the relay's retry loop. `findCallBySourceEvent` already covers the ordinary redelivery;
        // this covers the interleaving the read cannot see.
        .onConflictDoNothing()
        .returning();
      if (!row) return;
      const call = row as typeof CALL.$inferSelect;

      // `machineOpened: true` — so no `first_response_at` stamp: nobody has responded yet. That is the
      // whole point of the flag, and it is why the patch below is expected to be empty.
      const patch = await runEffects(
        tx,
        openCallEffects({ machineOpened: true, at: draft.openedAt }),
        {
          organizationId: call.organizationId,
          providerEntityId: call.providerEntityId,
          locationId: call.locationId,
          triageCallId: call.id,
          at,
          actorMembershipId: null,
          commandPayloadDigest: null,
          outbox: deps.outbox,
          ...(deps.alerts ? { alerts: deps.alerts } : {}),
          stateHistory: stateHistoryPort(),
          aggregateKind: "triage_call",
          aggregateId: call.id,
          payloads: {
            "m19.triage_call.opened": {
              orgId: call.organizationId,
              providerEntityId: call.providerEntityId,
              triageCallId: call.id,
              occurredAt: draft.openedAt,
              onCallShiftId: call.onCallShiftId,
              source: call.source,
              patientId: call.patientId,
              paperOrigin: false,
              originalOpenedAt: null,
            },
          },
          alertPayloads: {
            "m19.triage.case_opened": buildCaseOpenedAlert({
              orgId: draft.organizationId,
              providerEntityId: draft.providerEntityId,
              triageCallId: call.id as never,
              source: call.source as never,
              openedAt: draft.openedAt,
            }) as unknown as Record<string, unknown>,
          },
        },
      );
      if (Object.keys(patch).length > 0) {
        throw new Error(
          `m19 inbound trigger: a machine-opened call declared column effect(s) [${Object.keys(patch).join(", ")}]; a machine open has no responder and must set none`,
        );
      }
      await alongside?.(tx, call.id as TriageCallId);
    },
  );
}

/**
 * Publish the §4.10 coverage gap and its §4.9 `critical` page.
 *
 * NOT through `runEffects`: its `EffectContext` is call-scoped (`triageCallId` is required, and the
 * `sos_state_history`-equivalent child row hangs off a call) and the whole point of this arm is that no
 * call exists. The alert is emitted OUTSIDE the transaction and best-effort, the runner's own rule 4 — a
 * coverage gap must be recorded even if M36 is down, and §2.7 D-D's status-endpoint fallback is the
 * designed answer to that outage.
 */
export async function publishCoverageGap(
  deps: OncallTriggerConsumerDeps,
  gap: {
    readonly organizationId: OrgId;
    readonly providerEntityId: string;
    readonly gapStartsAt: IsoInstant;
    readonly gapEndsAt: IsoInstant;
    readonly discipline: "clinical_rn";
  },
  /** Runs in the SAME transaction as the gap event. */
  alongside?: (tx: DbClient) => Promise<void>,
): Promise<void> {
  await withOrgContext(
    deps.db,
    { organizationId: gap.organizationId, userId: CONSUMER_USER_ID },
    async (tx) => {
      await deps.outbox.publish(tx, {
        eventName: "m19.oncall_shift.coverage_gap",
        organizationId: gap.organizationId,
        aggregateKind: "on_call_shift",
        // No shift exists — that IS the finding. The ProviderEntity is the aggregate the gap is about.
        aggregateId: gap.providerEntityId,
        payload: {
          organizationId: gap.organizationId,
          providerEntityId: gap.providerEntityId,
          gapStartsAt: gap.gapStartsAt,
          gapEndsAt: gap.gapEndsAt,
          discipline: gap.discipline,
        },
      });
      await alongside?.(tx as DbClient);
    },
  );
  await deps.alerts
    ?.emit({
      organizationId: gap.organizationId,
      kind: "m19.oncall.coverage_gap_detected",
      payload: buildCoverageGapAlert({
        orgId: gap.organizationId,
        providerEntityId: gap.providerEntityId as never,
        gapStartsAt: gap.gapStartsAt,
        gapEndsAt: gap.gapEndsAt,
        discipline: gap.discipline,
      }) as unknown as Record<string, unknown>,
    })
    .catch(() => undefined);
}

// ── §4.8 M36 delivery-failure trigger ───────────────────────────────────────────────────────────────────

/** Resolve the {@link DeliveryFailureFacts} the decider needs, short-circuiting the same way
 *  `resolveInboundTriggerFacts` does: a redelivery costs nothing beyond the dedupe check. */
async function resolveDeliveryFailureFacts(input: {
  readonly organizationId: OrgId;
  readonly sourceOutboxEventId: string;
  readonly payload: M36DeliveryFailedPayload;
  readonly at: IsoInstant;
  readonly ports: InboundTriggerPorts;
  readonly deliveryPorts: DeliveryFailureTriggerPorts;
}): Promise<DeliveryFailureFacts> {
  const existingCallForEventId = await input.ports.findCallBySourceEvent(
    input.organizationId,
    input.sourceOutboxEventId,
  );
  if (existingCallForEventId !== null) {
    return { existingCallForEventId, namedCallIsOpen: false, candidateShifts: [] };
  }

  const namedCallIsOpen =
    input.payload.triageCallId !== null
      ? await input.deliveryPorts.isCallOpen(input.organizationId, input.payload.triageCallId)
      : false;

  // Shifts are read for BOTH the open_operational_call path AND escalate_existing's recipient
  // resolution (below) — never for the ignore/idempotent_skip/escalate branches that don't reach here.
  const candidateShifts =
    input.payload.providerEntityId !== null
      ? await input.ports.candidateShiftsForProviderEntity(
          input.organizationId,
          input.payload.providerEntityId,
          input.at,
        )
      : [];

  return { existingCallForEventId: null, namedCallIsOpen, candidateShifts };
}

/** `open_operational_call` — the PATIENT-LESS worklist row (§4.8; `openMachineCall`'s sibling, not a
 *  reuse: `MachineOpenedCallDraft` requires `patientId`/`admissionId`, which an operational call has
 *  neither of). */
async function openOperationalCall(
  deps: OncallTriggerConsumerDeps,
  draft: {
    readonly organizationId: OrgId;
    readonly providerEntityId: ProviderEntityId;
    readonly onCallShiftId: string;
    readonly callerKind: "system_inbound";
    readonly inboundChannel: "inbound_alert_failure";
    readonly source: "m36_delivery_failure";
    readonly sourceOutboxEventId: string;
    readonly chiefComplaintText: string;
    readonly openedAt: IsoInstant;
  },
  at: Date,
): Promise<void> {
  await withOrgContext(
    deps.db,
    { organizationId: draft.organizationId, userId: CONSUMER_USER_ID },
    async (handle) => {
      const tx = handle as DbClient;
      const [row] = await tx
        .insert(CALL)
        .values({
          organizationId: draft.organizationId,
          providerEntityId: draft.providerEntityId,
          locationId: null,
          onCallShiftId: draft.onCallShiftId,
          patientId: null,
          admissionId: null,
          callerKind: draft.callerKind as never,
          inboundChannel: draft.inboundChannel as never,
          source: draft.source as never,
          sourceOutboxEventId: draft.sourceOutboxEventId,
          chiefComplaintText: draft.chiefComplaintText,
          openedAt: new Date(draft.openedAt),
        })
        // Same D10 redelivery guard as `openMachineCall` — a race between two deliveries of one event
        // is a no-op, not a driver-level unique violation inside the relay's retry loop.
        .onConflictDoNothing()
        .returning();
      if (!row) return;
      const call = row as typeof CALL.$inferSelect;

      const patch = await runEffects(
        tx,
        openCallEffects({ machineOpened: true, at: draft.openedAt }),
        {
          organizationId: call.organizationId,
          providerEntityId: call.providerEntityId,
          locationId: call.locationId,
          triageCallId: call.id,
          at,
          actorMembershipId: null,
          commandPayloadDigest: null,
          outbox: deps.outbox,
          ...(deps.alerts ? { alerts: deps.alerts } : {}),
          stateHistory: stateHistoryPort(),
          aggregateKind: "triage_call",
          aggregateId: call.id,
          payloads: {
            "m19.triage_call.opened": {
              orgId: call.organizationId,
              providerEntityId: call.providerEntityId,
              triageCallId: call.id,
              occurredAt: draft.openedAt,
              onCallShiftId: call.onCallShiftId,
              source: call.source,
              patientId: null,
              paperOrigin: false,
              originalOpenedAt: null,
            },
          },
          alertPayloads: {
            "m19.triage.case_opened": buildCaseOpenedAlert({
              orgId: draft.organizationId,
              providerEntityId: draft.providerEntityId,
              triageCallId: call.id as never,
              source: call.source as never,
              openedAt: draft.openedAt,
            }) as unknown as Record<string, unknown>,
          },
        },
      );
      if (Object.keys(patch).length > 0) {
        throw new Error(
          `m19 delivery-failure trigger: an operational call declared column effect(s) [${Object.keys(patch).join(", ")}]; an operational call has no responder and must set none`,
        );
      }
    },
  );
}

/**
 * `escalate_existing` — a NEW `triage_escalation` row at `sla_breach` (never a `triage_call.state`
 * transition; see this file's header). Reads the call's own tenancy anchor rather than trusting the
 * payload's `providerEntityId` (which describes the notification's target, not necessarily the call's own
 * row — a stale or cross-anchored payload must not steer an insert onto the wrong ProviderEntity/location).
 * Throws (dead-letters) when no covering shift can be found: `escalated_to_membership_id` is NOT NULL, and
 * inventing a recipient is worse than a human reviewing the DLQ.
 */
async function escalateExistingCall(
  deps: OncallTriggerConsumerDeps,
  organizationId: OrgId,
  triageCallId: TriageCallId,
  at: Date,
  atIso: IsoInstant,
): Promise<void> {
  // ONE org-scoped transaction for the read, the shift lookup and the insert — the bare-pool read this
  // file's own header warns about (a busy connection throws 22P02, an idle one silently matches nothing).
  await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (handle) => {
    const tx = handle as DbClient;
    const [call] = await tx
      .select({
        id: CALL.id,
        organizationId: CALL.organizationId,
        providerEntityId: CALL.providerEntityId,
        locationId: CALL.locationId,
      })
      .from(CALL)
      .where(and(eq(CALL.id, triageCallId), eq(CALL.organizationId, organizationId)))
      .limit(1);
    if (!call) return; // §2.6 — the call closed/vanished between decide and apply; nothing to escalate.

    const shifts = await deps.ports.candidateShiftsForProviderEntity(
      organizationId,
      call.providerEntityId,
      atIso,
    );
    const shift = resolveCoveringShift(shifts, atIso);
    if (shift === null || shift.primaryOnCallMembershipId === null) {
      throw new Error(
        `m19 delivery-failure trigger: triage_call ${triageCallId} has no resolvable on-call recipient to escalate to`,
      );
    }

    assertRecipientCoherent({
      tier: "tier_1_rn_supervisor",
      escalatedToMembershipId: shift.primaryOnCallMembershipId,
      escalatedToExternalActorId: null,
    });

    await tx.insert(ESCALATION).values({
      organizationId: call.organizationId,
      providerEntityId: call.providerEntityId,
      locationId: call.locationId,
      triageCallId: call.id,
      tier: "tier_1_rn_supervisor",
      triggerKind: "sla_breach",
      triggerDetail: "m36.notification.delivery_failed",
      escalatedToMembershipId: shift.primaryOnCallMembershipId,
      escalatedAt: at,
    });
  });
}

/** Execute whichever of the five outcomes the delivery-failure decider chose. */
async function applyDeliveryFailureAction(
  deps: OncallTriggerConsumerDeps,
  organizationId: OrgId,
  action: DeliveryFailureAction,
  at: Date,
  atIso: IsoInstant,
): Promise<void> {
  switch (action.kind) {
    case "ignore":
    case "idempotent_skip":
      return;
    case "escalate_existing":
      return escalateExistingCall(deps, organizationId, action.triageCallId, at, atIso);
    case "open_operational_call":
      return openOperationalCall(deps, action.draft, at);
    case "no_coverage":
      return publishCoverageGap(deps, action.gap);
  }
}

/** Execute whichever of the four outcomes the decider chose. */
async function applyAction(
  deps: OncallTriggerConsumerDeps,
  action: InboundTriggerAction,
  at: Date,
): Promise<void> {
  switch (action.kind) {
    case "idempotent_skip":
    case "coalesced":
      // Both write nothing on purpose (§2.6). The relay's receipt is what records that the delivery
      // happened; a second row or a second page would be the defect each arm exists to prevent.
      return;
    case "open_call":
      return openMachineCall(deps, action.draft, at);
    case "no_coverage":
      return publishCoverageGap(deps, action.gap);
  }
}

/**
 * The live M19 D10 inbound-trigger bindings (§4.8 / §7.6).
 *
 * Two events, one shared pipeline: establish the tenancy scope, resolve the facts through
 * `resolveInboundTriggerFacts`, let the module's own decider choose one of four outcomes, and execute it.
 */
export function buildOncallTriggerConsumers(
  deps: OncallTriggerConsumerDeps,
): readonly OutboxConsumerBinding[] {
  const clock = deps.now ?? (() => new Date());

  const trigger = (
    consumerName: string,
    eventType: string,
    decide: (input: {
      readonly organizationId: OrgId;
      readonly sourceOutboxEventId: string;
      readonly payload: Record<string, unknown>;
      readonly facts: Awaited<ReturnType<typeof resolveInboundTriggerFacts>>;
      readonly at: IsoInstant;
    }) => InboundTriggerAction,
  ): OutboxConsumerBinding => ({
    consumerName,
    consumerModule: "m19",
    eventTypes: [eventType],
    async handle(event) {
      const payload = recordOf(consumerName, event.payload);
      const organizationId = event.organizationId as OrgId;
      const visitId = stringOf(consumerName, payload, "visitId");
      const at = clock();
      const atIso = at.toISOString() as IsoInstant;

      await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
        const facts = await resolveInboundTriggerFacts({
          organizationId,
          // The OUTBOX EVENT ID is the dedupe key, never anything in the payload: §2.6's guarantee is
          // about one DELIVERY of one event, and a payload id (the visit, the missing-resolution row)
          // would silently collapse two genuinely different triggers about the same visit into one.
          sourceOutboxEventId: event.id,
          visitId,
          at: atIso,
          ports: deps.ports,
        });
        await applyAction(
          deps,
          decide({
            organizationId,
            sourceOutboxEventId: event.id,
            payload,
            facts,
            at: atIso,
          }),
          at,
        );
      });
    },
  });

  return [
    // §7.6 — a clinician did not arrive. The welfare check is about the PATIENT, which is why the chief
    // complaint is a frozen platform string and not M17's `reason` free text.
    trigger("m19.no-show-welfare-check", "m17.visit.no_show_detected", (input) =>
      decideNoShowTrigger({
        organizationId: input.organizationId,
        sourceOutboxEventId: input.sourceOutboxEventId,
        payload: input.payload as never,
        facts: input.facts,
        at: input.at,
      }),
    ),
    // §4.8 — a clinician never checked out of a home. M18 has already opened its own
    // `evv_missing_resolution`; this is the clinical arm of the same fact.
    trigger("m19.late-checkout-welfare-check", "m18.evv.late_check_out_detected", (input) =>
      decideLateCheckoutTrigger({
        organizationId: input.organizationId,
        sourceOutboxEventId: input.sourceOutboxEventId,
        payload: input.payload as never,
        facts: input.facts,
        at: input.at,
      }),
    ),
    // §4.8 — a paged on-call recipient never got the page. Not `trigger(...)`: this reads no `visitId`
    // and its facts resolver is `resolveDeliveryFailureFacts`, not `resolveInboundTriggerFacts` (see this
    // file's header). The producer is M36's `applyDeliveryTransition` (delivery-settlement.ts), which publishes
    // `m36.notification.delivery_failed` when a delivery settles `failed`.
    {
      consumerName: "m19.m36-delivery-failed",
      consumerModule: "m19",
      eventTypes: ["m36.notification.delivery_failed"],
      async handle(event) {
        const payload = recordOf("m19.m36-delivery-failed", event.payload);
        const organizationId = event.organizationId as OrgId;
        const at = clock();
        const atIso = at.toISOString() as IsoInstant;
        const alertEventType =
          typeof payload.alertEventType === "string" ? payload.alertEventType : null;
        const sourceAggregateId =
          typeof payload.sourceAggregateId === "string" ? payload.sourceAggregateId : null;
        const m19Payload: M36DeliveryFailedPayload = {
          notificationId: stringOf("m19.m36-delivery-failed", payload, "notificationId"),
          recipientKind: payload.recipientKind as M36DeliveryFailedPayload["recipientKind"],
          providerEntityId:
            typeof payload.providerEntityId === "string"
              ? (payload.providerEntityId as never)
              : null,
          alertEventType,
          // §4.8's own filter: an aggregate id named by an alert that was not one of M19's own is not a
          // call id M19 may trust, whatever it happens to look like.
          triageCallId:
            alertEventType?.startsWith("m19.") === true && sourceAggregateId !== null
              ? (sourceAggregateId as never)
              : null,
          channel: typeof payload.channel === "string" ? payload.channel : null,
          failedAt: typeof payload.failedAt === "string" ? (payload.failedAt as IsoInstant) : atIso,
        };

        await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
          const facts = await resolveDeliveryFailureFacts({
            organizationId,
            sourceOutboxEventId: event.id,
            payload: m19Payload,
            at: atIso,
            ports: deps.ports,
            deliveryPorts: deps.deliveryPorts,
          });
          const action = decideDeliveryFailureTrigger({
            organizationId,
            sourceOutboxEventId: event.id,
            payload: m19Payload,
            facts,
            at: atIso,
          });
          await applyDeliveryFailureAction(deps, organizationId, action, at, atIso);
        });
      },
    },
  ];
}
