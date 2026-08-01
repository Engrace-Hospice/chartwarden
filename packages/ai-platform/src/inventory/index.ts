// @wardenx/ai-platform — §2.3/§2.4 Phase-1 registry inventory (M32-T01).
//
//   · ./backends      the eight `ai_model_backend` rows §2.3 registers at lock time (D1)
//   · ./capabilities  the seventeen `ai_capability` rows §2.4 registers, plus the gap list where the
//                     spec does not determine a NOT-NULL value
//
// Both are PURE DATA read by spec T55/T56 (seeding), the D4 routing config, and the health sweep.
export * from "./backends";
export * from "./capabilities";
