// apps/backend/src/modules/22-documents/domain/index.ts — M22-T03 barrel.
//
// The pure M22 document-lifecycle domain (§2.2.1, §2.2.2, §2.3, §2.4): the aggregate state machine
// (create / add-version / legal-hold apply+release / tombstone), the §2.2.2 append-only version-ledger guards,
// the §2.3 retention-class consistency rules + D9 intake-artifact promotion + D12 destruction policy, the §3.3
// D1 per-tenant MinIO key model + §7.10 D11 opaque presigned-URL leaf, the §2.4 / §164.528 signed-URL TTL clamp
// + access-log effects, the §2.4 patient-merge redirect resolver, the §2.3 error catalog, and the §2.4
// side-effect descriptors. All IO-/clock-/DB-free; the service/route layer (M22-T07) wires the M5/M40 reader
// seams + executes the effects in one tx.
export * from "./errors";
export * from "./effects";
export * from "./object-storage";
export * from "./retention";
export * from "./access-log";
export * from "./patient-redirect";
export * from "./document-lifecycle";
