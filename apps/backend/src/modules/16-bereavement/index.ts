// apps/backend/src/modules/16-bereavement — Module 16 (Bereavement).
//
// M16-T03 lands the §2.2–§2.6 lifecycle core (`lifecycle/`) and the seam-consuming layer (`consumers/`,
// `seams/`) that resolves the M6 death fact those machines decide over — the handshake that CLOSES M6's
// `m6.bereavement.eligible` outbox. Still to land: the D3/D17 risk extractor + the M32 Layer-2 augmentation
// adapter (M16-T04), the §4.6 published seams (M16-T05), the §4.1 routes with the §4.7 permission keys +
// §4.8 ABAC predicates + the §4.9 workers that execute these machines' side effects (M16-T06), and the §5
// screens (M16-T07).
export * from "./lifecycle/index";
export * from "./consumers/index";
export {
  getAdmissionStatusReader,
  getDeathDischargeReader,
  getPatientReader,
} from "./seams/index";
