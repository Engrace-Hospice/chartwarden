// @wardenx/cost-report — M27 deterministic cost-allocation barrel (§3.1 `src/allocation/`, D8). Re-exports
// the four pure, penny-true propagation hops of the CMS-1984-14 chain (A → B → C → D → E-1): the
// Worksheet B step-down (`step-down`), the Worksheet C ancillary ratio-of-cost-to-charges
// (`ancillary-apportionment`), the Worksheet D program apportionment by patient days
// (`program-apportionment`), and the Worksheet E-1 settlement (`settlement`). Every export is a type or a
// deterministic total function over an already-fetched input; all money is INTEGER CENTS at the boundary
// and the only fractional arithmetic is inside the money kernel. Plus the PURE DB→input assembler
// (`assemble-inputs`) that shapes the read worksheet/statistics/cap state into the four inputs above.
// PURE DOMAIN — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`; no PHI (D18).
export * from "./step-down";
export * from "./ancillary-apportionment";
export * from "./program-apportionment";
export * from "./settlement";
export * from "./assemble-inputs";
export * from "./to-worksheets";
