// @wardenx/ai-platform — Module 32 (AI Platform) domain core.
//
// The shared library half of M32 (the manifest's `packages/ai-platform` codePath); the REST routes,
// seam implementations and boot wiring live in `apps/backend/src/modules/32-ai-platform`. Everything
// here is PURE — no IO, no DB handle, no clock, no vendor SDK — so the governance rules can be tested
// as functions and reused by the worker sidecars without dragging a Fastify request along.
//
// THE VENDOR-ADAPTER MANDATE. `VENDOR_ADAPTERS['@anthropic-ai/sdk'] = 'packages/ai-platform'` in
// `architecture/module-manifest.ts` means this package is the ONLY place that import may appear
// (architecture §25.14; dependency-cruiser fails CI anywhere else). Same for the Ollama HTTP client and
// the ml-worker client when M32-T13/T14/T15 land them under `./backends/`. Nothing in T01 imports a
// vendor SDK — the shell is registry + governance, not inference.
//
// Layout (M32-T01 lays it out; later tasks fill it in):
//   · ./lifecycle   §2.2 — D2's eight-state governance FSM and the consumer posture each state implies
//   · ./inventory   §2.3/§2.4 — the backend and capability rows registered at lock time
//   · ./governance  §2.2/§3.2.3/§5.3/§5.4 — the lifecycle gate, calibration publication, tenant opt-in
//                   and clinician opt-out rules, plus the three of them composed (plan T03)
//   · ./schemas     §2.5 — per-capability TypeBox input/output schemas          (spec T07)
//   · ./seams       §4.2 — the twelve published seam contracts                  (plan T06)
//   · ./prompts     §4.5 — AIPromptRegistry (git resolution + content hash)     (plan T05)
//   · ./backends    §8.4 — the ModelBackend implementations + ZDR enforcement   (spec T13–T16)
//
// The TYPE surface (enum mirrors, table descriptors, the `capability_unavailable` envelope, the
// invocation context) lives in the leaf `@wardenx/types` `ai-platform.ts`, not here, so a consumer
// module can speak M32's contracts with no `dependsOn` edge (ADR-0005 D1).
export * from "./lifecycle";
export * from "./inventory";
export * from "./governance";
