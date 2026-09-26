// apps/backend/src/modules/19-oncall/consumers/bindings.ts — the live `OutboxConsumerBinding`s for M19's
// two D10 inbound triggers (F-043 / #103).
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
// This also gives `m19.oncall_shift.coverage_gap` its first producer. `events-by-m19.ts`'s own header says
// so: the event is "declared in `M19_EVENT_NAMES` but never actually published anywhere in this codebase
// yet (the watchdog that would fire `coverage_gap` is `consumers/inbound-trigger.ts`'s
// `TriggerCoverageGap`, whose shape this schema mirrors exactly)".
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
import { type DbClient, schema } from "@wardenx/db";
import { runWithRequestContext, withOrgContext } from "@wardenx/tenancy";
import type { IsoInstant, OrgId } from "@wardenx/types";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildCaseOpenedAlert, buildCoverageGapAlert } from "../alerts";
import { openCallEffects } from "../lifecycle/triage-call";
import { type StateHistoryPort, runEffects } from "../routes/effects-runner";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";
import type { InboundTriggerAction, MachineOpenedCallDraft } from "./inbound-trigger";
import { decideNoShowTrigger } from "./m17-no-show";
import { decideLateCheckoutTrigger } from "./m18-late-checkout";
import type { InboundTriggerPorts } from "./trigger-context";
import { resolveInboundTriggerFacts } from "./trigger-context";

const CALL = schema.triageCall;
const HISTORY = schema.triageCallStateHistory;

/** §3.3 — a machine-opened call names no acting membership. */
const CONSUMER_USER_ID = "";

export interface OncallTriggerConsumerDeps {
  readonly db: DbClient;
  readonly ports: InboundTriggerPorts;
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
function stateHistoryPort(): StateHistoryPort {
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
        commandPayloadDigest: row.commandPayloadDigest,
      });
    },
  };
}

/** Insert the machine-opened call and run its §2.4 effects, in one transaction. */
async function openMachineCall(
  deps: OncallTriggerConsumerDeps,
  draft: MachineOpenedCallDraft,
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
async function publishCoverageGap(
  deps: OncallTriggerConsumerDeps,
  gap: {
    readonly organizationId: OrgId;
    readonly providerEntityId: string;
    readonly gapStartsAt: IsoInstant;
    readonly gapEndsAt: IsoInstant;
    readonly discipline: "clinical_rn";
  },
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
  ];
}
