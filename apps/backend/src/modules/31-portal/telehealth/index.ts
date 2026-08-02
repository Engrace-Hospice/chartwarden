// apps/backend/src/modules/31-portal/telehealth — M31-T05. The §7.2–§7.4 / D8 / D9 / D14 telehealth domain
// core: the visit/room lifecycle state machine (§7.2 happy path + §7.3 aborted path), the D14 audio-only
// Tier-3 fallback planner, and the D9 two-party recording-consent gate over the §3.8 state matrix.
//
// Everything here is PURE — injected facts in, a next state / plan / verdict out. The live Daily.co adapter it
// pairs with lives in `@wardenx/telehealth-client` (M31-T05); the route + webhook wiring that executes these
// decisions inside a transaction lands in M31-T06/T07.
export * from "./errors";
export * from "./state-matrix";
export * from "./recording-consent";
export * from "./visit-lifecycle";
export * from "./fallback";
