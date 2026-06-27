// @wardenx/quality — M30 §2.2 / D8 incident_report domain subtree (P2a). PURE.
//
// Public surface of the incident domain: the §2.3 kind catalog + per-kind required-field rules
// (./kinds), the §10 mandatory external-report determination (./mandatory_reporter), the §2.2 lifecycle
// machine + its failure-code catalog (./machine), and the §4.10 auto-incident creation from upstream
// events (./auto_creator). No Fastify, no DB, no IO — these are pure functions, types, and constants.
export * from "./kinds";
export * from "./mandatory_reporter";
export * from "./machine";
export * from "./auto_creator";
