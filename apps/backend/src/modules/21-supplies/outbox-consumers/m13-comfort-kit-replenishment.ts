// apps/backend/src/modules/21-supplies/outbox-consumers/m13-comfort-kit-replenishment.ts — M21's live
// binding for the third of the four `../consumers/m13-comfort-kit.ts` deciders (F-153/#248's m21 group,
// this pass): `decideReplenishmentIntake` (§2.1 / §4.5.1).
//
// `m13-comfort-kit-cascade.ts`'s own header named the exact reason this one was NOT bound alongside
// `deployed`/`.return_required`: the intake needs the SAME shared creation path
// `write-service-drizzle.ts`'s `createDirect` seam calls, and extracting that closure to module scope was
// shared-file work belonging with the rest of this arc's centralized wiring. That extraction has now
// landed — `insertSupplyRequest` (`../routes/write-service-drizzle.ts`) is module-level, exported, and
// takes an explicit `outbox` argument rather than closing over one — so this consumer runs the exact same
// D1-validate → D4-route → insert → §4.5.2-emit path a route or the (still-blocked) M11 §4.8 seam would.
//
// THE DECIDER'S OWN DRAFT IS NOT THE WIRE SHAPE. `decideReplenishmentIntake`'s `ReplenishmentRequestDraft`
// is a DECISION-LEVEL record (which dispatch, which medication, how much, how urgent) — it is not, and was
// never meant to be, `ComfortKitReplenishRequestDataSchema` (`@wardenx/supplies`), which additionally
// requires a full per-line pharmacy identity (`rxNorm`/`strength`/`dosageForm`/`routeOfAdministration`/
// `comfortKitTemplateMedicationId`/`expectedUnit`/`replenishmentThresholdPct`) and a `deliveryAddress`
// snapshot — neither of which M13's `m13.comfort_kit.replenishment_needed` payload carries. Both are
// resolved HERE, from M21's OWN tables, never guessed:
//   - the pharmacy identity comes from the ORIGINAL DISPATCHED line for this (dispatch, medicationOrderId)
//     — the same DEA-grade record `createDispatch` wrote when the kit first left the hub, so the
//     replenishment line describes the exact drug the bedside is actually low on, not a re-derivation of
//     it from `drugName` alone (matched by RXNORM everywhere else in this module for exactly that reason);
//   - the delivery address is the SNAPSHOT already sitting on the dispatch's own originating
//     `supply_request.data.deliveryAddress` — reused verbatim (same `capturedAt`), not re-resolved through
//     a live M5 read, because a snapshot re-fetched later would answer "where does the patient live NOW",
//     not "where were we told to take the ORIGINAL kit", and a replenishment restocks the SAME house.
//
// AN UNRESOLVABLE ADDRESS IS A REFUSAL, NOT A DEFAULT. `ComfortKitReplenishRequestDataSchema` requires
// `deliveryAddress` unconditionally, while a `comfort_kit_deploy` for `deploymentSite: 'ipu_room'` omits
// it (an inpatient room has no delivery address to attest against) — so a replenishment for an
// IPU-deployed kit has nothing to reuse and this consumer THROWS rather than fabricate one. That is a
// real, narrow gap in the platform's own schema (an IPU replenishment needs a room-addressed shape the
// spec never defined), reported here rather than worked around with an invented street address on a DEA
// perpetual-log-adjacent record.
//
// NO ACTING MEMBERSHIP (the F-102 `CONSUMER_USER_ID` convention): a bedside drawdown crossing threshold is
// M13 telling M21 something happened, not a human requesting supplies, so `emitCreatedFromExternal: false`
// — `created_from_external`'s own payload requires a real `createdByMembershipId`, which a system cascade
// cannot honestly supply (the same reasoning `write-service.ts`'s `createDirect` doc-comment already
// states for the M11 cascade case).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { SUPPLY_REQUEST_TERMINAL_STATUSES } from "@wardenx/supplies";
import { SupplyStateError } from "../lifecycle/index";
import { insertSupplyRequest } from "../routes/write-service-drizzle";
import type { WriteOutboxPort } from "../routes/write-service";
import {
  M13_REPLENISHMENT_NEEDED_EVENT,
  type ComfortKitDispatchContext,
  type M13ReplenishmentNeededPayload,
  decideReplenishmentIntake,
} from "../consumers/m13-comfort-kit";

const DISPATCH = schema.comfortKitDispatch;
const DISPATCHED = schema.comfortKitDispatchedContent;
const TEMPLATE_MED = schema.comfortKitTemplateMedication;
const REQUEST = schema.supplyRequest;

