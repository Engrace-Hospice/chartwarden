// @wardenx/db — `audit_seal` (M4 Audit §3.5, §10.4). Phase-2 tamper-evidence chain: one seal per
// audit partition links to the prior seal via prev_chain_hash, forming a hash chain over the
// ordered event hashes (created behind the `audit_hash_chain_enabled` flag; the integrity verify
// lands in M4-T11/§3.1 integrity). organization_id is nullable so platform-scope partitions can be
// sealed; not a PHI table. RLS + grants land in M4-T05.
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const auditSeals = pgTable(
  "audit_seal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    partition: text("partition").notNull(), // e.g. 'audit_event_2026_06'
    fromId: uuid("from_id").notNull(), // first event id covered (inclusive)
    toId: uuid("to_id").notNull(), // last event id covered (inclusive)
    eventCount: integer("event_count").notNull(),
    prevChainHash: text("prev_chain_hash"), // links to prior seal (null = genesis)
    chainHash: text("chain_hash").notNull(), // sha-256 over ordered event hashes + prev_chain_hash
    algorithm: text("algorithm").notNull().default("sha256"),
    sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    partitionUnique: uniqueIndex("audit_seal_partition_idx").on(t.organizationId, t.partition),
    chainIdx: index("audit_seal_chain_idx").on(t.sealedAt),
  }),
);

export type AuditSeal = typeof auditSeals.$inferSelect;
export type NewAuditSeal = typeof auditSeals.$inferInsert;
