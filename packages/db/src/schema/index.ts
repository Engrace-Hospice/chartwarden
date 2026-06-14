// @wardenx/db — Drizzle schema BARREL (M1-owned, the central multi-tenant PostgreSQL
// schema surface). Phase 0 is structure-only: NO tables yet (acceptance #8). Each
// module adds its `ownedTables` here in Phase 1 as `export const x = pgTable('x', …)`,
// and check-table-ownership.ts / check-tenancy.ts / check-ddl-legality.ts begin
// enforcing the moment a table lands. Until then this barrel is an empty re-export so
// drizzle-kit and the fitness scans run against a real (empty) schema surface.
//
// Example shape Phase 1 will follow (left as a comment so the barrel stays empty):
//   import { pgTable, uuid, text } from "drizzle-orm/pg-core";
//   export const organization = pgTable("organization", {
//     id: uuid("id").primaryKey().defaultRandom(),
//     // ...
//   });

export {};
