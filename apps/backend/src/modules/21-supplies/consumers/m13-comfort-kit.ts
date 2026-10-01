// apps/backend/src/modules/21-supplies/consumers/m13-comfort-kit.ts — M21-T04 (§4.5.1, §2.5, §2.6).
//
// M21's subscribers to Module 13's comfort-kit chain — the handshake that CLOSES M13's Wave-E comfort-kit
// deny-stub. The division of labour is physical: M13 owns what happens to the medication at the BEDSIDE
// (administration, drawdown, the bedside count), M21 owns the KIT as an object that leaves a hub, sits in
// a house and comes back. Four events cross that line, and none of them is a schema import.
//
//   • replenishment_needed            → a new `comfort_kit_replenish` supply request (§2.1)
//   • return_required                 → open the §2.6 chain-of-custody return obligation
//   • deployed                        → M13's ack; bind `comfort_kit_dispatch.m13_deployment_id` (§2.5)
//   • controlled_substance_discrepancy → re-emit with M21 dispatch context (§4.5.1)
//
// PURE DECISION CORES over resolved facts, same as ./m11-orders. The live outbox binding + the
// transactional writes land with the §4.6 workers alongside the M21-T05 service layer.
//
// THE ASYMMETRY WORTH KNOWING. Three of these four events name an M13 `deploymentId` and nothing else —
// M13's aggregate is the deployment, not the dispatch. M21 must map deployment → dispatch, and the ONLY
// link is `comfort_kit_dispatch.m13_deployment_id`, which is written by the `deployed` ack. So the ack is
// load-bearing for the other two: a dispatch M13 never acked cannot be found by a later
// `return_required`. §7.2's "M13 down" edge case makes the ack explicitly non-fatal and late-arrivable
// (the dispatch machine accepts `linkM13Deployment` from every non-terminal status), which is what keeps
// that from becoming a permanent orphan — but until it arrives, a return-required for that kit
// dead-letters rather than opening a return against a kit M21 cannot identify.
import type {
  ComfortKitDeploymentId,
  ComfortKitDispatchId,
  ComfortKitDispatchStatus,
  ComfortKitReturnId,
  ComfortKitReturnState,
  ComfortKitReturnedContentPayload,
  IsoInstant,
  M21SubscribedEventName,
  MedicationOrderId,
  MembershipId,
  OutboxEventId,
  SupplyRequestId,
} from "@wardenx/types";
import { computeReturnDueAt } from "../lifecycle/index";
import { SupplyStateError } from "../lifecycle/index";

// ── the four subscribed M13 event names + their payloads (§4.5.1) ────────────────────────────────────

/** §4.5.1 — a bedside drawdown crossed a line's replenishment threshold. */
export const M13_REPLENISHMENT_NEEDED_EVENT: Extract<
  M21SubscribedEventName,
  "m13.comfort_kit.replenishment_needed"
> = "m13.comfort_kit.replenishment_needed";

/** §4.5.1 — the M6→M13 discharge cascade flagged a live deployment for retrieval. */
export const M13_RETURN_REQUIRED_EVENT: Extract<
  M21SubscribedEventName,
  "m13.comfort_kit.return_required"
> = "m13.comfort_kit.return_required";

/** §4.5.1 / §2.5 — M13 built its deployment + drawdown rows off `m21.comfort_kit.deployed_at_patient`. */
export const M13_COMFORT_KIT_DEPLOYED_EVENT: Extract<
  M21SubscribedEventName,
  "m13.comfort_kit.deployed"
> = "m13.comfort_kit.deployed";

/** §4.5.1 — M13's bedside count found a ≥5% controlled-substance delta. */
export const M13_CONTROLLED_SUBSTANCE_DISCREPANCY_EVENT: Extract<
  M21SubscribedEventName,
  "m13.comfort_kit.controlled_substance_discrepancy"
> = "m13.comfort_kit.controlled_substance_discrepancy";

/** `m13.comfort_kit.replenishment_needed` (apps/backend/src/modules/13-emar/events-by-m13.ts).
 *  Quantities arrive as NUMBERS on M13's wire; M21 stores `numeric` and normalizes on the way in. */
