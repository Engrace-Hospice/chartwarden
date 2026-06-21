// @wardenx/db — `hearthnote_llm_modification` (M8 §3.3). The provenance row for a Layer-2 LLM call against
// an assembled output: prompt/model identity, token + latency telemetry, the structured per-passage diff,
// hard-block/soft-warn counts, and the clinician's per-passage accept/edit/reject decisions. PHI-bearing
// → three-column tenancy rule (denormalized from the parent assembled output). RLS + the M4 write-audit
// trigger land in migration 0031 (M8-T03).
import { pgTable, index, integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { hearthnoteAssembledOutputs } from "./hearthnote-assembled-outputs";

export const hearthnoteLlmModifications = pgTable(
  "hearthnote_llm_modification",
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
    assembledOutputId: uuid("assembled_output_id")
      .notNull()
      .references(() => hearthnoteAssembledOutputs.id, { onDelete: "cascade" }),

    promptTemplateKey: text("prompt_template_key").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    modelId: text("model_id").notNull(),

    tokensInput: integer("tokens_input").notNull(),
    tokensOutput: integer("tokens_output").notNull(),
    latencyMs: integer("latency_ms").notNull(),

    diffJson: jsonb("diff_json").notNull(), // structured per-passage diff Layer1 vs Layer2-pre-hardblock
    hardBlockedCount: integer("hard_blocked_count").notNull().default(0),
    softWarnCount: integer("soft_warn_count").notNull().default(0),

    perPassageDecisions: jsonb("per_passage_decisions").notNull().default([]), // [{ passage_id, decision, edited_text?, ... }]

    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
    calledByMembershipId: uuid("called_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
  },
  (t) => ({
    outputIdx: index("hearthnote_llm_modification_output_idx").on(t.assembledOutputId),
    modelIdx: index("hearthnote_llm_modification_model_idx").on(t.modelId, t.calledAt),
  }),
);

export type HearthnoteLlmModification = typeof hearthnoteLlmModifications.$inferSelect;
export type NewHearthnoteLlmModification = typeof hearthnoteLlmModifications.$inferInsert;
