// @wardenx/quality — M30 §2.2 / D9 mortality_review domain subtree (P2a). PURE.
//
// Public surface of the mortality-review domain: the D9 three-dimension form structure + completeness
// predicates (./dimensions), the §2.2 lifecycle machine + its failure-code catalog (./machine), and the
// §4.12 / §7.13 auto-creation from `m6.discharge.death` with the W-M30-27 deferred-clock and W-M30-28
// Part 2 promotion descriptors (./auto_creator). No Fastify, no DB, no IO.
export * from "./dimensions";
export * from "./machine";
export * from "./auto_creator";