export interface M13ReplenishmentNeededPayload {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly medicationOrderId: MedicationOrderId;
  readonly drugName: string;
  readonly remainingQuantity: number;
  readonly requestedQuantity: number;
  readonly urgencyKind: string;
}

/** `m13.comfort_kit.return_required`. */
export interface M13ReturnRequiredPayload {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly patientId: string;
  readonly admissionId: string;
  readonly returnRequiredAt: IsoInstant;
}

/** `m13.comfort_kit.deployed` — M13's ack of a deployment it created from M21's manifest. */
export interface M13ComfortKitDeployedPayload {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly patientId: string;
  readonly admissionId: string;
  readonly contents: unknown;
}

/** `m13.comfort_kit.controlled_substance_discrepancy` — the bedside count's verdict on ONE line.
 *  `returnId` (F-172, #248): the `comfort_kit_return` this discrepancy belongs to — M13's own emit site
 *  (`13-emar/outbox-consumers/m21-comfort-kit-return-reconciliation.ts`) already has it in scope, since
 *  that handler IS the `m21.comfort_kit.return_reconciliation` consumer for this exact return. */
export interface M13ControlledSubstanceDiscrepancyPayload {
  readonly deploymentId: ComfortKitDeploymentId;
  readonly medicationOrderId: MedicationOrderId;
  readonly returnId: ComfortKitReturnId;
  readonly deltaQuantity: number;
  readonly deltaPercent: number;
}

// ── resolved facts ───────────────────────────────────────────────────────────────────────────────────

/** The M21 dispatch an M13 `deploymentId` maps to, plus the tenancy block every M21 write needs. */
export interface ComfortKitDispatchContext {
  readonly dispatchId: ComfortKitDispatchId;
  readonly supplyRequestId: SupplyRequestId;
  readonly dispatchStatus: ComfortKitDispatchStatus;
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  /** `comfort_kit_dispatch.dispatched_by_membership_id` — the head of the §8.1 custody chain. */
  readonly dispatchedByMembershipId: string;
  /** True when at least one dispatched line is CII–CV. Drives the D8 escalation posture. */
  readonly containsControlledSubstance: boolean;
}

// ── §2.1 the replenishment intake ────────────────────────────────────────────────────────────────────

/** The `comfort_kit_replenish` row the intake inserts. `sourceOrderId` is null BY CONSTRUCTION: a drawdown
 *  is not an order, and the §3.1 provenance CHECK allows exactly one upstream. */
export interface ReplenishmentRequestDraft {
  readonly kind: "comfort_kit_replenish";
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly sourceOrderId: null;
  /** §2.8 — the M1 outbox row this request was born from, so the provenance is a real id, not a note. */
  readonly sourceReplenishmentEventId: OutboxEventId;
  readonly comfortKitDispatchId: ComfortKitDispatchId;
  readonly sourceDeploymentId: ComfortKitDeploymentId;
  readonly medicationOrderId: MedicationOrderId;
  readonly drugName: string;
  /** Decimal STRING — the column is `numeric` (see events-by-m21.ts on why floats are not allowed near a
   *  DEA perpetual log). M13's number is normalized here, at the one place it crosses the boundary. */
  readonly requestedQuantity: string;
  readonly urgencyKind: string;
}

/** What the `m13.comfort_kit.replenishment_needed` decider resolved. */
export type ReplenishmentIntakeAction =
  /** A redelivery for an outbox row already consumed (`source_replenishment_event_id` is unique). */
  | { readonly kind: "idempotent_skip"; readonly supplyRequestId: SupplyRequestId }
  /** An open replenish request for the same (dispatch, medication) already exists — do not stack a second
   *  top-up for one shortfall. The drawdown will cross the threshold again on every administration until
   *  the kit is replenished, so without this M13's own retry cadence would flood the coordinator queue. */
  | { readonly kind: "already_pending"; readonly supplyRequestId: SupplyRequestId }
  | { readonly kind: "open_replenish_request"; readonly draft: ReplenishmentRequestDraft };

