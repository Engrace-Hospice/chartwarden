// @wardenx/hope — Module 10 (HOPE Engine) feature package.
//
// M10-T01 lands the domain layout + metadata: the §2 RFA descriptor table (`rfa.ts`) and the seam
// wiring home (`seams.ts`, D10). The cross-module enum/seam/outbox/alert CONTRACTS live in the leaf
// `@wardenx/types` (`hope.ts`).
//
// Later M10 tasks add the pure domain logic the services compose: the timepoint window calculator +
// scheduling (M10-T03), the per-section TypeBox `data` shapes + the server-authoritative J2051 evaluator
// (`sections/`), the CMS pre-submission validation (`validation/`), the M36 alert builders (M10-T06),
// and the iQIES submission workers (M10-T07). The seam implementations + their M1-registry wiring land
// in M10-T05; routes in M10-T06.

export * from "./rfa";
export * from "./seams";
