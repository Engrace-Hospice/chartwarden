// @wardenx/db — `discharge_event` (M6 §3.3). The terminal event for an admission (drives
// `m6.discharge.created` / `m6.discharge.death` / `m6.bereavement.eligible`). Org-scoped (no direct
// patient identifier; tenancy via the admission FK). Cross-module refs (M40 death certifier, M22
// document) are plain uuid app-validated; the admission FK is intra-M6. One discharge per admission
// (unique). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import {
  bigint,
  boolean,
  date,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { dischargeEventStatus, dischargeType } from "../../enums";
import { organizations } from "../organizations";
import { admissions } from "./admissions";

export const dischargeEvents = pgTable(
  "discharge_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    dischargeType: dischargeType("discharge_type").notNull(),
    // §7.6 D11 — the immediate reasons insert at `completed`; `for_cause` files at `pending_cosign`
    // (admission stays active) until a medical director resolves it via route 40 (M6L-T04).
    status: dischargeEventStatus("status").notNull().default("completed"),
    effectiveAt: date("effective_at").notNull(),
    deathAt: timestamp("death_at", { withTimezone: true }),
    deathCertifierId: uuid("death_certifier_id"), // M40 physician (app-validated)
    forCauseReason: text("for_cause_reason"),
    narrative: text("narrative"),
    documentId: uuid("document_id"), // M22 document (app-validated)
    bereavementEligible: boolean("bereavement_eligible").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    admUnique: uniqueIndex("discharge_admission_idx").on(t.admissionId),
  }),
);

export type DischargeEvent = typeof dischargeEvents.$inferSelect;
export type NewDischargeEvent = typeof dischargeEvents.$inferInsert;
