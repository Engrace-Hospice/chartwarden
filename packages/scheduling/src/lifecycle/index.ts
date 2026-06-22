// @wardenx/scheduling — the pure scheduling-lifecycle domain (§2.2 / §2.3 / §7.7, M17-T03).
//
// The IO-free state machines + materializer the M17 service layer (M17-T07) composes over the Drizzle write
// transaction, and the M17 routes/ABAC + tests reuse: the §2.2.1 visit machine + `visit_state_history`
// append, the §2.2.6 time_off machine, the §2.2.5 availability validator, and the §2.2.3 / §7.7 RRULE
// materializer + discontinuation planner. No DB, no Fastify, no cross-module schema import —
// `@wardenx/types` + the local `@wardenx/scheduling` policy/rrule constants only.
export * from "./errors";
export * from "./effects";
export * from "./time";
export * from "./reason-floors";
export * from "./visit-machine";
export * from "./time-off-machine";
export * from "./availability";
export * from "./recurrence";