/** A consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

const TERMINAL_STATUSES: readonly string[] = SUPPLY_REQUEST_TERMINAL_STATUSES;

export interface M21ComfortKitReplenishmentDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly now?: () => Date;
}

type DispatchRow = typeof DISPATCH.$inferSelect;

function toDispatchContext(
  row: DispatchRow,
  containsControlledSubstance: boolean,
): ComfortKitDispatchContext {
  return {
    dispatchId: row.id,
    supplyRequestId: row.supplyRequestId,
    dispatchStatus: row.dispatchStatus,
    patientId: row.patientId,
    admissionId: row.admissionId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    dispatchedByMembershipId: row.dispatchedByMembershipId,
    containsControlledSubstance,
  };
}

/** `dispatched_content.is_controlled_substance` — the same "any controlled line" rule
 *  `m13-comfort-kit-cascade.ts`'s own helper applies, recomputed here (not imported — that helper is
 *  file-private) rather than read through `seams/store-drizzle.ts`, which opens
 *  `withOrgContextFromRequest` and throws outside a request scope (a relay tick is not a request). */
async function dispatchContainsControlledSubstance(
  tx: DbClient,
  dispatchId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ isControlled: DISPATCHED.isControlledSubstance })
    .from(DISPATCHED)
    .where(eq(DISPATCHED.dispatchId, dispatchId));
  return rows.some((r) => r.isControlled);
}

interface OriginalRequestData {
  readonly deliveryAddress?: unknown;
}

/**
 * M21's live `m13.comfort_kit.replenishment_needed` intake binding (§2.1 / §4.5.1).
 *
 * Resolved by `m13_deployment_id`, unlike the deployment ack (§2.5's own reason for keying by
 * patient+admission does not apply here — a replenishment only ever fires AFTER the ack already wrote the
 * link, so the dispatch is addressable by it directly, the same as `.return_required`).
 */
