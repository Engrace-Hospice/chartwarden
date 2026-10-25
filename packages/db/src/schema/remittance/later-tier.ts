// @chartwarden/db - M25 milestone 7a-1 (migration 1172): later-tier record-keeping. appeal_tier_detail holds the facts a
// person records about an ALJ / Council / federal-court case (authority reference as typed, an amount in controversy
// that is STORED and never compared to a threshold, hearing facts as entered, a disposition LABEL, and for federal court
// the counsel-filing facts). recorded_deadline is a due date typed FROM A NOTICE with a mandatory source note, for exactly
// one appeal_case or audit_request. Closed sets are text + CHECK (mirrored in domain/later-tier.ts); no pgEnum. The
// appeal_case.decision_outcome enum is unchanged: disposition_kind is a label only. Free text is audit-scrubbed.
import { bigint, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { appealCase } from "./appeal";
import { auditRequest } from "./audit-request";
import { beneficiaryAppeal } from "./beneficiary-representative";
import { payerAppealCase } from "./payer-appeal";

export const appealTierDetail = pgTable(
  "appeal_tier_detail",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK -> M40/M2
    appealCaseId: uuid("appeal_case_id")
      .notNull()
      .references(() => appealCase.id, { onDelete: "restrict" }),
    tier: text("tier").notNull(), // alj | council | federal_court (equals appeal_case.tier, trigger-checked)
    authorityReference: text("authority_reference"),
    amountInControversyCents: bigint("amount_in_controversy_cents", { mode: "number" }),
    hearingOn: date("hearing_on"),
    hearingFormatNote: text("hearing_format_note"),
    dispositionKind: text("disposition_kind"),
    dispositionNote: text("disposition_note"),
    filedByCounselOn: date("filed_by_counsel_on"),
    docketReference: text("docket_reference"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("appeal_tier_detail_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const recordedDeadline = pgTable(
  "recorded_deadline",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    appealCaseId: uuid("appeal_case_id").references(() => appealCase.id, { onDelete: "restrict" }),
    auditRequestId: uuid("audit_request_id").references(() => auditRequest.id, {
      onDelete: "restrict",
    }),
    // Migration 1208: the third subject (exactly one of the three is set).
    payerAppealCaseId: uuid("payer_appeal_case_id").references(() => payerAppealCase.id, {
      onDelete: "restrict",
    }),
    // Migration 1241: the fourth subject (exactly one of the four is set).
    beneficiaryAppealId: uuid("beneficiary_appeal_id").references(() => beneficiaryAppeal.id, {
      onDelete: "restrict",
    }),
    label: text("label").notNull(), // denylisted
    dueOn: date("due_on").notNull(),
    zone: text("zone").notNull(),
    sourceNote: text("source_note").notNull(), // denylisted
    noticeDocumentId: uuid("notice_document_id"), // M22 logical FK
    satisfiedOn: date("satisfied_on"),
    lastAlertedBoundary: integer("last_alerted_boundary"),
    createdByMembershipId: uuid("created_by_membership_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAppeal: index("ix_recorded_deadline_appeal").on(t.appealCaseId),
    byAudit: index("ix_recorded_deadline_audit").on(t.auditRequestId),
    byPayerAppeal: index("ix_recorded_deadline_payer_appeal").on(t.payerAppealCaseId),
    byBeneficiaryAppeal: index("ix_recorded_deadline_beneficiary_appeal").on(t.beneficiaryAppealId),
  }),
);
