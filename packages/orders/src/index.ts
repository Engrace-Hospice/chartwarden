// @wardenx/orders — Module 11 (Orders) feature package.
//
// M11-T01 lands the domain layout + metadata: the §2.1 Order-Kind catalog (`catalog.ts`) and the seam
// wiring home (`seams.ts`, §2.8 D14 / §4.3). The cross-module enum/seam/outbox/alert CONTRACTS live in
// the leaf `@wardenx/types` (`orders.ts`).
//
// M11-T03 lands the pure order-lifecycle domain (`lifecycle/`): the §2.2 D2 state machine + the §2.1/§2.2
// `disciplineCanOrder` / `signerEligible` predicates + the §2.5 cosignature rules. It lives HERE (the M11
// feature package, the M9/M10 `@wardenx/assessments` / `@wardenx/hope` precedent) rather than the
// `@wardenx/domain` leaf because it reads the local `KIND_CATALOG` — a feature-package dependency the pure
// floor must not take on (the dependency-cruiser `domain-is-pure` direction). IO-free, `@wardenx/types`-only.
//
// Later tasks add: the per-kind TypeBox `data` schemas + cross-field validators + terminology bindings
// (`kinds/<kind>/`, M11-T06); the verbal-window / standing-order math (M11-T04); the §4.9 M36 typed-alert
// builders (`alerts.ts`, M11-T07); the typed `m11.*` outbox payload assemblers (`outbox.ts`, M11-T07).

export * from "./catalog";
export * from "./seams";
export * from "./lifecycle";
