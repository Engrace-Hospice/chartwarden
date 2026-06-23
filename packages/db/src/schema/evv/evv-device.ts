// @wardenx/db — `evv_device` (M18 §3.3 / §2.2.3 D8). The per-clinician mobile-device registration lifecycle
// (pending_approval → approved | rejected → suspended → retired), gating EVV capture on an M2-attested
// device. Membership-scoped, NOT patient-scoped (erases on workforce-member departure per M2 D8, not on a
// patient destruction cert). `device_key_fingerprint` (auth secret), `denial_reason`, and `suspend_reason`
// are DENYLISTED from audit (§3.6). `m2_device_attestation_id` is a plain uuid logical FK to M2. RLS + grants
// + M4 write-audit trigger land in the RLS migration (M18-T02 / 0047).
import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { evvDevicePlatform, evvDeviceStatus } from "../../enums";
import { organizations } from "../organizations";
import { memberships } from "../memberships";

export const evvDevice = pgTable(
  "evv_device",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),

    platform: evvDevicePlatform("platform").notNull(),
    modelDescription: text("model_description"), // "iPhone 14 Pro" etc.
    deviceKeyFingerprint: text("device_key_fingerprint").notNull(), // SecureStore key hash; DENYLISTED (§3.6)
    m2DeviceAttestationId: uuid("m2_device_attestation_id").notNull(), // M2 row (app-validated; no FK)

    status: evvDeviceStatus("status").notNull().default("pending_approval"),
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByMembershipId: uuid("rejected_by_membership_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    denialReason: text("denial_reason"), // DENYLISTED (§3.6)
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendReason: text("suspend_reason"), // DENYLISTED (§3.6)
    retiredAt: timestamp("retired_at", { withTimezone: true }),

    lastEventAt: timestamp("last_event_at", { withTimezone: true }),

    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One active key per clinician (§3.2 Phase E).
    membershipKeyActive: uniqueIndex("evv_device_mem_key_active_uidx")
      .on(t.membershipId, t.deviceKeyFingerprint)
      .where(sql`status IN ('pending_approval', 'approved', 'suspended')`),
    orgMembershipStatus: index("evv_device_org_mem_status_idx").on(
      t.organizationId,
      t.membershipId,
      t.status,
    ),
  }),
);

export type EvvDevice = typeof evvDevice.$inferSelect;
export type NewEvvDevice = typeof evvDevice.$inferInsert;
