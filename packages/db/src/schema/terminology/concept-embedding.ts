// @chartwarden/db — `concept_embedding` (M38 Terminology §3.6, §7.7). HNSW pgvector index over
// 384-dim concept embeddings (BGE-small-en-v1.5), refreshed on version load. Backs semantic
// search — which rides the `ai.full` flag (Phase 2, default OFF): the TABLE is built now,
// the endpoint stays flag-gated (M38-T09). Requires the `vector` extension (enabled in the
// M38-T03 migration, §9.2). Platform-shared reference (NON_ORG_SCOPED); writes only via
// `terminology_loader`. Not PHI.
import { sql } from "drizzle-orm";
import { index, pgTable, primaryKey, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";
import { codeSystemId } from "../../enums";
import { codeSystemVersions } from "./code-system-versions";

export const conceptEmbedding = pgTable(
  "concept_embedding",
  {
    systemId: codeSystemId("system_id").notNull(),
    code: text("code").notNull(),
    asofVersion: uuid("asof_version")
      .notNull()
      .references(() => codeSystemVersions.id),
    embedding: vector("embedding", { dimensions: 384 }).notNull(), // BGE-small-en-v1.5
    modelId: text("model_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.systemId, t.code, t.asofVersion] }),
    hnswIdx: index("concept_embedding_hnsw_idx")
      .using("hnsw", sql`embedding vector_cosine_ops`)
      .with({ m: 16, ef_construction: 64 }),
    bySystemIdx: index("concept_embedding_system_idx").on(t.systemId),
  }),
);

export type ConceptEmbedding = typeof conceptEmbedding.$inferSelect;
export type NewConceptEmbedding = typeof conceptEmbedding.$inferInsert;
