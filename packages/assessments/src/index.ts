// @chartwarden/assessments — Module 9 (Clinical Assessments Suite) feature package.
//
// M9-T01 lands the domain layout + metadata: the per-scale `data` shapes (§4.3-pinned set), the
// SCALE_CATALOG metadata (§3.1 / §5.2 families / D3 licensing), the significant-change rule taxonomy
// (§2.4), and the seam wiring home (D7). The cross-module enum/seam/outbox CONTRACTS live in the leaf
// `@chartwarden/types` (`assessment.ts`).
//
// M9-T03 adds the pure domain logic the services compose: the §4.4 error catalog (`errors.ts`), the
// §2.2 entity lifecycle machines (`lifecycle.ts` — correction-of-record supersede, significant-change
// ack/escalate, date-derived license status), the §7.4 LPN-cosignature workflow (`cosign.ts`), and the
// server-authoritative scoring dispatch (`scoring.ts`) over the four representative scales the plan pins
// (PPS / FAST / PAINAD / ESAS-r). The seam implementations land in M9-T04; routes in M9-T05.

export * from "./scale-types";
export * from "./catalog";
export * from "./eligibility";
export * from "./significant-change";
export * from "./detector";
export * from "./alerts";
export * from "./seams";
export * from "./errors";
export * from "./lifecycle";
export * from "./cosign";
export * from "./scoring";
export type { ScaleScorer, ScaleScoreResult, AnyScaleScorer } from "./scales/scorer";
export { ppsScorer } from "./scales/pps";
export { fastScorer, FAST_STAGE_ORDER } from "./scales/fast";
export { painadScorer } from "./scales/painad";
export { esasrScorer } from "./scales/esas-r";
export {
  scaleDefinitions,
  scaleResponseDetail,
  type ScaleDefinition,
  type ScaleItemDefinition,
  type ScaleItemKind,
  type ScaleResponseDetail,
  type ScaleResponseItem,
} from "./scales/definitions";