/** Everything the replenishment worker reads before it can decide. */
export interface ReplenishmentIntakeFacts {
  /** The M1 outbox row id carrying this delivery — the §2.8 provenance FK. */
  readonly sourceReplenishmentEventId: OutboxEventId | null;
  /** A request already written for this outbox row. */
  readonly existingForEventId: SupplyRequestId | null;
  /** An open (non-terminal) replenish request for the same dispatch + medication. */
  readonly openReplenishRequestId: SupplyRequestId | null;
  /** The dispatch M13's `deploymentId` maps to. */
  readonly dispatch: ComfortKitDispatchContext | null;
}

/**
 * §2.1 / §4.5.1 — decide what an `m13.comfort_kit.replenishment_needed` delivery does.
 *
 * Throws `M21_DISPATCH_NOT_FOUND` when the deployment maps to no dispatch (dead-letter: a replenish request
 * with no kit to top up is a request to send controlled substances to an address M21 cannot name).
 */
export function decideReplenishmentIntake(
  payload: M13ReplenishmentNeededPayload,
  facts: ReplenishmentIntakeFacts,
): ReplenishmentIntakeAction {
  if (facts.existingForEventId !== null) {
    return { kind: "idempotent_skip", supplyRequestId: facts.existingForEventId };
  }
  if (facts.openReplenishRequestId !== null) {
    return { kind: "already_pending", supplyRequestId: facts.openReplenishRequestId };
  }

  const dispatch = facts.dispatch;
  if (dispatch === null) {
    throw new SupplyStateError(
      "M21_DISPATCH_NOT_FOUND",
      `no comfort_kit_dispatch is linked to M13 deployment ${payload.deploymentId}`,
    );
  }
  if (facts.sourceReplenishmentEventId === null) {
    // The §3.1 provenance CHECK demands exactly one upstream and a replenish has no order to fall back on.
    throw new SupplyStateError(
      "M21_REPLENISHMENT_PROVENANCE_MISSING",
      `replenishment for deployment ${payload.deploymentId} carries no outbox event id to anchor provenance`,
    );
  }

  return {
    kind: "open_replenish_request",
    draft: {
      kind: "comfort_kit_replenish",
      patientId: dispatch.patientId,
      admissionId: dispatch.admissionId,
      providerEntityId: dispatch.providerEntityId,
      locationId: dispatch.locationId,
      sourceOrderId: null,
      sourceReplenishmentEventId: facts.sourceReplenishmentEventId,
      comfortKitDispatchId: dispatch.dispatchId,
      sourceDeploymentId: payload.deploymentId,
      medicationOrderId: payload.medicationOrderId,
      drugName: payload.drugName,
      requestedQuantity: String(payload.requestedQuantity),
      urgencyKind: payload.urgencyKind,
    },
  };
}

// ── §2.6 the return obligation ───────────────────────────────────────────────────────────────────────

/** The `comfort_kit_return` row the cascade opens, pre-populated from the dispatch (§4.5.1). */
export interface ComfortKitReturnDraft {
  readonly dispatchId: ComfortKitDispatchId;
  readonly m13DeploymentId: ComfortKitDeploymentId;
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly state: Extract<ComfortKitReturnState, "requested">;
  readonly returnRequiredAt: IsoInstant;
  readonly returnDueAt: IsoInstant;
  readonly containsControlledSubstance: boolean;
}

/** What the `m13.comfort_kit.return_required` decider resolved. */
export type ReturnRequiredAction =
  /** A return is already open (or already closed) for this dispatch — the cascade is a redelivery. */
  | { readonly kind: "idempotent_skip"; readonly returnId: ComfortKitReturnId }
  | { readonly kind: "open_return"; readonly draft: ComfortKitReturnDraft };

/** Everything the return-required worker reads before it can decide. */
export interface ReturnRequiredFacts {
  /** Any existing `comfort_kit_return` for this dispatch, in any state. */
  readonly existingReturnId: ComfortKitReturnId | null;
  readonly dispatch: ComfortKitDispatchContext | null;
  /** The tenant's return window in hours; omitted uses the §2.6 platform default. */
  readonly returnWindowHours?: number;
}

