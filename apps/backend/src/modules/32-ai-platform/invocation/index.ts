// apps/backend/src/modules/32-ai-platform/invocation — the §4.1 `aiSdk.invoke` pipeline (M32-T04).
//
//   · ./store          the four data ports + the in-memory implementation
//   · ./store-drizzle  their Drizzle implementations, under the §3.3 credential split
//   · ./service        the pipeline itself, over `@chartwarden/ai-platform`'s pure gate/route/cap rules
//
// No routes and no seams: §4.1's REST catalog is M32-T07's and the §4.2 published seams are M32-T06's.
// This is the function they will both call.
export * from "./store";
export * from "./store-drizzle";
export * from "./service";
