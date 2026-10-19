// M18 durable, cross-partition idempotency receipt for device-originated offline EVV captures.
// The receipt deliberately contains no coordinates, patient id, address, or free text. The keyed
// fingerprint is computed by the backend over the canonical request and is treated as sensitive.
import { index, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";
import { evvEventGpsQuality, evvEventKind } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { evvDevice } from "./evv-device";

export const evvOfflineCaptureReceipt = pgTable(
  "evv_offline_capture_receipt",
  {
    id: uuid("id").notNull().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    evvDeviceId: uuid("evv_device_id")
      .notNull()
      .references(() => evvDevice.id, { onDelete: "restrict" }),
    localId: uuid("local_id").notNull(),
    postingMembershipId: uuid("posting_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    payloadFingerprint: text("payload_fingerprint").notNull(),
    fingerprintKeyId: text("fingerprint_key_id").notNull(),
    eventId: uuid("event_id").notNull(),
    eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
    kind: evvEventKind("kind").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    gpsQuality: evvEventGpsQuality("gps_quality").notNull(),
    geofenceDecision: text("geofence_decision").notNull(),
    visitStateAfterEvent: text("visit_state_after_event"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id] }),
    captureIdentity: uniqueIndex("evv_offline_receipt_capture_uidx").on(
      t.organizationId,
      t.evvDeviceId,
      t.localId,
    ),
    event: uniqueIndex("evv_offline_receipt_event_uidx").on(t.organizationId, t.eventId),
    membership: index("evv_offline_receipt_membership_idx").on(
      t.organizationId,
      t.postingMembershipId,
    ),
  }),
);

export type EvvOfflineCaptureReceipt = typeof evvOfflineCaptureReceipt.$inferSelect;
export type NewEvvOfflineCaptureReceipt = typeof evvOfflineCaptureReceipt.$inferInsert;
