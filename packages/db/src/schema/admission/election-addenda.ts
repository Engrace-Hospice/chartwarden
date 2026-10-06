// @wardenx/db — `election_addendum` (M6; ADR-0015 D1 amendment, FY2027). The 42 CFR 418.24(c) "Patient
// Notification of Hospice Non-Covered Items, Services, and Drugs", mandatory for every election effective on
// or after 2026-10-01 (CMS-1851-F). VERSIONED: version 1 is the initial addendum (due within 5 calendar days of
// the election's effective date, 418.24(d)(1)); every plan-of-care change that affects the determinations adds
// a new version (due within 3 calendar days, (d)(2)). A furnished version is never edited; the next version
// supersedes it (`superseded_by_id`).
//
// PHI-bearing (patient name, record number, diagnoses, item list) → the three-column tenancy rule, FORCEd RLS
// and a write-audit trigger whose denylist drops every PHI/free-text column (migration 0381). Cross-module
// refs (M5 patient, M22 document) are plain uuids, app-validated; admission / election statement are intra-M6
// FKs. The lifecycle is enforced twice: by `state-machines/election-addendum.ts` and by the CHECKs in 0381.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  electionAddendumExemptionReason,
  electionAddendumFurnishMethod,
  electionAddendumSignerKind,
  electionAddendumStatus,
  electionAddendumTrigger,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { admissions } from "./admissions";
import { electionStatements } from "./election-statements";

/** One non-covered line as stored in `items` (418.24(c)(5)–(6)). */
export interface ElectionAddendumItemRow {
  readonly category: "condition" | "item" | "service" | "drug";
  readonly description: string;
  readonly reasonNotCovered: string;
  /** Where the determination came from; absent for a line a clinician typed. */
  readonly source?: "problem" | "medication" | "dme" | "supply" | "service";
  readonly sourceId?: string;
}

/** One diagnosis line as stored in `terminal_diagnosis` / `related_diagnoses` (418.24(c)(4)). */
export interface ElectionAddendumDiagnosisRow {
  readonly icd10Code: string | null;
  readonly description: string;
}

export const electionAddenda = pgTable(
  "election_addendum",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }), // ARCH-011 (nullable)
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }), // ARCH-011 (nullable)
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id")
      .notNull()
      .references(() => admissions.id, { onDelete: "restrict" }),
    electionStatementId: uuid("election_statement_id").references(() => electionStatements.id, {
      onDelete: "restrict",
    }),
    versionNumber: integer("version_number").notNull(),
    trigger: electionAddendumTrigger("trigger").notNull(),
    /** What caused this version (an event name such as `m7.problem.added`, or `manual`). Never PHI. */
    triggerCause: text("trigger_cause"),
    /** The election effective date (initial) or the plan-of-care change instant (poc_change). */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    status: electionAddendumStatus("status").notNull().default("draft"),
    // ── 418.24(c)(2)–(4) identifying snapshot, frozen at furnish ──
    hospiceName: text("hospice_name"),
    patientName: text("patient_name"),
    medicalRecordNumber: text("medical_record_number"),
    terminalDiagnosis: jsonb("terminal_diagnosis")
      .$type<ElectionAddendumDiagnosisRow[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    relatedDiagnoses: jsonb("related_diagnoses")
      .$type<ElectionAddendumDiagnosisRow[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // ── 418.24(c)(5)–(7) determinations ──
    items: jsonb("items")
      .$type<ElectionAddendumItemRow[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The documented "everything is related and covered" determination (FR-F: "not a blank form"). */
    noNonCoveredItems: boolean("no_non_covered_items").notNull().default(false),
    clinicalExplanation: text("clinical_explanation"),
    guidelineReferences: text("guideline_references"),
    // ── 418.24(d) clock + (c)(10) furnish ──
    dueAt: timestamp("due_at", { withTimezone: true }),
    furnishedAt: timestamp("furnished_at", { withTimezone: true }),
    furnishMethod: electionAddendumFurnishMethod("furnish_method"),
    furnishedByUserId: uuid("furnished_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // ── 418.24(c)(9) acknowledgement of receipt ──
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signerKind: electionAddendumSignerKind("signer_kind"),
    representativeName: text("representative_name"),
    representativeRelationship: text("representative_relationship"),
    refusedAt: timestamp("refused_at", { withTimezone: true }),
    refusalReason: text("refusal_reason"),
    acknowledgementRecordedByUserId: uuid("acknowledgement_recorded_by_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    // ── 418.24(d)(3)/(4): not furnished / not signed because the patient died, revoked or was discharged ──
    signatureNotRequiredReason: electionAddendumExemptionReason("signature_not_required_reason"),
    signatureNotRequiredNote: text("signature_not_required_note"),
    signatureNotRequiredAt: timestamp("signature_not_required_at", { withTimezone: true }),
    documentId: uuid("document_id"), // M22 document (app-validated; stamped by the m22.document.rendered back-ref)
    supersededById: uuid("superseded_by_id"), // self-reference, FK in migration 0381
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    admissionVersionUnique: uniqueIndex("election_addendum_admission_version_uq").on(
      t.admissionId,
      t.versionNumber,
    ),
    oneDraftPerAdmission: uniqueIndex("election_addendum_one_draft_uq")
      .on(t.admissionId)
      .where(sql`status = 'draft'`),
    orgAdmissionIdx: index("election_addendum_org_admission_idx").on(
      t.organizationId,
      t.admissionId,
      t.versionNumber,
    ),
  }),
);

export type ElectionAddendum = typeof electionAddenda.$inferSelect;
export type NewElectionAddendum = typeof electionAddenda.$inferInsert;
