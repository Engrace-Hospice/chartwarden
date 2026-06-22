// @wardenx/orders — the pure order-lifecycle domain (§2.2 D2 / §2.5, M11-T03).
//
// The IO-free state machine + authoring / signing / cosign predicates the M11 service layer (M11-T06+)
// composes over the Drizzle write transaction, and the M11 routes/ABAC (M11-T06) and tests reuse. No DB,
// no Fastify, no cross-module schema import — `@wardenx/types` + the local `KIND_CATALOG` only.
export * from "./errors";
export * from "./effects";
export * from "./order-machine";
export * from "./discipline-can-order";
export * from "./signer-eligible";
export * from "./cosign-rules";
export * from "./time";
export * from "./verbal-window";
export * from "./standing-order";
