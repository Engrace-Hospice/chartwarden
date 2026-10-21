// @chartwarden/dosespot — the pure medication-order-lifecycle domain (§2.2 D2 / §2.3, M12-T03).
//
// The IO-free state machine + the §2.3 verbal-order M11-seam consumption surface the M12 service layer
// (M12-T08) composes over the Drizzle write transaction, and the M12 routes/ABAC (M12-T08) and tests reuse.
// No DB, no Fastify, no cross-module schema import — `@chartwarden/types` + the local `MED_CLASS_CATALOG` only.
export * from "./errors";
export * from "./effects";
export * from "./medication-order-machine";
export * from "./verbal-medication-order";
