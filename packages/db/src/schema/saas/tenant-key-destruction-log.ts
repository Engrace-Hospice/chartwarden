// @chartwarden/db — `tenant_key_destruction_log` (M34 SaaS Tenant Platform §3.5). The append-only forensic
// audit trail for the cryptographic-shred sequence: one row per phase transition during
// `services/shred-worker.ts executeShred` — 'deks_zeroized' | 'module_erasers_complete' |
// 'minio_scope_destroyed' | 'certificate_filed' | 'dek_destruction_aborted_part_two_retention'
// (M34-F08 / ADR-0014: an eraseFn returned 'refused_part_two_retention', so Phase-3 DEK destruction aborted
// and the tenant was re-deferred to 'retained'). `per_module_eraser_receipts` captures each module's eraseFn
// outcome (erased receipt or refusal). The org_id remains readable on this row even after the key ring's DEK
// is shredded — it is the forensic tenant key, not envelope-encrypted PHI.
//
// Tenancy (§3.10 M34-F02 / ADR-0010): ORG-SCOPED — carries its own `organization_id` NOT NULL so the canonical
// app.org_id RLS predicate applies directly. The intra-module parent `tenant_key_ring` carries a SQL FK and the
// org spine carries a SQL FK. RLS + grants + the M4 write-audit trigger land in migrations 0052/0053.
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { tenantKeyRing } from "./tenant-key-ring";

export const tenantKeyDestructionLog = pgTable(
  "tenant_key_destruction_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // M34-F02 / ADR-0010: tenant-scoping key (canonical app.org_id RLS).
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    tenantKeyRingId: uuid("tenant_key_ring_id")
      .notNull()
      .references(() => tenantKeyRing.id, { onDelete: "restrict" }),
    /** One approved destruction ceremony; a later Part 2 retry gets an independent phase trail. */
    destructionCertificateId: uuid("destruction_certificate_id").notNull(),
    // 'deks_zeroized' | 'module_erasers_complete' | 'minio_scope_destroyed' | 'certificate_filed'
    // | 'dek_destruction_aborted_part_two_retention'
    destructionPhase: text("destruction_phase").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    perModuleEraserReceipts: jsonb("per_module_eraser_receipts").notNull().default([]),
  },
  (t) => ({
    keyRingPhaseIdx: uniqueIndex("tenant_key_destruction_log_keyring_phase_idx").on(
      t.tenantKeyRingId,
      t.destructionCertificateId,
      t.destructionPhase,
    ),
  }),
);

export type TenantKeyDestructionLog = typeof tenantKeyDestructionLog.$inferSelect;
export type NewTenantKeyDestructionLog = typeof tenantKeyDestructionLog.$inferInsert;
