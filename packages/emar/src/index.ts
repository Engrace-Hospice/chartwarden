// @wardenx/emar — Module 13 (eMAR & Med Administration) feature package.
//
// M13-T01 lands the domain layout + metadata: the §2.1 Administration-Mode catalog (`modes/catalog.ts`).
// The cross-module enum/seam/outbox/alert CONTRACTS live in the leaf `@wardenx/types` (`emar.ts`) so
// downstream consumers (M14/M21/M28/M30/M31/M33/M36) import them with no `dependsOn` edge.
//
// Later M13 tasks fill this package with the pure (IO-free, `@wardenx/types`-only) domain: the §2.2 D6
// administration-record state machine + per-mode validators (M13-T03), the §2.3 D2 `schedule-parser`
// (sigStructured.frequency → scheduled-dose tuples, DST-aware) (M13-T03), the §5.11 five-rights validator
// (M13-T03), the §2.4 D3 PRN reassessment rules (M13-T04), and the §2.6 D7 controlled-substance witness
// eligibility logic (M13-T04). It lives HERE (the M13 feature package, the M11 `@wardenx/orders` / M12
// `@wardenx/dosespot` precedent) rather than the `@wardenx/domain` leaf because it reads the local
// `ADMINISTRATION_MODE_CATALOG`.

export * from "./modes/catalog";
