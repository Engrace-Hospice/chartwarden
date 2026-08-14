// @wardenx/inpatient — Module 37 (Inpatient Unit / IPU Management) domain package. The pure §2 kernels
// (XState machines, GIP validators, RN-coverage evaluator, IV-safety overlay builder, census builder),
// the §4.5/§4.11 seam interfaces' implementations, and the boot hook land here across M37-T03–T10. As of
// M37-T01 the package ships the §3.2 enum value mirrors (the anti-drift `satisfies` tuples over the
// packages/types leaf unions). DB-free and edge-light (only `@wardenx/types`).
export * from "./enums";
export * from "./errors";
export * from "./machines/ipu-bed";
export * from "./machines/ipu-admission";
export * from "./machines/irc-episode";
export * from "./machines/ipu-restraint";
export * from "./machines/ipu-body-release";
export * from "./domain/bed/room-occupancy";
export * from "./domain/visitor/restriction-evaluator";
export * from "./domain/equipment/inspection";
export * from "./domain/meal/intake";
export * from "./domain/census/bed-day-calculator";
export * from "./domain/census/snapshot-builder";
export * from "./ai-block";
export * from "./domain/gip-criteria/schema";
export * from "./domain/gip-criteria/validate";
export * from "./domain/iv-safety/titration-window-catalog";
export * from "./domain/iv-safety/overlay-builder";
export * from "./domain/rn-coverage/window-builder";
export * from "./domain/rn-coverage/horizon-evaluator";
export * from "./domain/rn-coverage/break-glass";
