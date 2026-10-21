// apps/backend/src/modules/16-bereavement/risk — the D3/D17 risk-scoring service layer (M16-T04).
//
//   • ./extract       §4.3.4 — the cross-module evidence gather (M15 `MswRiskFactorReader` + M9
//                     `ScaleSeriesProvider`, both through M1's registry), fail-SOFT to `unknown`
//   • ./score         §4.3.3 — evidence → derived vector → weighted tier → the D8 grief-screen promotion →
//                     the immutable `bereavement_risk_score` draft + its §2.6 side effects
//   • ./augmentation  D3 Layer 2 — the `ai.full` ladder in front of M32, and the merge that keeps the
//                     narrative structurally unable to move `rule_tier`
//
// The pure halves (weights, cutoffs, the `unknown`-aware scorer, the derivation, the ladder) live in
// `@chartwarden/bereavement/risk`; everything here is the IO shell and the persistence shape around them.
export * from "./extract";
export * from "./score";
export * from "./augmentation";
