// @wardenx/db — `consent_record_dpoa_agent` (M39 Consent §3.3 #5). The named-agent rows for DPOA
// consent records (D5): primary + up to two alternates, each with an activation condition, a per-
// agent scope, and a per-agent term, plus per-state statute fields in state_specific_jsonb. Partial
// unique indexes enforce ≤1 of each agent_kind active per consent record. Org-scoped child of
// consent_record (no patient field) → standard app.org_id RLS in M39-T03.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  consentDpoaActivationCondition,
  consentDpoaAgentKind,
  consentDpoaScopeKind,
  consentDpoaTermKind,
} from "../../enums";
import { organizations } from "../organizations";
import { consentRecord } from "./consent-record";

export const consentRecordDpoaAgent = pgTable(
  "consent_record_dpoa_agent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    consentRecordId: uuid("consent_record_id")
      .notNull()
      .references(() => consentRecord.id, { onDelete: "restrict" }),
    agentKind: consentDpoaAgentKind("agent_kind").notNull(),
    agentName: text("agent_name").notNull(),
    agentRelationship: text("agent_relationship").notNull(),
    agentContactJsonb: jsonb("agent_contact_jsonb").notNull(),
    agentExternalPhysicianId: uuid("agent_external_physician_id"), // M40 FK if agent is a physician
    agentUserId: uuid("agent_user_id"), // if agent is a system user
    agentCaregiverId: uuid("agent_caregiver_id"), // if agent is in the M5 caregiver table
    activationCondition: consentDpoaActivationCondition("activation_condition").notNull(),
    activationEvidenceJsonb: jsonb("activation_evidence_jsonb"), // physician determination / court order
    scopeKind: consentDpoaScopeKind("scope_kind").notNull(),
    termKind: consentDpoaTermKind("term_kind").notNull(),
    termUntil: timestamp("term_until", { withTimezone: true }),
    stateSpecificJsonb: jsonb("state_specific_jsonb"), // per-state DPOA statute fields
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    addedById: uuid("added_by_id").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedById: uuid("removed_by_id"),
  },
  (t) => ({
    consentIdx: index("ix_crda_consent").on(t.consentRecordId),
    primaryUniq: uniqueIndex("uq_crda_primary")
      .on(t.consentRecordId)
      .where(sql`agent_kind = 'primary' AND removed_at IS NULL`),
    alt1Uniq: uniqueIndex("uq_crda_alt1")
      .on(t.consentRecordId)
      .where(sql`agent_kind = 'alternate_1' AND removed_at IS NULL`),
    alt2Uniq: uniqueIndex("uq_crda_alt2")
      .on(t.consentRecordId)
      .where(sql`agent_kind = 'alternate_2' AND removed_at IS NULL`),
    termConsistent: check(
      "crda_term_consistent",
      sql`(term_kind <> 'until_date') OR (term_until IS NOT NULL)`,
    ),
  }),
);

export type ConsentRecordDpoaAgent = typeof consentRecordDpoaAgent.$inferSelect;
export type NewConsentRecordDpoaAgent = typeof consentRecordDpoaAgent.$inferInsert;
