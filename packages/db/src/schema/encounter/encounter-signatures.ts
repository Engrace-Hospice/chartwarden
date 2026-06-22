// @wardenx/db — `encounter_signature` (M8 §3.3). One row per signature slot (primary / cosignature /
// addendum) on an encounter, with the D13 step-up provenance (method + session + fresh step-up). PHI-
// bearing → three-column tenancy rule (denormalized from the parent encounter). Partial unique indexes
// enforce one primary + one cosignature per encounter. RLS + the M4 write-audit trigger land in
// migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { encounterDiscipline, signatureKind, signatureMethod } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounterAddenda } from "./encounter-addenda";
import { encounters } from "./encounters";

export const encounterSignatures = pgTable(
  "encounter_signature",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id")
      .notNull()
      .references(() => encounters.id, { onDelete: "restrict" }),
    addendumId: uuid("addendum_id").references(() => encounterAddenda.id, {
      onDelete: "restrict",
    }),

    kind: signatureKind("kind").notNull(),
    signedByMembershipId: uuid("signed_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    signedByDiscipline: encounterDiscipline("signed_by_discipline").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),

    method: signatureMethod("method").notNull(),
    sessionId: uuid("session_id").notNull(), // M2 session id at time of sign
    stepUpAuthAt: timestamp("step_up_auth_at", { withTimezone: true }).notNull(), // within 5 minutes of signed_at (D13)

    attestationText: text("attestation_text").notNull(), // the exact attestation language presented
    layer2InvolvedAtSigning: boolean("layer2_involved_at_signing").notNull(), // governs which attestation was shown

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    encounterKindIdx: index("encounter_signature_encounter_kind_idx").on(t.encounterId, t.kind),
    uniquePrimary: uniqueIndex("encounter_signature_unique_primary_idx")
      .on(t.encounterId)
      .where(sql`kind = 'primary'`),
    uniqueCosig: uniqueIndex("encounter_signature_unique_cosig_idx")
      .on(t.encounterId)
      .where(sql`kind = 'cosignature'`),
    stepUpFresh: check(
      "encounter_signature_step_up_fresh",
      sql`step_up_auth_at >= signed_at - interval '5 minutes'`,
    ),
    addendumWhenAddendumKind: check(
      "encounter_signature_addendum_when_addendum_kind",
      sql`(kind <> 'addendum') OR (addendum_id IS NOT NULL)`,
    ),
    attestationLen: check(
      "encounter_signature_attestation_len",
      sql`char_length(attestation_text) >= 50`,
    ),
  }),
);

export type EncounterSignature = typeof encounterSignatures.$inferSelect;
export type NewEncounterSignature = typeof encounterSignatures.$inferInsert;
