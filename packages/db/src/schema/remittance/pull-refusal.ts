// @chartwarden/db - M25 / #717 follow-up (migration 1256): per-file refusal count + quarantine stamp for the 835 pull.
// Ids and a code only: no PHI, no vendor text. `usage` is text + CHECK ('test' | 'production').
import { integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const remittancePullRefusal = pgTable(
  "remittance_pull_refusal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    vendor: text("vendor").notNull(),
    usage: text("usage").notNull(),
    remittanceId: text("remittance_id").notNull(),
    fileSha256: text("file_sha256").notNull(),
    refusalCount: integer("refusal_count").notNull().default(1),
    reasonCode: text("reason_code").notNull(),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    key: unique("remittance_pull_refusal_key").on(
      t.organizationId,
      t.providerEntityId,
      t.vendor,
      t.usage,
      t.remittanceId,
      t.fileSha256,
    ),
  }),
);
