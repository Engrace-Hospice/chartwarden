// FIXTURE — intentional violation: same enum name defined twice (same kind).
// Proves check-ddl-legality.ts goes RED (duplicate-enum).
import { pgEnum } from "drizzle-orm/pg-core";
export const statusA = pgEnum("dup_status_fixture", ["a", "b"]);
export const statusB = pgEnum("dup_status_fixture", ["c", "d"]);
