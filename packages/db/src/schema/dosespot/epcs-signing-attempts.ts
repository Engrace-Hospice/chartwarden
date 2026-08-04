// @wardenx/db — `epcs_signing_attempt` (M12 §3.3 / §7.3, DEA §1311.205 records-of-application). One
// append-only row per controlled-substance e-prescribing signing attempt: the §1311.116 60-second nonce
// (stored ONLY as its SHA-256 — the nonce value itself is never persisted), the second-factor type, the
// hashed signing device + IP (`ip_address_digest` = sha256(IP+salt), never a raw IP), and the
// pending/succeeded/failed_2fa/failed_timeout/failed_validation outcome. EPCS is behind the OFF
// `dosespot.epcs` flag in Phase 1 (M12-T05); this table is the persistence floor for §1311.205. Org-scoped;
// a §7.1 ABAC overlay (initiating prescriber / platform_ops / compliance_officer only) layers on top in the
// route tier (M12-T08). `medication_order_id` is a plain uuid with NO single-column SQL FK (medication_order
// is partitioned); `prescriber_membership_id` FKs M1. The nonce-digest unique index prevents nonce replay.
// RLS + grants + the M4 write-audit trigger land in the RLS migration (M12-T02).
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { epcsSecondFactorType, epcsSigningAttemptOutcome } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const epcsSigningAttempts = pgTable(
  "epcs_signing_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    medicationOrderId: uuid("medication_order_id").notNull(), // M12 partitioned parent → no single-col FK
    prescriberMembershipId: uuid("prescriber_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),

    nonce: text("nonce").notNull(), // SHA-256 of the nonce; the nonce value itself is never persisted
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),

    secondFactorType: epcsSecondFactorType("second_factor_type"),
    signingDevice: text("signing_device"),
    ipAddressDigest: text("ip_address_digest"), // sha256(IP+salt); never a raw IP

    outcome: epcsSigningAttemptOutcome("outcome").notNull().default("pending"),
    outcomeDetail: text("outcome_detail"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrderIdx: index("epcs_signing_attempt_order_idx").on(t.medicationOrderId),
    nonceUnique: uniqueIndex("epcs_signing_attempt_nonce_unique").on(t.nonce),
  }),
);

export type EpcsSigningAttempt = typeof epcsSigningAttempts.$inferSelect;
export type NewEpcsSigningAttempt = typeof epcsSigningAttempts.$inferInsert;
