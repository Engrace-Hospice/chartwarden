// @wardenx/db — `administration_offline_queue` (M13 §3.3 / §2.10 D18). Server-side persistence of incoming
// offline-sync requests for idempotency + audit (the on-device IndexedDB queue is NOT represented here). One row
// per (device_id, local_id): the canonical-payload digest for replay detection, the sync status, and the linked
// administration_record once synced. Org-scoped; standard app.org_id RLS. Non-partitioned (purged 30 days
// post-sync). administration_record is partitioned, so `synced_administration_record_id` is plain uuid (no SQL FK).
// RLS + grants + the M4 write-audit trigger (rejection_reason_detail denylisted, §3.6) land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { offlineSyncStatus } from "../../enums";
import { organizations } from "../organizations";

export const administrationOfflineQueue = pgTable(
  "administration_offline_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    deviceId: uuid("device_id").notNull(),
    localId: uuid("local_id").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    syncStatus: offlineSyncStatus("sync_status").notNull().default("pending"),
    syncedAdministrationRecordId: uuid("synced_administration_record_id"), // no FK — partitioned
    rejectionReasonCode: text("rejection_reason_code"),
    rejectionReasonDetail: text("rejection_reason_detail"), // DENYLISTED

    payloadEnvelopeDigest: text("payload_envelope_digest").notNull(), // sha256 of canonical payload for replay detection

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDeviceLocal: uniqueIndex("offline_q_device_local_uk").on(
      t.organizationId,
      t.deviceId,
      t.localId,
    ),
    pendingSync: index("offline_q_pending_idx")
      .on(t.organizationId, t.receivedAt.asc())
      .where(sql`sync_status = 'pending'`),
  }),
);

export type AdministrationOfflineQueueEntry = typeof administrationOfflineQueue.$inferSelect;
export type NewAdministrationOfflineQueueEntry = typeof administrationOfflineQueue.$inferInsert;
