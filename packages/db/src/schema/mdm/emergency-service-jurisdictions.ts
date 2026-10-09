// @wardenx/db - `emergency_service_jurisdiction` (M40; migration 0901, GAP-032). The TENANT-CURATED PSAP catalog
// behind M20's SOS-terminus `surface_psap_number` effect. organization_id NOT NULL, RLS on app.org_id, no PHI
// (a PSAP administrative line is public). A row retires with `is_active = false`, never deleted. `polygon` holds
// GeoJSON-style rings (`[[[lng,lat], ...], ...]`), same shape as `safety_high_risk_area.polygon`.
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";

export const EMERGENCY_SERVICE_JURISDICTION_SOURCES = ["tenant_entered", "platform_seed"] as const;

export const emergencyServiceJurisdictions = pgTable(
  "emergency_service_jurisdiction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    state: char("state", { length: 2 }).notNull(),
    countyFips: char("county_fips", { length: 5 }),
    polygon: jsonb("polygon").$type<readonly (readonly (readonly [number, number])[])[]>(),
    psapName: text("psap_name").notNull(),
    psapPhone: text("psap_phone").notNull(),
    secondaryPhone: text("secondary_phone"),
    appliesToLocationId: uuid("applies_to_location_id").references(() => locations.id, {
      onDelete: "restrict",
    }),
    isOrgDefault: boolean("is_org_default").notNull().default(false),
    source: text("source")
      .$type<(typeof EMERGENCY_SERVICE_JURISDICTION_SOURCES)[number]>()
      .notNull()
      .default("tenant_entered"),
    sourceRef: text("source_ref"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    verifyEveryDays: integer("verify_every_days").notNull().default(180),
    isActive: boolean("is_active").notNull().default(true),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("esj_org_idx").on(t.organizationId, t.isActive, t.name),
    locationIdx: index("esj_location_idx")
      .on(t.appliesToLocationId)
      .where(sql`applies_to_location_id IS NOT NULL`),
    orgDefaultUq: uniqueIndex("esj_org_default_uq")
      .on(t.organizationId)
      .where(sql`is_org_default AND is_active`),
    locationDefaultUq: uniqueIndex("esj_location_default_uq")
      .on(t.organizationId, t.appliesToLocationId)
      .where(sql`applies_to_location_id IS NOT NULL AND polygon IS NULL AND is_active`),
  }),
);

export type EmergencyServiceJurisdictionRow = typeof emergencyServiceJurisdictions.$inferSelect;
export type NewEmergencyServiceJurisdictionRow = typeof emergencyServiceJurisdictions.$inferInsert;
