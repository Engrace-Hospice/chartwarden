// @wardenx/db — `bereavement_contact_log` (M16 §3.3.5). D1's leaf: what ACTUALLY happened on a touchpoint.
// One outreach can produce many logs (one anniversary letter, five addressees, one shared M22 document), so
// this is the only M16 table that grows with volume rather than with headcount.
//
// D12 / §3.6: the ONE partitioned M16 table — monthly PARTITION BY RANGE (contact_at), the M4 convention.
// The composite PRIMARY KEY (id, contact_at) is declared in migration 0101 (Drizzle cannot express a
// partitioned table, so the `.primaryKey()` below is the ORM's view of the row identity only); the M1
// partition manager rotates forward months. Retention runs at the partition level (§3.6).
//
// D15 M8 BOUNDARY — the reason for the CHECK pair below: an in-person bereavement visit is an M8 encounter
// and its log MUST carry `source_encounter_id`; every other modality (phone, card, letter, email, portal
// message) is a direct M16 write and MUST leave it NULL. Both directions are enforced, because only
// enforcing one lets a mis-routed letter silently acquire an encounter id and double-count in M8.
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, denormalized from the plan.
// RLS + grants are declared on the PARENT and propagate to every partition (PG11+, the M25/M30 precedent).
// CROSS-MODULE FK POLICY: org/PE/location + the intra-M16 plan / contact / outreach parents carry real FKs
// (all three parents are unpartitioned, so a partitioned child may reference them). source_encounter_id
// (M8), artifact_document_id (M22), logged_by_user_id (M2 membership) and external_resource_id_from_m40
// (M40) are LOGICAL uuid, app-validated at the write boundary.
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { bereavementContactLogOutcome, bereavementOutreachKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavedContact } from "./bereaved-contacts";
import { bereavementOutreach } from "./bereavement-outreach";
import { bereavementPlan } from "./bereavement-plans";

export const bereavementContactLog = pgTable(
  "bereavement_contact_log",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, contact_at) declared in SQL (0101)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => bereavementPlan.id, { onDelete: "restrict" }),
    bereavedContactId: uuid("bereaved_contact_id")
      .notNull()
      .references(() => bereavedContact.id, { onDelete: "restrict" }),
    outreachId: uuid("outreach_id")
      .notNull()
      .references(() => bereavementOutreach.id, { onDelete: "restrict" }),

    contactAt: timestamp("contact_at", { withTimezone: true }).notNull(), // PARTITION KEY
    kind: bereavementOutreachKind("kind").notNull(),
    outcome: bereavementContactLogOutcome("outcome").notNull(),

    // D15 — populated iff kind = 'in_person_visit'; the M8 `bereavement_contact` encounter that owns the
    // clinical narrative. M16 never stores that narrative; it stores the pointer.
    sourceEncounterId: uuid("source_encounter_id"),

    // Free-text touchpoint note — DEK envelope-encrypted, and D11-denylisted out of the audit capture.
    contactNotesCipher: text("contact_notes_cipher"),

    artifactDocumentId: uuid("artifact_document_id"), // logical FK → M22 document (the letter/card sent)

    loggedByUserId: uuid("logged_by_user_id").notNull(), // logical FK → M2 membership
    loggedByDiscipline: text("logged_by_discipline"), // M40 discipline value AT LOG TIME (frozen, not resolved)

    // Whether the bereaved person actually engaged on this touchpoint — the §2.3 three-strikes
    // `markUnreachable` detector counts on this plus `outcome`.
    contactRespondedDirectly: boolean("contact_responded_directly").notNull().default(false),

    externalResourceIdFromM40: uuid("external_resource_id_from_m40"), // kind = 'external_referral'

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planContactIdx: index("berv_log_plan_contact_idx").on(
      t.planId,
      t.bereavedContactId,
      t.contactAt,
    ),
    outreachIdx: index("berv_log_outreach_idx").on(t.outreachId),
    loggedByIdx: index("berv_log_logged_by_idx").on(t.loggedByUserId, t.contactAt),
    encounterIdx: index("berv_log_encounter_idx")
      .on(t.sourceEncounterId)
      .where(sql`source_encounter_id IS NOT NULL`),

    inPersonRequiresEncounter: check(
      "berv_log_in_person_requires_encounter",
      sql`kind <> 'in_person_visit' OR source_encounter_id IS NOT NULL`,
    ),
    nonEncounterKindsHaveNoEncounter: check(
      "berv_log_non_encounter_kinds_no_encounter",
      sql`kind = 'in_person_visit' OR source_encounter_id IS NULL`,
    ),
  }),
);

export type BereavementContactLogRow = typeof bereavementContactLog.$inferSelect;
export type NewBereavementContactLogRow = typeof bereavementContactLog.$inferInsert;
