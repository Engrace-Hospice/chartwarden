// @chartwarden/cost-report — M27 pure-domain barrel (§3.1 `src/domain/`). Re-exports the three shared
// kernels every Phase-2 worksheet, allocation, apportionment, settlement, validation, and snapshot file
// imports: the penny-exact money/ratio kernel (D8), the snapshot canonicalization + content hash (D10),
// and the cost-report lifecycle reducer (§2.2). PURE DOMAIN throughout — no Fastify, no Drizzle/DB, no
// BullMQ, no `@chartwarden/db`, no `getSeam`; no PHI (D18).
export * from "./money";
export * from "./snapshot";
export * from "./lifecycle";
