// @wardenx/db — foundation helper (M1). Exposes the Drizzle schema surface (TYPES are
// universally importable per ADR-0005 D4; cross-module table ACCESS is still blocked by
// check-table-ownership.ts). Phase 0: schema barrel is empty (no tables yet).
export * as schema from "./schema/index";
