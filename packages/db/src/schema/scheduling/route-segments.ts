// @chartwarden/db — `route_segment` (M17 §3.3 / D10). One row per leg of an optimized clinician day-route: the
// from/to anchor-or-visit endpoints, the proposed drive minutes + mileage (tenths-of-mile integer), and the
// OSRM-encoded polyline. Mileage here is a PROPOSAL — M8 (Encounters) is authoritative for billable mileage
// (D10). The `polyline` reveals patient locations → registered as PHI-bearing in the eraser (§3.7) and
// DENYLISTED in audit (§3.6 — also for storage savings). Clinician+date-scoped (no patient_id column) →
// org-scoped; the M17-F01 tenancy columns are carried (nullable — a route spans locations). from/to visit
// refs are plain uuid (parent `visit` is partitioned → no SQL FK, D14). Not partitioned (bounded by visit,
// D14). RLS + grants + the M4 write-audit trigger land in M17-T02.
import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const routeSegment = pgTable(
  "route_segment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // M17-F01: tenancy columns present; nullable (a day-route spans care locations).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    serviceDate: date("service_date").notNull(),

    sequenceIndex: integer("sequence_index").notNull(), // 0..N within the day
    fromKind: text("from_kind").notNull(), // 'anchor' | 'visit'
    fromVisitId: uuid("from_visit_id"), // partitioned visit → no SQL FK
    fromAnchorLocationId: uuid("from_anchor_location_id"),
    toKind: text("to_kind").notNull(),
    toVisitId: uuid("to_visit_id"), // partitioned visit → no SQL FK
    toAnchorLocationId: uuid("to_anchor_location_id"),

    proposedDriveMinutes: integer("proposed_drive_minutes").notNull(),
    proposedMiles: integer("proposed_miles").notNull(), // tenths-of-mile integer
    polyline: text("polyline"), // OSRM-encoded — DENYLISTED (§3.6); PHI-bearing (§3.7 eraser)
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    optimizerVersion: text("optimizer_version").notNull(),

    version: integer("version").notNull().default(0),
  },
  (t) => ({
    // Idempotency: one route_segment per (membership, service_date, sequence_index).
    membershipDaySeq: uniqueIndex("rs_membership_day_seq_uidx").on(
      t.membershipId,
      t.serviceDate,
      t.sequenceIndex,
    ),
  }),
);

export type RouteSegment = typeof routeSegment.$inferSelect;
export type NewRouteSegment = typeof routeSegment.$inferInsert;