export function buildM21ComfortKitReplenishmentIntakeConsumer(
  deps: M21ComfortKitReplenishmentDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m21.comfort-kit-replenishment-intake",
    consumerModule: "m21",
    eventTypes: [M13_REPLENISHMENT_NEEDED_EVENT],
    async handle(event): Promise<void> {
      const payload = (event.payload ?? {}) as M13ReplenishmentNeededPayload;
      if (typeof payload.deploymentId !== "string") {
        throw new Error("m21.comfort-kit-replenishment-intake: payload has no deploymentId");
      }
      if (typeof payload.medicationOrderId !== "string") {
        throw new Error("m21.comfort-kit-replenishment-intake: payload has no medicationOrderId");
      }
      const organizationId = event.organizationId;
      const at = deps.now?.() ?? new Date();

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        // A redelivery of the SAME outbox row resolves `existingForEventId` below — checked by the
        // provenance column this insert always writes (`source_replenishment_event_id`), not by a DB
        // unique constraint (the schema carries only a plain index; see `supply-requests.ts`).
        const existingForEvent = await tx
          .select({ id: REQUEST.id })
          .from(REQUEST)
          .where(
            and(
              eq(REQUEST.organizationId, organizationId),
              eq(REQUEST.sourceReplenishmentEventId, event.id),
            ),
          )
          .limit(1);

        const dispatchRows = await tx
          .select()
          .from(DISPATCH)
          .where(
            and(
              eq(DISPATCH.organizationId, organizationId),
              eq(DISPATCH.m13DeploymentId, payload.deploymentId),
            ),
          )
          .limit(1);
        const dispatchRow = dispatchRows[0] as DispatchRow | undefined;

        let dispatchContext: ComfortKitDispatchContext | null = null;
        if (dispatchRow) {
          const containsControlledSubstance = await dispatchContainsControlledSubstance(
            tx,
            dispatchRow.id,
          );
          dispatchContext = toDispatchContext(dispatchRow, containsControlledSubstance);
        }

        // An open (non-terminal) replenish request for the same dispatch + medication line already exists
        // — a redelivery-adjacent case distinct from `existingForEvent` above: M13's own retry cadence
        // re-fires this event on every subsequent administration until the kit is actually topped up, so
        // without this check every dose would open a second parallel top-up request.
        let openReplenishRequestId: string | null = null;
        if (dispatchRow) {
          const candidates = await tx
            .select({ id: REQUEST.id, status: REQUEST.status, data: REQUEST.data })
            .from(REQUEST)
            .where(
              and(eq(REQUEST.organizationId, organizationId), eq(REQUEST.kind, "comfort_kit_replenish")),
            );
          for (const c of candidates) {
            if (TERMINAL_STATUSES.includes(c.status)) continue;
            const data = c.data as { sourceDeploymentId?: string; contents?: { medicationOrderId?: string }[] };
            if (data?.sourceDeploymentId !== payload.deploymentId) continue;
            if (!data.contents?.some((line) => line.medicationOrderId === payload.medicationOrderId)) continue;
            openReplenishRequestId = c.id;
            break;
          }
        }

        const action = decideReplenishmentIntake(payload, {
          sourceReplenishmentEventId: event.id,
          existingForEventId: existingForEvent[0]?.id ?? null,
          openReplenishRequestId,
          dispatch: dispatchContext,
        });
        if (action.kind !== "open_replenish_request") return;
        if (!dispatchRow) return; // decider already threw M21_DISPATCH_NOT_FOUND when dispatch is null

        // The pharmacy identity: the ORIGINAL DISPATCHED line for this (dispatch, medicationOrderId), the
        // same record the DEA perpetual log's outbound half carries.
        const lineRows = await tx
          .select({
            rxnorm: DISPATCHED.rxnorm,
            ndc: DISPATCHED.ndc,
            drugName: DISPATCHED.drugName,
            strength: DISPATCHED.strength,
            dosageForm: DISPATCHED.dosageForm,
            routeOfAdministration: DISPATCHED.routeOfAdministration,
            isControlledSubstance: DISPATCHED.isControlledSubstance,
            controlledSubstanceSchedule: DISPATCHED.controlledSubstanceSchedule,
            dispatchedUnit: DISPATCHED.dispatchedUnit,
            comfortKitTemplateMedicationId: DISPATCHED.comfortKitTemplateMedicationId,
            replenishmentThresholdPct: TEMPLATE_MED.replenishmentThresholdPct,
          })
          .from(DISPATCHED)
          .leftJoin(TEMPLATE_MED, eq(TEMPLATE_MED.id, DISPATCHED.comfortKitTemplateMedicationId))
          .where(
            and(
              eq(DISPATCHED.dispatchId, dispatchRow.id),
              eq(DISPATCHED.medicationOrderId, payload.medicationOrderId),
            ),
          )
          .limit(1);
        const line = lineRows[0];
        if (!line) {
          throw new SupplyStateError(
            "M21_REPLENISHMENT_LINE_NOT_FOUND",
            `no dispatched line for medication ${payload.medicationOrderId} on dispatch ${dispatchRow.id}; ` +
              "a replenishment cannot be assembled without the pharmacy identity the original dispatch recorded",
          );
        }

        // The delivery address: reused VERBATIM from the dispatch's own originating supply_request. An
        // IPU-room deployment's originating request carries none (§2.1's optional `deliveryAddress` on
        // `comfort_kit_deploy`), and `comfort_kit_replenish`'s schema requires one unconditionally — a real
        // gap this consumer refuses rather than papers over with a fabricated address.
        const originalRows = await tx
          .select({ data: REQUEST.data })
          .from(REQUEST)
          .where(eq(REQUEST.id, dispatchRow.supplyRequestId))
          .limit(1);
        const deliveryAddress = (originalRows[0]?.data as OriginalRequestData | undefined)
          ?.deliveryAddress;
        if (deliveryAddress === undefined || deliveryAddress === null) {
          throw new SupplyStateError(
            "M21_REPLENISHMENT_ADDRESS_UNRESOLVED",
            `dispatch ${dispatchRow.id}'s originating supply_request carries no deliveryAddress snapshot ` +
              "(an IPU-room deployment has none); a comfort_kit_replenish request cannot be assembled " +
              "without one and this consumer refuses to fabricate an address on a DEA-adjacent record",
          );
        }

        const draft = action.draft;
        await insertSupplyRequest(tx as unknown as Parameters<typeof insertSupplyRequest>[0], deps.outbox, {
          organizationId,
          patientId: draft.patientId,
          admissionId: draft.admissionId,
          locationId: draft.locationId,
          providerEntityId: draft.providerEntityId,
          kind: draft.kind,
          data: {
            sourceDeploymentId: draft.sourceDeploymentId,
            triggeringReplenishmentEventId: draft.sourceReplenishmentEventId,
            urgencyKind: draft.urgencyKind,
            deliveryAddress,
            contents: [
              {
                medicationOrderId: draft.medicationOrderId,
                comfortKitTemplateMedicationId: line.comfortKitTemplateMedicationId,
                rxNorm: line.rxnorm,
                ...(line.ndc ? { ndc: line.ndc } : {}),
                drugName: line.drugName,
                strength: line.strength,
                dosageForm: line.dosageForm,
                routeOfAdministration: line.routeOfAdministration,
                isControlledSubstance: line.isControlledSubstance,
                ...(line.controlledSubstanceSchedule
                  ? { controlledSubstanceSchedule: line.controlledSubstanceSchedule }
                  : {}),
                expectedQuantity: Number(draft.requestedQuantity),
                expectedUnit: line.dispatchedUnit,
                replenishmentThresholdPct: Number(line.replenishmentThresholdPct ?? "0.25"),
              },
            ],
          },
          sourceOrderId: null,
          sourceReplenishmentEventId: event.id,
          requestedByMembershipId: null,
          deliveryInstructions: null,
          at,
          // §7.1 acceptance 3 / this file's own header — a system cascade must not claim a human origin.
          emitCreatedFromExternal: false,
        });
      });
    },
  };
}
