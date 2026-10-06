// @wardenx/db — `transfer_event` (M6 §3.3). A transfer of the hospice election in/out of this agency
// (drives `m6.transfer.created`), preserving the benefit-period sequence at transfer. Org-scoped (no
// direct patient identifier; tenancy via the admission FK). Cross-module refs (M40 facility, M22
// document) are plain uuid app-validated; the admission FK is intra-M6. RLS + the M4 write-audit
// trigger land in M6-T03 (§3.6–3.7).
import { bigint, date, index, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { transferDirection } from "../../enums";
import { organizations } from "../organizations";
import { admissions } from "./admissions";

export const transferEvents = pgTable(
  "transfer_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    direction: transferDirection("direction").notNull(),
    // Nullable at create (M6L-T04): routes 37/38 do not yet capture the counterparty agency; the CCN +
    // name are filled when the sending/receiving hospice is known.
    receivingOrSendingCcn: text("receiving_or_sending_ccn"),
    receivingOrSendingName: text("receiving_or_sending_name"),
    receivingOrSendingFacilityId: uuid("receiving_or_sending_facility_id"), // M40 facility (app-validated)
    // Transfer-OUT only (migration 0370): where the RECEIVING hospice cares for the patient — drives the
    // claim's patient discharge status 50 (hospice, home) vs 51 (hospice, medical facility) per CMS Pub.
    // 100-04 Ch. 11 §30.3. Required on new transfer-outs (route 37); NULL on transfer-ins and historic rows.
    receivingCareSetting: text("receiving_care_setting", { enum: ["home", "facility"] }),
    // Migration 0372: why a RECORDED receiving care setting was changed afterwards
    // (POST /transfers/:id/receiving-care-setting); NULL when the value was only ever filled in.
    receivingCareSettingCorrectionReason: text("receiving_care_setting_correction_reason"),
    effectiveAt: date("effective_at").notNull(),
    periodSequenceAtTransfer: smallint("period_sequence_at_transfer").notNull(),
    narrative: text("narrative"),
    documentId: uuid("document_id"), // M22 document (app-validated)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    orgEffIdx: index("transfer_org_eff_idx").on(t.organizationId, t.effectiveAt),
  }),
);

export type TransferEvent = typeof transferEvents.$inferSelect;
export type NewTransferEvent = typeof transferEvents.$inferInsert;
