// apps/backend/src/modules/08-encounters/authoring — M8-T10 (§2.2 vitals/mileage authoring, §7.4 F2F).
//
// The pure authoring machines the route service composes: vitals capture (numeric envelopes + BMI +
// abnormal-flag derivation), per-encounter mileage (D10 authoritative number), and the MD/NP F2F
// dual-write coordination (§7.4, D1) that pairs the M8 sign with the M6 attestation write request. All
// pure: no IO, no cross-module schema import; the service persists rows and runs the declared §2.8
// effects inside the encounter's optimistic-locked transaction.
export * from "./vitals";
export * from "./mileage";
export * from "./f2f";
