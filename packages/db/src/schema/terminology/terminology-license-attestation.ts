// @chartwarden/db — `terminology_license_attestation` (M38 licensing gate, GAP-108, migration 0364). A platform
// operator's attestation that the licence behind a non-public code system (UMLS/SNOMED, Regenstrief/LOINC,
// UMLS/RxNorm) is held. A load of such a system is refused without an active row; `attributionText` is the text
// the licence requires to accompany the data and is exposed with it. Platform-shared (NON_ORG_SCOPED), read-all
// for chartwarden_app, written only through the `terminology_loader` functions. Not PHI.
import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { codeSystemId } from "../../enums";
import { users } from "../users";
import { codeSystems } from "./code-systems";

export const terminologyLicenseAttestations = pgTable(
  "terminology_license_attestation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    systemId: codeSystemId("system_id")
      .notNull()
      .references(() => codeSystems.id, { onDelete: "restrict" }),
    licensee: text("licensee").notNull(),
    licenseReference: text("license_reference").notNull(),
    attestedBy: uuid("attested_by")
      .notNull()
      .references(() => users.id),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    attributionText: text("attribution_text").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySystemIdx: index("terminology_license_attestation_system_idx").on(
      t.systemId,
      t.effectiveFrom,
    ),
    datesChk: check(
      "terminology_license_attestation_dates_chk",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} >= ${t.effectiveFrom}`,
    ),
  }),
);

export type TerminologyLicenseAttestation = typeof terminologyLicenseAttestations.$inferSelect;
