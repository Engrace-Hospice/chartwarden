// @chartwarden/db — `critical_lab_result` (M11; #908/#910, migration 1297). One row per critical (HH/LL) lab
// observation the lab-results applier saw: the visible quarantine queue for a critical result bound to NO order (with a
// response clock), the unsigned-order marker, and the "superseded by a later non-critical observation" mark. Ids, a
// LOINC code and a flag only -- never a value. `order_record_id` is a plain uuid (order_record is partitioned). The app
// role INSERTs and updates only the escalation / supersede columns; nothing deletes a row.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { patients } from "../patient/patients";
import { providerEntities } from "../provider-entities";

export const criticalLabResults = pgTable(
  "critical_lab_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    observationId: uuid("observation_id").notNull(),
    orderRecordId: uuid("order_record_id"),
    loincCode: text("loinc_code").notNull(),
    criticalFlag: text("critical_flag").$type<"HH" | "LL">().notNull(),
    disposition: text("disposition").$type<"paged" | "quarantined_no_order">().notNull(),
    orderUnsigned: boolean("order_unsigned").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    respondBy: timestamp("respond_by", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededByObservationId: uuid("superseded_by_observation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    observationUq: uniqueIndex("critical_lab_result_observation_uq").on(
      t.organizationId,
      t.observationId,
    ),
    quarantineIdx: index("critical_lab_result_quarantine_idx")
      .on(t.organizationId, t.respondBy)
      .where(sql`disposition = 'quarantined_no_order'`),
    orderIdx: index("critical_lab_result_order_idx")
      .on(t.organizationId, t.orderRecordId, t.loincCode)
      .where(sql`order_record_id IS NOT NULL`),
    patientIdx: index("critical_lab_result_patient_idx").on(t.patientId),
    providerEntityIdx: index("critical_lab_result_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("critical_lab_result_location_idx").on(t.locationId),
    dispositionChk: check(
      "critical_lab_result_disposition_chk",
      sql`disposition IN ('paged', 'quarantined_no_order')`,
    ),
  }),
);

export type CriticalLabResultRow = typeof criticalLabResults.$inferSelect;
export type NewCriticalLabResultRow = typeof criticalLabResults.$inferInsert;
