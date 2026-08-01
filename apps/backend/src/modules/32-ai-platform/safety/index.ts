// apps/backend/src/modules/32-ai-platform/safety — W3's kill switch, W5's hallucination workflow and
// §3.2.11's evaluation runs (M32-T05).
//
//   · ./store          the three data ports + the in-memory implementation
//   · ./store-drizzle  their Drizzle implementations, under the §3.3 credential split (the kill switch
//                      is M32's only mixed-scope table and the only bypass marked `crossTenant: true`)
//   · ./service        the commands, over `@wardenx/ai-platform`'s pure safety rules — including
//                      `createAiKillSwitchGate`, the binding M32-T04 declared REQUIRED and left unfilled
//
// No routes, no outbox publishes and no M36 alerts: §4.1's REST catalog, §4.11's events and §4.9's
// alerts are all M32-T07's. Every command here RETURNS the plan those will emit from.
export * from "./store";
export * from "./store-drizzle";
export * from "./service";
