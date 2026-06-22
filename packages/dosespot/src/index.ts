// @wardenx/dosespot — Module 12 (DoseSpot Integration) feature package.
//
// M12-T01 lands the domain layout + metadata: the §2.1 Medication-Class catalog (`classes/catalog.ts`).
// The cross-module enum/seam/outbox/alert CONTRACTS live in the leaf `@wardenx/types` (`dosespot.ts`) so
// downstream consumers (M13/M14/M28/M31/M33) import them with no `dependsOn` edge.
//
// Later tasks add: the per-class TypeBox `data` schemas + cross-field validators + transmission mappers +
// EPCS rules (`classes/<class>/`, M12-T03+); the pure med-order lifecycle machine + verbal-order workflow
// (M12-T03/T04); the EPCS architecture (`epcs/`, M12-T05); the DoseSpot adapter + webhook security
// (`client/`, `webhook/`, `credentials/`, M12-T06); the `MedicationOrderProvider`/`RefillInboxProvider`
// seam impls (`seams.ts`, M12-T07); the typed M36 alert builders (`alerts.ts`) + `m12.*` outbox payload
// assemblers (`outbox.ts`) (M12-T08).

export * from "./classes/catalog";
