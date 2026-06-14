// FIXTURE — intentional violation: a PHI table with no organization_id / pe / location.
// Proves check-tenancy.ts goes RED (missing-organization_id + missing-pe-or-location).
import { pgTable, uuid } from "drizzle-orm/pg-core";

export const badTenancy = pgTable("bad_tenancy_fixture", {
  id: uuid("id").primaryKey(),
  patient_id: uuid("patient_id"),
})
