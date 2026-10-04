import { sql } from "drizzle-orm";
// @wardenx/db — `intake_batch_relink` (M22, F-238 / 0312). Append-only history of moving an intake batch to
// another patient or referral before its review completes: who, when, from → to, and why. PHI (patient ids,
// a reason that may name people) → the three tenancy columns, FORCEd RLS, audit trigger with `reason`
// denylisted. `patient_id` is the patient the batch was moved TO (null when moved to an unresolved referral).
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { intakeUploadBatches } from "./intake-upload-batch";

export const intakeBatchRelinks = pgTable(
  "intake_batch_relink",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    patientId: uuid("patient_id"),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id),
    locationId: uuid("location_id").references(() => locations.id),
    intakeUploadBatchId: uuid("intake_upload_batch_id")
      .notNull()
      .references(() => intakeUploadBatches.id),
    fromPatientId: uuid("from_patient_id"),
    fromReferralId: uuid("from_referral_id"),
    toReferralId: uuid("to_referral_id"),
    reason: text("reason").notNull(), // DENYLISTED (§3.6)
    relinkedByMembershipId: uuid("relinked_by_membership_id").notNull(),
    relinkedAt: timestamp("relinked_at", { withTimezone: true }).notNull().defaultNow(),
    correlationId: text("correlation_id").notNull(),
  },
  (t) => ({
    byBatch: index("intake_batch_relink_batch_idx").on(
      t.organizationId,
      t.intakeUploadBatchId,
      t.relinkedAt,
    ),
    target: check(
      "intake_batch_relink_target_chk",
      sql`patient_id IS NOT NULL OR to_referral_id IS NOT NULL`,
    ),
    reason: check("intake_batch_relink_reason_chk", sql`length(btrim(reason)) >= 5`),
  }),
);

export type IntakeBatchRelink = typeof intakeBatchRelinks.$inferSelect;
