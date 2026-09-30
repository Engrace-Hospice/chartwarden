// apps/backend/src/modules/21-supplies/consumers — the §4.5.1 inbound-event layer (M21-T04).
//
//   • ./m11-orders     the three M11 cascade deciders — §7.1 fulfillment intake (incl. the two pre-dispatch
//                      cancellation edges), §7.7 cancellation cascade, and the §2.2 DME monthly-rental
//                      close-out. CLOSES M11's Wave-E supply deny-stub.
//   • ./m13-comfort-kit the four M13 kit deciders — replenishment intake, the §2.6 return obligation, the
//                      §2.5 deployment ack and the controlled-substance re-emit. CLOSES M13's Wave-E
//                      comfort-kit deny-stub.
//   • ./order-context  the IO half: resolves the M11/M6 facts through the M1 seam registry so the deciders
//                      above stay pure.
//
// Every decider is a PURE function over resolved facts (the M7 `apply-idg-decision` / M16 `m6-eligibility`
// precedent). The live outbox bindings + the transactional writes land with the §4.6 workers alongside the
// M21-T05 service layer.
export {
  M11_CANCELLATION_CASCADE_REASON,
  M11_ORDER_DISCONTINUED_EVENT,
  M11_SUPPLY_CANCELLATION_REQUESTED_EVENT,
  M11_SUPPLY_FULFILLMENT_REQUESTED_EVENT,
  type M11OrderDiscontinuedPayload,
  type M11SupplyCancellationRequestedPayload,
  type M11SupplyFulfillmentRequestedPayload,
  type M11SupplyOrderKind,
  type SupplyAdmissionContext,
  type SupplyCancellationCascadeAction,
  type SupplyCancellationTarget,
  type SupplyDiscontinuationAction,
  type SupplyDiscontinuationTarget,
  type SupplyFulfillmentIntakeAction,
  type SupplyFulfillmentIntakeFacts,
  type SupplyOrderContext,
  type SupplyPreDispatchCancellationReason,
  type SupplyRequestDraft,
  decideOrderDiscontinued,
  decideSupplyCancellationCascade,
  decideSupplyFulfillmentIntake,
  supplyRequestKindForOrderKind,
} from "./m11-orders";
export {
  M13_COMFORT_KIT_DEPLOYED_EVENT,
  M13_CONTROLLED_SUBSTANCE_DISCREPANCY_EVENT,
  M13_REPLENISHMENT_NEEDED_EVENT,
  M13_RETURN_REQUIRED_EVENT,
  type ComfortKitDispatchContext,
  type ComfortKitReturnDraft,
  type ControlledSubstanceCustodyChainFacts,
  type ControlledSubstanceReemitAction,
  type DeploymentAckAction,
  type M13ComfortKitDeployedPayload,
  type M13ControlledSubstanceDiscrepancyPayload,
  type M13ReplenishmentNeededPayload,
  type M13ReturnRequiredPayload,
  type ReplenishmentIntakeAction,
  type ReplenishmentIntakeFacts,
  type ReplenishmentRequestDraft,
  type ReturnRequiredAction,
  type ReturnRequiredFacts,
  decideControlledSubstanceReemit,
  decideDeploymentAck,
  decideReplenishmentIntake,
  decideReturnRequired,
} from "./m13-comfort-kit";
export {
  DEATH_DISCHARGE_WINDOW_DAYS,
  type SupplyIntakePorts,
  deathCensusWindow,
  intakeOccurredAt,
  resolveSupplyOrderContext,
} from "./order-context";
