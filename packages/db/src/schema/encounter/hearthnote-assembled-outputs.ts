// @wardenx/db — `hearthnote_assembled_output` (M8 §3.3). The assembled narrative for a finalize (primary
// or addendum): Layer-1 deterministic text, optional post-hardblock Layer-2 text, and the final signed
// bytes — all encrypted per-tenant DEK (crypto-erased on destruction, §3.6). PHI-bearing → three-column
// tenancy rule (denormalized from the parent encounter/addendum). Belongs to exactly one parent
// (encounter XOR addendum). RLS + the M4 write-audit trigger land in migration 0031 (M8-T03).
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { assembledOutputKind, layer2EligibilityReason } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { encounterAddenda } from "./encounter-addenda";
import { encounters } from "./encounters";

export const hearthnoteAssembledOutputs = pgTable(
  "hearthnote_assembled_output",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Nullable since 0226, mirroring 0128 (`encounter`) and 0225 (`hearthnote_selection`): a child that
    // denormalizes the parent's siting cannot require what the parent may not have — the draft route
    // captures neither, and the M6 admission may itself be unsited.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    encounterId: uuid("encounter_id").references(() => encounters.id, { onDelete: "cascade" }),
    addendumId: uuid("addendum_id").references(() => encounterAddenda.id, { onDelete: "cascade" }),

    kind: assembledOutputKind("kind").notNull(),
    layer1Cipher: text("layer1_cipher").notNull(), // encrypted: deterministic Layer-1 narrative
    layer2Cipher: text("layer2_cipher"), // encrypted: post-hardblock Layer-2 narrative (NULL if Layer-2 not used)
    finalCipher: text("final_cipher").notNull(), // the bytes that ARE the signed encounter narrative

    layer2Eligibility: layer2EligibilityReason("layer2_eligibility").notNull(),
    layer2InvolvedAtFinalize: boolean("layer2_involved_at_finalize").notNull().default(false),

    assemblyTemplateKey: text("assembly_template_key").notNull(),
    // Pinned per D11 — the parent's own pin, resolved once per finalize so the version the bytes were
    // assembled under cannot drift from the version the encounter claims (ADR-0046).
    vocabVersionId: uuid("vocab_version_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    encounterKindIdx: index("hearthnote_output_encounter_kind_idx").on(t.encounterId, t.kind),
    parentXor: check(
      "hearthnote_output_parent_xor",
      sql`(encounter_id IS NOT NULL) <> (addendum_id IS NOT NULL)`,
    ),
    layer2Consistency: check(
      "hearthnote_output_layer2_consistency",
      sql`(layer2_involved_at_finalize = false AND layer2_cipher IS NULL)
          OR (layer2_involved_at_finalize = true AND layer2_cipher IS NOT NULL)`,
    ),
  }),
);

export type HearthnoteAssembledOutput = typeof hearthnoteAssembledOutputs.$inferSelect;
export type NewHearthnoteAssembledOutput = typeof hearthnoteAssembledOutputs.$inferInsert;
