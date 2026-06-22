// @wardenx/dosespot — Module 12 (DoseSpot Integration) feature package.
//
// M12-T01 lands the domain layout + metadata: the §2.1 Medication-Class catalog (`classes/catalog.ts`).
// The cross-module enum/seam/outbox/alert CONTRACTS live in the leaf `@wardenx/types` (`dosespot.ts`) so
// downstream consumers (M13/M14/M28/M31/M33) import them with no `dependsOn` edge.
//
// M12-T03 lands the pure medication-order-lifecycle domain (`lifecycle/`): the §2.2 D2 state machine
// (extending M11's order machine with the DoseSpot transmission outcomes + the EPCS controlled-substance
// branch) and the §2.3 verbal-medication-order workflow that *consumes* M11's `OrderSignatureProvider`
// primitive (D3 — M12 ships no parallel timer). It lives HERE (the M12 feature package, the M11
// `@wardenx/orders` precedent) rather than the `@wardenx/domain` leaf because it reads the local
// `MED_CLASS_CATALOG`. IO-free, `@wardenx/types`-only.
//
// Later tasks add: the per-class TypeBox `data` schemas + cross-field validators + transmission mappers +
// EPCS rules (`classes/<class>/`, M12-T04+); the refill-inbox workflow (M12-T04); the EPCS architecture
// (`epcs/`, M12-T05); the DoseSpot adapter + webhook security (`client/`, `webhook/`, `credentials/`,
// M12-T06); the `MedicationOrderProvider`/`RefillInboxProvider` seam impls (`seams.ts`, M12-T07); the typed
// M36 alert builders (`alerts.ts`) + `m12.*` outbox payload assemblers (`outbox.ts`) (M12-T08).

export * from "./classes/catalog";
export * from "./lifecycle";