/**
 * §2.6 / §4.5.1 — decide what an `m13.comfort_kit.return_required` delivery does.
 *
 * §4.5.1 words this as "pre-populated from the dispatch's dispatched_content (sets expected quantities)".
 * The EXPECTED quantities are not copied into the draft here: `comfort_kit_returned_content` rows are
 * written at reconciliation, and the dispatched lines they are compared against already live on the
 * dispatch. Copying them at open time would create a second, staleable copy of the DEA manifest — the one
 * artifact that must have exactly one writer.
 *
 * Throws `M21_DISPATCH_NOT_FOUND` when the deployment maps to no dispatch (see the file header on why the
 * `deployed` ack is load-bearing here).
 */
export function decideReturnRequired(
  payload: M13ReturnRequiredPayload,
  facts: ReturnRequiredFacts,
): ReturnRequiredAction {
  if (facts.existingReturnId !== null) {
    return { kind: "idempotent_skip", returnId: facts.existingReturnId };
  }

  const dispatch = facts.dispatch;
  if (dispatch === null) {
    throw new SupplyStateError(
      "M21_DISPATCH_NOT_FOUND",
      `no comfort_kit_dispatch is linked to M13 deployment ${payload.deploymentId}`,
    );
  }

  return {
    kind: "open_return",
    draft: {
      dispatchId: dispatch.dispatchId,
      m13DeploymentId: payload.deploymentId,
      patientId: dispatch.patientId,
      admissionId: dispatch.admissionId,
      providerEntityId: dispatch.providerEntityId,
      locationId: dispatch.locationId,
      state: "requested",
      returnRequiredAt: payload.returnRequiredAt,
      returnDueAt: computeReturnDueAt(payload.returnRequiredAt, facts.returnWindowHours),
      containsControlledSubstance: dispatch.containsControlledSubstance,
    },
  };
}

// ── §2.5 the deployment ack ──────────────────────────────────────────────────────────────────────────

/** What the `m13.comfort_kit.deployed` decider resolved. */
export type DeploymentAckAction =
  /** The link is already written — a redelivery. Re-binding would stamp a second deployment id over the
   *  first, and the FIRST is the one every subsequent M13 event keys on. */
  | { readonly kind: "no_op" }
  /** Fire the dispatch machine's state-preserving `linkM13Deployment` (§2.5). */
  | {
      readonly kind: "link_deployment";
      readonly dispatchId: ComfortKitDispatchId;
      readonly m13DeploymentId: ComfortKitDeploymentId;
    };

/**
 * §2.5 — decide what an `m13.comfort_kit.deployed` ack does.
 *
 * The ack is resolved by SUPPLY REQUEST, not by deployment id: the whole point of the ack is that the link
 * does not exist yet, so keying on it would find nothing. §7.2 makes a late ack explicitly non-fatal, which
 * is why an unmatched ack is a `no_op` rather than a dead-letter — an ack for a dispatch this tenant does
 * not have is M13 noise, not an M21 fault.
 */
export function decideDeploymentAck(
  payload: M13ComfortKitDeployedPayload,
  dispatch: (ComfortKitDispatchContext & { readonly m13DeploymentId: string | null }) | null,
): DeploymentAckAction {
  if (dispatch === null) return { kind: "no_op" };
  if (dispatch.m13DeploymentId !== null) return { kind: "no_op" };
  return {
    kind: "link_deployment",
    dispatchId: dispatch.dispatchId,
    m13DeploymentId: payload.deploymentId,
  };
}

// ── §4.5.1 the controlled-substance re-emit ──────────────────────────────────────────────────────────

/** The `comfort_kit_return` custody facts the catalogued `m21.controlled_substance.discrepancy_detected`
 *  schema requires alongside `dispatch.dispatchedByMembershipId` (F-172, #248) — read off the SAME
 *  `comfort_kit_return` row M13's widened payload now names by `returnId`. All three are genuinely
 *  nullable on that row (a return can be `reconciled` with no retriever/witness recorded, though
 *  `reconciledByMembershipId` is NOT NULL once `state='reconciled'` — see the schema's own
 *  `m21_ckit_return_reconciled_complete` CHECK); resolved, never guessed. */
export interface ControlledSubstanceCustodyChainFacts {
  readonly retrievingMembershipId: MembershipId | null;
  readonly disposalWitnessMembershipId: MembershipId | null;
  readonly reconciledByMembershipId: MembershipId | null;
}

