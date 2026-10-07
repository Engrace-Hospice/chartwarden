// @wardenx/db — `discharge_event` (M6 §3.3). The terminal event for an admission (drives
// `m6.discharge.created` / `m6.discharge.death` / `m6.bereavement.eligible`). Org-scoped (no direct
// patient identifier; tenancy via the admission FK). Cross-module refs (M40 death certifier, M22
// document) are plain uuid app-validated; the admission FK is intra-M6. One discharge per admission
// (unique). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
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
import { dischargeEventStatus, dischargeType, physicianSignerCapacity } from "../../enums";
import { organizations } from "../organizations";
import { users } from "../users";
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
    // Death only (migration 0370): where the patient died — drives the claim's patient discharge status 40
    // (home) / 41 (medical facility) / 42 (place unknown) per CMS Pub. 100-04 Ch. 11 §30.3. Required on new
    // internal death discharges; an HL7-reported death records `unknown`; NULL on historic rows.
    placeOfDeath: text("place_of_death", { enum: ["home", "facility", "unknown"] }),
    // Migration 0372: why a RECORDED place of death was changed afterwards (POST /discharges/:id/place-of-death);
    // NULL when the value was only ever filled in. Audited with the value change by the M4 write-audit trigger.
    placeOfDeathCorrectionReason: text("place_of_death_correction_reason"),
    forCauseReason: text("for_cause_reason"),
    narrative: text("narrative"),
    documentId: uuid("document_id"), // M22 document (app-validated)
    bereavementEligible: boolean("bereavement_eligible").notNull().default(false),
    // F-227 (#248) — M6 §4.8.4 / W-M6-31 provenance + the medical-director cosign facts (migration 0300).
    // An `hl7_external` death is `completed` immediately but `cosign_required` until the director attests.
    source: text("source", { enum: ["internal_clinician_recorded", "hl7_external"] })
      .notNull()
      .default("internal_clinician_recorded"),
    sourceProposalId: uuid("source_proposal_id"), // M29 hl7_inbound_proposal (logical, no FK)
    cosignRequired: boolean("cosign_required").notNull().default(false),
    medicalDirectorMembershipId: uuid("medical_director_membership_id"), // acting user (logical)
    cosignedAt: timestamp("cosigned_at", { withTimezone: true }),
    // 42 CFR 418.26(b) (effective 2026-10-01; migration 0388) — the written physician discharge order. Required
    // for a live (non-death) discharge dated on/after 2026-10-01; for `for_cause` it is the route-40 cosign.
    // All-or-none across signer/capacity/signedAt (CHECK). `discharge_order_text` is audit-scrubbed free text.
    dischargeOrderSignedByUserId: uuid("discharge_order_signed_by_user_id").references(
      () => users.id,
      { onDelete: "restrict" },
    ),
    dischargeOrderSignerCapacity: physicianSignerCapacity("discharge_order_signer_capacity"),
    dischargeOrderSignedAt: timestamp("discharge_order_signed_at", { withTimezone: true }),
    dischargeOrderText: text("discharge_order_text"),
    dischargeOrderReference: text("discharge_order_reference"),
    // GAP-121 (migration 0430) — who FILED a for-cause discharge. The route-40 cosigner must be a different user
    // (two-person control); NULL on rows filed before the column existed and on every non-for-cause reason.
    filedByUserId: uuid("filed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
    // Route-40 cosigner identity as attested on the cosign body (previously validated, then discarded).
    cosignerName: text("cosigner_name"),
    cosignerNpi: text("cosigner_npi"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    admUnique: uniqueIndex("discharge_admission_idx").on(t.admissionId),
    sourceProposalUnique: uniqueIndex("discharge_source_proposal_idx")
      .on(t.organizationId, t.sourceProposalId)
      .where(sql`source_proposal_id IS NOT NULL`),
  }),
);

export type DischargeEvent = typeof dischargeEvents.$inferSelect;
export type NewDischargeEvent = typeof dischargeEvents.$inferInsert;
