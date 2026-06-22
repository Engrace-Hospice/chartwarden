// @wardenx/db — `administration_witness` (M13 §3.3 / §2.6 D7). The controlled-substance double-witness attestation
// for an administration_record: a structured attestation plus the sha256 digest of the burned witness token (§7.4).
// Org-scoped (no patient row — the parent administration_record carries the patient/PE/location); standard app.org_id
// RLS. Non-partitioned. administration_record is partitioned, so `administration_record_id` is plain uuid (no SQL FK);
// the 1:1 is enforced by a unique index. Witness refs go to M1 `membership`. RLS + grants + the M4 write-audit trigger
// land in the RLS migration.
import { pgTable, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { administrationWitnessKind, administrationWitnessesScope } from "../../enums";
import { organizations } from "../organizations";

export const administrationWitnesses = pgTable(
  "administration_witness",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    administrationRecordId: uuid("administration_record_id").notNull(), // 1:1 (loose; no FK — partitioned)

    witnessMembershipId: uuid("witness_membership_id").notNull(),
    witnessKind: administrationWitnessKind("witness_kind").notNull().default("co_present"),
    witnessesScope: administrationWitnessesScope("witnesses_scope").notNull(),

    attestationText: text("attestation_text").notNull(), // structured: "I attest I observed..."
    attestationTokenDigest: text("attestation_token_digest").notNull(), // sha256 of the burned witness token
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),

    // Reserved for Phase-2 telephonic witness.
    telephonicWitnessSessionId: uuid("telephonic_witness_session_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAdmin: uniqueIndex("admin_witness_admin_uk").on(t.administrationRecordId),
    byWitness: index("admin_witness_witness_idx").on(
      t.organizationId,
      t.witnessMembershipId,
      t.attestedAt.desc(),
    ),
  }),
);

export type AdministrationWitness = typeof administrationWitnesses.$inferSelect;
export type NewAdministrationWitness = typeof administrationWitnesses.$inferInsert;
