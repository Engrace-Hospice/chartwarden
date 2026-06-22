// @wardenx/orders — Module 11 (Orders) feature package.
//
// M11-T01 lands the domain layout + metadata: the §2.1 Order-Kind catalog (`catalog.ts`) and the seam
// wiring home (`seams.ts`, §2.8 D14 / §4.3). The cross-module enum/seam/outbox/alert CONTRACTS live in
// the leaf `@wardenx/types` (`orders.ts`).
//
// Later tasks add: the per-kind TypeBox `data` schemas + cross-field validators + terminology bindings
// (`kinds/<kind>/`, M11-T03+); the pure lifecycle / verbal-timer / standing-order machines + verbal-window
// math live in the `@wardenx/domain` leaf (`domain/orders/`, M11-T03/T04); the §4.9 M36 typed-alert
// builders (`alerts.ts`, M11-T07); the typed `m11.*` outbox payload assemblers (`outbox.ts`, M11-T07).

export * from "./catalog";
export * from "./seams";
