// apps/backend/src/modules/38-terminology/jobs/support-db.ts — the Drizzle bindings for the two follow-up jobs:
// value-set expansion materialisation and concept embeddings (GAP-108). Both write through the migration-0364
// `terminology_loader_*` functions; reads are plain `USING (true)` selects as `wardenx_app`.
import { type DbClient, schema } from "@wardenx/db";
import type { CodeSystemId, ValueSetMemberRow } from "@wardenx/terminology";
import {
  type EmbeddingStorePort,
  type ExpansionWriterPort,
  type LoadableSystemId,
  isLoadableSystem,
} from "@wardenx/terminology-loader";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

type ExecRow = Record<string, unknown>;
const rowsOf = (result: unknown): ExecRow[] => {
  const r = result as { rows?: ExecRow[] } | ExecRow[];
  return Array.isArray(r) ? r : (r.rows ?? []);
};

const MEMBER = schema.valueSetMembers;
const VER = schema.codeSystemVersions;

/** `concept_<system>` — the system is a closed, validated enum member, never caller text. */
function conceptTable(system: LoadableSystemId): string {
  return `concept_${system}`;
}

/** Materialised-expansion writer (`terminology.refresh_expansions`). */
export function createDbExpansionWriter(db: DbClient): ExpansionWriterPort {
  return {
    async loadMembersForSystem(system) {
      const sets = db
        .select({ id: MEMBER.valueSetId })
        .from(MEMBER)
        .where(eq(MEMBER.systemId, system));
      const rows = await db
        .select({
          valueSetId: MEMBER.valueSetId,
          systemId: MEMBER.systemId,
          code: MEMBER.code,
          memberEffective: MEMBER.memberEffective,
          memberEnd: MEMBER.memberEnd,
          annotations: MEMBER.annotations,
        })
        .from(MEMBER)
        .where(inArray(MEMBER.valueSetId, sets));
      return rows.map(
        (r): ValueSetMemberRow => ({
          valueSetId: r.valueSetId,
          systemId: r.systemId,
          code: r.code,
          memberEffective: String(r.memberEffective),
          memberEnd: r.memberEnd === null ? null : String(r.memberEnd),
          annotations: (r.annotations ?? {}) as Record<string, unknown>,
        }),
      );
    },

    async replaceExpansion(valueSetId, rows) {
      const json = JSON.stringify(
        rows.map((r) => ({
          system_id: r.systemId,
          code: r.code,
          as_of_lower: r.asOfLower,
          as_of_upper: r.asOfUpper,
          annotations: r.annotations,
        })),
      );
      await db.execute(
        sql`SELECT terminology_loader_replace_expansion(${valueSetId}, ${json}::jsonb)`,
      );
    },

    async logExpanded(system: CodeSystemId, valueSetCount, rowCount) {
      await db.execute(sql`
        SELECT terminology_loader_log_event(${system}::code_system_id, NULL::uuid, 'expanded'::terminology_update_action,
          ${rowCount}, ${valueSetCount}, ${JSON.stringify({ rows: rowCount })}::jsonb)`);
    },
  };
}

/** Concept-embedding store (`terminology.refresh_embeddings`). */
export function createDbEmbeddingStore(db: DbClient): EmbeddingStorePort {
  return {
    async activeVersionId(system) {
      const [row] = await db
        .select({ id: VER.id })
        .from(VER)
        .where(and(eq(VER.codeSystemId, system), eq(VER.status, "active"), isNull(VER.effectiveTo)))
        .orderBy(desc(VER.effectiveFrom))
        .limit(1);
      return row?.id ?? null;
    },

    async conceptsMissingEmbeddings(system, versionId, afterCode, limit) {
      if (!isLoadableSystem(system)) return [];
      const table = sql.raw(conceptTable(system));
      const result = await db.execute(sql`
        SELECT c.code, c.display FROM ${table} c
         WHERE c.version_id = ${versionId}::uuid
           AND c.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM concept_embedding e
                            WHERE e.system_id = ${system}::code_system_id AND e.code = c.code AND e.asof_version = ${versionId}::uuid)
           AND (${afterCode}::text IS NULL OR c.code > ${afterCode}::text)
         ORDER BY c.code LIMIT ${limit}`);
      return rowsOf(result).map((r) => ({ code: String(r.code), display: String(r.display) }));
    },

    async writeEmbeddings(versionId, modelId, rows) {
      const json = JSON.stringify(rows.map((r) => ({ code: r.code, embedding: r.embedding })));
      const result = await db.execute(
        sql`SELECT terminology_loader_write_embeddings(${versionId}::uuid, ${modelId}, ${json}::jsonb) AS n`,
      );
      return Number(rowsOf(result)[0]?.n ?? 0);
    },

    async logEmbedded(system, versionId, conceptCount) {
      await db.execute(sql`
        SELECT terminology_loader_log_event(${system}::code_system_id, ${versionId}::uuid, 'embedded'::terminology_update_action,
          ${conceptCount}, 0, ${JSON.stringify({ phase: "refreshed" })}::jsonb)`);
    },
  };
}
