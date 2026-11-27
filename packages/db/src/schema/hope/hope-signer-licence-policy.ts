// @chartwarden/db — `hope_signer_licence_policy` (M10, migration 1587, CW-AC-46). A tenant's enforcement mode for the signer-licence
// check at HOPE signing: `enforce` refuses a signer with no active licence in the record's discipline, `shadow` lets the signature
// through and records the would-be refusal as an audit finding. One row per organization; an absent row means `enforce`, applied in
// code (compliant by default). Running in `shadow` requires a reason (20-200 characters), kept on the row while shadowed and cleared
// on the return to `enforce`; the migration's CHECK is the last line behind the service's validation. Org-level configuration with
// no patient and no PHI: organization_id only (like documentation_obligation_policy). RLS, grants and the audit trigger are in 1587.
import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { hopeSignerLicenceMode } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";

export const hopeSignerLicencePolicies = pgTable(
  "hope_signer_licence_policy",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "restrict" }),
    mode: hopeSignerLicenceMode("mode").notNull().default("enforce"),
    shadowReason: text("shadow_reason"),
    configuredByUserId: uuid("configured_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reasonRule: check(
      "hope_signer_licence_policy_reason",
      // `IS NOT NULL` is explicit: a CHECK that evaluates to NULL PASSES, so without it shadow with no reason at all would get in.
      sql`(${t.mode} = 'enforce' AND ${t.shadowReason} IS NULL) OR (${t.mode} = 'shadow' AND ${t.shadowReason} IS NOT NULL AND char_length(btrim(${t.shadowReason})) BETWEEN 20 AND 200 AND char_length(${t.shadowReason}) <= 200)`,
    ),
  }),
);

export type HopeSignerLicencePolicyRow = typeof hopeSignerLicencePolicies.$inferSelect;
export type NewHopeSignerLicencePolicyRow = typeof hopeSignerLicencePolicies.$inferInsert;
