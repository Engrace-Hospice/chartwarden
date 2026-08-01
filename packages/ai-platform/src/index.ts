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
// the ml-worker client when M32-T13/T14/T15 land them under `./backends/`. M32-T04 gives the mandate its
// address — `./backends/anthropic.ts`, the one file that will ever hold the import — but installs no
// vendor SDK: `ai.full` is off for the whole wave, so nothing here dispatches to a model, and a
// dependency added for code that cannot execute is supply-chain surface with no function.
//
// Layout (M32-T01 lays it out; later tasks fill it in):
//   · ./lifecycle   §2.2 — D2's eight-state governance FSM and the consumer posture each state implies
//   · ./inventory   §2.3/§2.4 — the backend and capability rows registered at lock time
//   · ./governance  §2.2/§3.2.3/§5.3/§5.4 — the lifecycle gate, calibration publication, tenant opt-in
//                   and clinician opt-out rules, plus the three of them composed (plan T03)
//   · ./invocation  §6/§4.1 — the SDK gate order, W8 routing, the W2 token cap  (plan T04)
//   · ./backends    §8.4 — the ModelBackend port + the Anthropic ZDR invariant  (plan T04)
//   · ./safety      §3.2.10/§3.2.11/§3.2.12 — W3's kill switch, W5's hallucination triage,
//                   §3.2.11's evaluation runs and D10's evidence check           (plan T05)
//   · ./prompts     §4.5 — AIPromptRegistry (D18 prefix query + content hash)    (plan T05)
//   · ./schemas     §2.5 — per-capability TypeBox input/output schemas          (spec T07)
//   · ./seams       §4.2 — the published seam contracts + D18's zone registry   (plan T06)
//
// The TYPE surface (enum mirrors, table descriptors, the `capability_unavailable` envelope, the
// invocation context) lives in the leaf `@wardenx/types` `ai-platform.ts`, not here, so a consumer
// module can speak M32's contracts with no `dependsOn` edge (ADR-0005 D1).
export * from "./lifecycle";
export * from "./inventory";
export * from "./governance";
export * from "./invocation";
export * from "./backends";
export * from "./safety";
export * from "./prompts";
export * from "./seams";
