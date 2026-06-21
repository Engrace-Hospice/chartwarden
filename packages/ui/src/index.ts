// @wardenx/ui — shared UI surface delivered by M1 (Foundation §5.1–5.2; M1-T11). Module 1 has
// no screens of its own; it provides the cross-module UI surface every other module consumes.
//
// ADR-0035 carves this leaf into two internal layers, kept apart by dependency-cruiser
// (`ui-core-renderer-free`):
//   ./core — react-dom-free: typed API client, context providers, hooks, theme tokens, and the
//            native-capability ports. Usable by the web build, the Capacitor native build, and a
//            future React Native consumer.
//   ./web  — the React DOM rendering layer: presentational components + the layout kit.
//
// Consumers import from "@wardenx/ui" (this barrel) and need not know the split. `core` and
// `web` export disjoint names, so a flat re-export is unambiguous.
export * from "./core";
export * from "./web";