/** What the `m13.comfort_kit.controlled_substance_discrepancy` decider resolved. */
export type ControlledSubstanceReemitAction =
  /** No M21 dispatch context, no matching `comfort_kit_returned_content` row, or no `comfort_kit_return`
   *  row to enrich with. M21 stays SILENT rather than re-emitting a partial or fabricated copy: M30 and
   *  M36 already receive M13's own event directly (`declaredConsumers: ["m30"→moved,"m36"]`… M13's own
   *  catalog keeps `seamConsumers: ["m36"]`), so the surveyor signal is not lost — only M21's
   *  dispatch-context + custody-chain enrichment is, and a re-emit with a fabricated `returnedContentId`
   *  or an invented custody name would be worse than the (already-delivered) plain M13 signal. */
  | { readonly kind: "no_enrichment_context" }
  /** Re-emit as `m21.controlled_substance.discrepancy_detected` with `detectionSource: 'm13_reemit'` —
   *  the exact shape `M21ControlledSubstanceDiscrepancyPayload` (`@wardenx/types`) requires, built from
   *  the REAL `comfort_kit_returned_content` row rather than a synthesized one, since M21's own
   *  `reconcileReturn` transaction already wrote it (strictly before this M13 event could ever fire —
   *  M13 only emits off the `m21.comfort_kit.return_reconciliation` event that same transaction's commit
   *  produces). */
  | {
      readonly kind: "reemit";
      readonly returnId: ComfortKitReturnId;
      readonly dispatchId: ComfortKitDispatchId;
      readonly m13DeploymentId: ComfortKitDeploymentId;
      readonly detectionSource: "m13_reemit";
      readonly discrepantMedication: ComfortKitReturnedContentPayload;
      readonly custodyChain: {
        readonly dispatchedByMembershipId: MembershipId;
        readonly retrievingMembershipId: MembershipId | null;
        readonly disposalWitnessMembershipId: MembershipId | null;
        readonly reconciledByMembershipId: MembershipId | null;
      };
    };

/**
 * §4.5.1 — decide what an `m13.comfort_kit.controlled_substance_discrepancy` delivery does.
 *
 * M13 counts at the bedside and knows the delta; M21 knows the physical unit's full accounting — lot
 * number, schedule, who dispatched/retrieved/witnessed/reconciled it. The re-emit exists to join those
 * two halves onto the ONE survey-investigable record (`m21.controlled_substance.discrepancy_detected`) so
 * an investigator does not have to correlate M13's bare delta against M21's own custody chain by hand.
 *
 * `returnedContent` is the REAL, already-persisted `comfort_kit_returned_content` row for this exact
 * (return, medication) — not re-derived from M13's `deltaQuantity`/`deltaPercent`, which are M13's OWN
 * administration-tracked accounting and may legitimately disagree with M21's dispatched-vs-returned
 * math (that disagreement — two independent discrepancy checks catching different failure modes — is
 * the whole reason this event exists rather than being redundant with M21's own native
 * `detectionSource: "return_reconciliation"` emission).
 */
export function decideControlledSubstanceReemit(
  payload: M13ControlledSubstanceDiscrepancyPayload,
  dispatch: ComfortKitDispatchContext | null,
  returnedContent: ComfortKitReturnedContentPayload | null,
  custody: ControlledSubstanceCustodyChainFacts | null,
): ControlledSubstanceReemitAction {
  if (dispatch === null || returnedContent === null || custody === null) {
    return { kind: "no_enrichment_context" };
  }
  return {
    kind: "reemit",
    returnId: payload.returnId,
    dispatchId: dispatch.dispatchId,
    m13DeploymentId: payload.deploymentId,
    detectionSource: "m13_reemit",
    discrepantMedication: returnedContent,
    custodyChain: {
      dispatchedByMembershipId: dispatch.dispatchedByMembershipId,
      retrievingMembershipId: custody.retrievingMembershipId,
      disposalWitnessMembershipId: custody.disposalWitnessMembershipId,
      reconciledByMembershipId: custody.reconciledByMembershipId,
    },
  };
}
