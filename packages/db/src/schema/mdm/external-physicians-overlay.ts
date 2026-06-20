// @wardenx/db — `external_physician_tenant_overlay` (M40 MDM §3.4). The ORG-SCOPED overlay:
// this-tenant's opinion about a canonical physician (§2.3) — preferred contact, relationship
// notes, do-not-refer policy, preferred ranking, negotiated terms — exactly the fields whose
// answer drifts by who you ask, so they cannot be canonical. One overlay row per (physician,
// org); references the canonical `external_physician` and the tenant's `organization`. This is
// the only Phase-1 overlay table (facility/payer have none yet). Standard app.org_id RLS + the
// M4 write-audit trigger land in M40-T03 (§3.6–3.7). Not a PHI table by the three-column rule —
// it carries only references + tenant preferences, no patient field — so provider_entity_id /
// location_id do not apply.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";
import { externalPhysicians } from "./external-physicians";

export const externalPhysicianOverlay = pgTable(
  "external_physician_tenant_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    externalPhysicianId: uuid("external_physician_id")
      .notNull()
      .references(() => externalPhysicians.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    preferredContactPhone: text("preferred_contact_phone"),
    preferredContactEmail: text("preferred_contact_email"),
    relationshipNotes: text("relationship_notes"),
    doNotRefer: boolean("do_not_refer").notNull().default(false),
    isPreferred: boolean("is_preferred").notNull().default(false),
    preferredRank: integer("preferred_rank"),
    contractTerms: jsonb("contract_terms"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneOverlayPerOrg: uniqueIndex("external_physician_overlay_unique").on(
      t.externalPhysicianId,
      t.organizationId,
    ),
    orgIdx: index("external_physician_overlay_org_idx").on(t.organizationId),
  }),
);

export type ExternalPhysicianOverlay = typeof externalPhysicianOverlay.$inferSelect;
export type NewExternalPhysicianOverlay = typeof externalPhysicianOverlay.$inferInsert;
