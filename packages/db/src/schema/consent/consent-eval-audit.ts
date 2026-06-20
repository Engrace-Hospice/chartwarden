// @wardenx/db — `consent_eval_audit` (M39 Consent §3.3 #10). The consent-version-aware DECISION
// audit (D12): one INSERT per evaluate() call carrying the consent-record id + version-at-eval, the
// allow/deny + reason, the as-of, and the caller/session context — so a Compliance Officer can
// reconstruct "what the system knew about consent on date X when staff accessed record Y". NOT the
// §164.528 disclosure-accounting feeder (M39-F03 — that is owned by M4, written by the disclosing
// module). INSERT-only (trg_cea_immutable, T03). High-volume → PARTITION BY RANGE (evaluated_at)
// monthly; the Drizzle definition is logical (composite PK incl. the partition key), the actual
// PARTITION BY + monthly partitions are emitted by the T03 migration (§3.4/§3.6). PHI-bearing
// (patient_id) → the three-column tenancy rule. No write-audit trigger (it IS the audit table).
import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { consentTypeKey } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";

export const consentEvalAudit = pgTable(
  "consent_eval_audit",
  {
    id: uuid("id").notNull(), // composite PK with evaluated_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated)
    consentRecordId: uuid("consent_record_id"),
    consentVersionAtEval: integer("consent_version_at_eval"),
    typeKey: consentTypeKey("type_key").notNull(),
    recipientResolvedKind: text("recipient_resolved_kind"),
    recipientResolvedId: uuid("recipient_resolved_id"),
    allowed: boolean("allowed").notNull(),
    denyReason: text("deny_reason"),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    callerModule: text("caller_module").notNull(),
    callerRoute: text("caller_route"),
    sessionClass: text("session_class"),
    sessionId: uuid("session_id"),
    membershipId: uuid("membership_id"),
    redactedCategories: text("redacted_categories").array(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.evaluatedAt] }),
    patientTypeIdx: index("ix_cea_patient_type").on(
      t.organizationId,
      t.patientId,
      t.typeKey,
      t.evaluatedAt,
    ),
    callerIdx: index("ix_cea_caller").on(t.callerModule, t.callerRoute, t.evaluatedAt),
    recordIdx: index("ix_cea_record").on(t.consentRecordId, t.evaluatedAt),
  }),
);

export type ConsentEvalAudit = typeof consentEvalAudit.$inferSelect;
export type NewConsentEvalAudit = typeof consentEvalAudit.$inferInsert;
