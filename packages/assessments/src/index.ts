// @wardenx/assessments — Module 9 (Clinical Assessments Suite) feature package.
//
// M9-T01 lands the domain layout + metadata: the per-scale `data` shapes (§4.3-pinned set), the
// SCALE_CATALOG metadata (§3.1 / §5.2 families / D3 licensing), the significant-change rule taxonomy
// (§2.4), and the seam wiring home (D7). The cross-module enum/seam/outbox CONTRACTS live in the leaf
// `@wardenx/types` (`assessment.ts`); per-scale `scales/<scale>/` scoring + the seam implementations
// land in M9-T03/T04.

export * from "./scale-types";
export * from "./catalog";
export * from "./significant-change";
export * from "./seams";
