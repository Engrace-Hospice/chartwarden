// @wardenx/emar — Module 13 (eMAR & Med Administration) feature package.
//
// M13-T01 lands the domain layout + metadata: the §2.1 Administration-Mode catalog (`modes/catalog.ts`).
// The cross-module enum/seam/outbox/alert CONTRACTS live in the leaf `@wardenx/types` (`emar.ts`) so
// downstream consumers (M14/M21/M28/M30/M31/M33/M36) import them with no `dependsOn` edge.
//
// M13-T03 lands the pure (IO-free, `@wardenx/types`-only) administration domain: the §2.2 D6
// administration-record state machine + §2.5 D8 late-entry tier ladder (`lifecycle/`), the §2.3 D2
// scheduled-dose materializer (`schedule/`: `frequencyCode` → `ScheduleFrequency` → DST-aware scheduled-dose
// tuples), and the §5.11 five-rights validator (`five-rights/`, shared with the frontend banner). It lives
// HERE (the M13 feature package, the M11 `@wardenx/orders` / M12 `@wardenx/dosespot` precedent) rather than
// the `@wardenx/domain` leaf because it reads the local `ADMINISTRATION_MODE_CATALOG`. Later M13 tasks add
// the §2.4 D3 PRN reassessment rules + §2.6 D7 controlled-substance witness eligibility (M13-T04).

export * from "./modes/catalog";
export * from "./lifecycle";
export * from "./schedule";
export * from "./five-rights";
