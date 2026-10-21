// @chartwarden/db — `mdm_license_record` (M40 MDM §3.5, §4.1 `POST /mdm/license/manual`, D6). A tenant's manual
// entry of a state license + expiration for a canonical entity (Phase 1: manual entry only — the per-state
// medical-board adapters are Phase 2). ORG-SCOPED (each tenant records its own verification), keyed by
// (org, entity_kind, canonical_id, license_state). Drives the §4.3 `mdm.license_expiration_scan` alerts.
// Standard app.org_id RLS + the M4 write-audit trigger land in migration 0473. Not PHI (no patient field),
// so provider_entity_id / location_id do not apply.
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { mdmEntityKind } from "../../enums";
import { organizations } from "../organizations";

export const mdmLicenseRecords = pgTable(
  "mdm_license_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entityKind: mdmEntityKind("entity_kind").notNull(),
    canonicalId: uuid("canonical_id").notNull(),
    licenseState: text("license_state").notNull(), // two-letter USPS code; CHECKed in SQL
    expiresOn: date("expires_on").notNull(),
    enteredBy: uuid("entered_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerOrgEntityState: uniqueIndex("mdm_license_unique").on(
      t.organizationId,
      t.entityKind,
      t.canonicalId,
      t.licenseState,
    ),
    expiresIdx: index("mdm_license_expires_idx").on(t.expiresOn),
  }),
);

export type MdmLicenseRecord = typeof mdmLicenseRecords.$inferSelect;
export type NewMdmLicenseRecord = typeof mdmLicenseRecords.$inferInsert;
