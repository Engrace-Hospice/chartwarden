// @wardenx/hope — Module 10 (HOPE Engine) feature package.
//
// M10-T01 lands the domain layout + metadata: the §2 RFA descriptor table (`rfa.ts`) and the seam
// wiring home (`seams.ts`, D10). The cross-module enum/seam/outbox/alert CONTRACTS live in the leaf
// `@wardenx/types` (`hope.ts`).
//
// M10-T03 adds the pure timepoint engine + SFV domain logic the recording/scheduling services compose:
// the org-TZ window calculator + schedule planner (`scheduling/`), the server-authoritative J2051 trigger
// (`triggers/`), the SFV creation/completion/watchdog machines (`sfv/`), and the recording-boundary
// guards — author-discipline (RN/NP-only) + capture-window/late-reason + the discharge Section-Q branch
// (`recording/`). Still pure, IO-free, `@wardenx/types`-only: the services that compose these over
// Drizzle + the M6/M9/M39 seams land in M10-T06; the iQIES submission workers in M10-T07.
//
// M10-T04 adds the CMS HOPE pre-submission validation engine: the required-items-per-RFA matrix
// (`sections/required-items.ts`), the `hope_validation_finding` descriptor + rule-id catalog
// (`validation/findings.ts`), the M38 value-set membership port (`validation/value-set-oracle.ts`), and
// the pure rule engine (`validation/validate-hope-assessment.ts`) that returns one finding per CMS
// violation (errors block iQIES submission; warnings are advisory). Still pure, `@wardenx/types`-only.

export * from "./rfa";
export * from "./seams";
export * from "./errors";
export * from "./scheduling/time";
export * from "./scheduling/alert-cadence";
export * from "./scheduling/window-calculator";
export * from "./scheduling/schedule-plan";
export * from "./triggers/j2051";
export * from "./sfv/sfv";
export * from "./recording/discipline";
export * from "./recording/timepoint-gate";
export * from "./sections/required-items";
export * from "./validation/findings";
export * from "./validation/value-set-oracle";
export * from "./validation/validate-hope-assessment";
export * from "./validation/assessment-input";
// M10-T06 — the §4.9 / §4.9.1 M36 typed-alert builders + the out-of-band PHI-strip projection.
export * from "./alerts";
