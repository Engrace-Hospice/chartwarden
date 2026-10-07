// apps/backend/src/modules/21-supplies — Module 21 (Supplies, DME & Comfort Kits).
//
// M21-T03 landed the §2.2–§2.7 domain core (`lifecycle/`): the D2 fulfillment machine built from the
// `@wardenx/supplies` edge table, the §2.3 append-only comfort-kit recipe rules, the §2.5 fail-closed
// dispatch validation plus the dispatch row's own status machine, the §2.6 chain-of-custody return machine
// with its computed D8 discrepancy and 30d/90d escalation, and the §2.7 par-stock bands. Every machine is
// PURE — facts arrive resolved and each transition returns a declarative side-effect list the service layer
// executes in one transaction.
//
// M21-T04 landed the cross-module boundary in both directions:
//   • `events-by-m21.ts`  — the §4.5.2 `m21.*` outbox catalog (naming/ownership/consumers scanned by
//     `arch:gaps`, merged into the platform catalog at boot, and the dispatcher's payload validator)
//   • `consumers/`        — the §4.5.1 inbound deciders that CLOSE M11's and M13's Wave-E deny-stubs
//   • `seams/consumed.ts` — M11's `OrderProvider` + M6's `AdmissionStatusReader`/`DeathDischargeReader`,
//     resolved through the M1 registry (which is why M21's manifest `dependsOn` gains M1)
//
// M21-T05 lands the SERVICE layer — everything between those pure machines and the wire:
//   • `seams/`             — the §4.8 / D14 PUBLISHED seams (`SupplyFulfillmentProvider` ·
//                            `ComfortKitDispatchProvider` · `SupplyCostProvider`) over one Drizzle store,
//                            registered into the M1 registry before `validateSeams()`
//   • `permission-keys.ts` — the twenty-nine §4.3 keys M21 contributes to M3's catalog (F-193/#248 added
//                            `supplies.request.caregiver_signature` beside `mark_delivered`)
//   • `abac-predicates.ts` — the two §4.4 named predicates (`controlled_substance_dispatcher_eligible` ·
//                            `comfort_kit_return_reconciler_eligible`), fail-CLOSED, with the Drizzle
//                            subject-fact resolver beside them
//   • `routes/`            — the §4.1 route inventory over a split read/write service pair, including the
//                            §8.1 DEA 21 CFR §1304 perpetual-log read and the outbox-only M22 handoffs
//                            (bill of lading at dispatch, DEA-1304-format receipt at reconciliation)
//   • `erasers/`           — the `supply_record` eraser, which PRESERVES the de-identified controlled-
//                            substance ledger rather than deleting it (DEA §1304.04 retention)
//
// Still to land: the §5 screens (M21-T06).
export * from "./lifecycle/index";
export * from "./consumers/index";
export {
  type SuppliesSeamDeps,
  type SuppliesSeamStore,
  type SupplyRequestCreator,
  __resetSupplyRequestCreatorForTest,
  bindSupplyRequestCreator,
  buildDrizzleSuppliesSeamStore,
  createComfortKitDispatchProvider,
  createInMemorySuppliesSeamStore,
  createSupplyCostProvider,
  createSupplyFulfillmentProvider,
  getAdmissionStatusReader,
  getComfortKitDispatchProvider,
  getDeathDischargeReader,
  getOrderProvider,
  getSupplyCostProvider,
  getSupplyFulfillmentProvider,
  registerSuppliesSeams,
} from "./seams/index";
export { M21_OUTBOX_EVENTS, assertM21EventCatalogComplete } from "./events-by-m21";
export {
  M21_CONTRIBUTED_PERMISSIONS,
  M21_CONTROLLED_SUBSTANCE_PERMISSION_KEYS,
  M21_PERMISSION_KEY_LIST,
  M21_PLATFORM_ONLY_PERMISSION_KEYS,
  type M21PermissionKey,
} from "./permission-keys";
export {
  COMFORT_KIT_RECONCILER_ROLES,
  CONTROLLED_SUBSTANCE_DISPATCHER_ROLES,
  CROSS_LOCATION_DISPATCH_ROLES,
  M21_ABAC_PREDICATES,
  type SuppliesAbacDeps,
  type SuppliesAbacResolver,
  buildSuppliesAbacPredicates,
  decideDispatcherEligible,
  decideReconcilerEligible,
  denyStubSuppliesAbacResolver,
  registerSuppliesAbacPredicates,
} from "./abac-predicates";
export {
  type SuppliesAbacResolverDeps,
  buildDrizzleSuppliesAbacResolver,
} from "./abac-resolver-drizzle";
export * from "./routes/index";
export * from "./jobs/index";
export { mountM21Routes } from "./routes/mount";
export {
  DEIDENTIFIED_UUID,
  type SupplyEraseCounts,
  type SupplyEraseStore,
  buildDrizzleSupplyEraseStore,
  eraseSupplyRecord,
  registerSupplyEraser,
} from "./erasers/supply-eraser";
export {
  M21_DOCUMENT_BACKREF_CONSUMER,
  buildM21DocumentBackrefConsumer,
} from "./outbox-consumers/m22-document-rendered";
export {
  type M21OrderCascadeDeps,
  buildM21OrderDiscontinuedConsumer,
  buildM21SupplyCancellationConsumer,
} from "./outbox-consumers/m11-order-cascade";
// F-232 (#248) — the §7.1 fulfillment intake (`m11.order.supply_fulfillment_requested`), the third M11 decider.
export {
  M21_SUPPLY_FULFILLMENT_INTAKE_CONSUMER,
  type M21SupplyFulfillmentIntakeDeps,
  type SupplyIntakeOutcome,
  type SupplyIntakeSettleReason,
  buildM21SupplyFulfillmentIntakeConsumer,
  runSupplyFulfillmentIntake,
} from "./outbox-consumers/m11-supply-fulfillment-intake";
// F-153 (#248) — M13's §2.5 deployment-ack link + §2.6 return-required chain-of-custody open.
// F-172 (#248) — the §4.5.1 controlled-substance re-emit joins them.
export {
  type M21ComfortKitCascadeDeps,
  type M21ComfortKitReemitDeps,
  buildM21ComfortKitControlledSubstanceReemitConsumer,
  buildM21ComfortKitDeploymentAckConsumer,
  buildM21ComfortKitReturnRequiredConsumer,
} from "./outbox-consumers/m13-comfort-kit-cascade";
// F-161 (#248) — M13's §2.1 comfort-kit replenishment intake.
export {
  type M21ComfortKitReplenishmentDeps,
  buildM21ComfortKitReplenishmentIntakeConsumer,
} from "./outbox-consumers/m13-comfort-kit-replenishment";
// F-233 (#248) — `m12.medication_order.dispensed_at_pharmacy` -> `supply_request_pharmacy_dispense` fact
// (Option B: correlates by `contents[].medicationOrderId`; creates no dispatch).
export {
  M12_DISPENSED_AT_PHARMACY_EVENT,
  M21_PHARMACY_DISPENSE_CONSUMER_NAME,
  NO_CORRELATING_REQUEST_REASON,
  type M21PharmacyDispenseDeps,
  buildM21PharmacyDispenseConsumer,
} from "./outbox-consumers/m12-pharmacy-dispense";

// GAP-137 — M21 D15 AI-prohibited-zone boot validator (db-present onReady hook in the composition root).
export {
  SUPPLY_PROHIBITED_OUTPUT_ENTITY_PREFIXES,
  type SupplyAiPromptRegistryPort,
  SupplyAIBlockViolation,
  validateSupplyAIBlock,
} from "./ai-block";
