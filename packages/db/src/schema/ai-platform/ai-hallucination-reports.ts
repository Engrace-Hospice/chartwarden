// @wardenx/db — `ai_hallucination_report` (M32 §3.2.10). W5's entry point: the clinician's report that
// the model fabricated something, and the triage that follows it to a mitigation or a deprecation.
//
// TENANT-SCOPED + THE THREE-COLUMN RULE. §3.2.10 gives the table organization_id only; ARCH-011
// (architecture wins over a module spec) requires provider_entity_id + location_id, and this table is
// PHI-bearing in the way that matters most: `reporter_narrative_cipher` is a clinician describing what
// the model said ABOUT A PATIENT — "it invented a morphine dose for Mrs X" — so the narrative carries
// the patient's clinical content even though no patient_id column exists. provider_entity_id is NOT NULL
// (the report is filed by a clinician working inside one certified entity, and the surveyor-facing
// question is always which one); location_id is nullable.
//
// WHY THERE IS NO patient_id COLUMN, and it is deliberate rather than an omission: the report is about
// the MODEL, not the patient, and the tie to a chart already exists through `invocation_id`. Adding a
// patient column would create a second, unindexed path by which a fabrication report becomes part of a
// patient's record — and a clinician who reports a hallucination should not thereby be filing something
// into the chart of the person it concerned.
//
// `invocation_id` IS NULLABLE ON PURPOSE (§3.2.10: "nullable when the call cannot be traced"), and it is
// nullable for the reason that makes the whole workflow work: the clinician sees a wrong sentence, not a
// correlation id. A schema that required the invocation would refuse exactly the reports that matter
// most — the ones where provenance is already broken. It is a logical uuid rather than an FK because the
// parent `ai_invocation` is partitioned (the `ai_token_ledger` argument).
//
// `triage_disposition` is TEXT with a value CHECK rather than a pgEnum: §3.1 declares twenty-one enums
// and this vocabulary is not among them (`AiHallucinationTriageDisposition` in @wardenx/types).
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  aiHallucinationKind,
  aiHallucinationSeverity,
  aiHallucinationTriageStatus,
} from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { aiCapability } from "./ai-capabilities";
import { bytea } from "./cipher-column";

export const aiHallucinationReport = pgTable(
  "ai_hallucination_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    /** Logical uuid → `ai_invocation`; NULL when the call cannot be traced (see header). */
    invocationId: uuid("invocation_id"),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),

    /** Logical FK → M2 membership. */
    reporterMembershipId: uuid("reporter_membership_id").notNull(),
    reporterRole: text("reporter_role").notNull(),

    severity: aiHallucinationSeverity("severity").notNull(),
    hallucinationKind: aiHallucinationKind("hallucination_kind").notNull(),
    /** DEK envelope-encrypted (§3.6) and §3.4-denylisted — it quotes the fabrication verbatim. */
    reporterNarrativeCipher: bytea("reporter_narrative_cipher").notNull(),

    triageStatus: aiHallucinationTriageStatus("triage_status").notNull().default("open"),
    triageOwnerMembershipId: uuid("triage_owner_membership_id"),
    triageDisposition: text("triage_disposition"),
    mitigationActionRef: text("mitigation_action_ref"),

    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgReportedIdx: index("ai_hallucination_org_reported_idx").on(
      t.organizationId,
      t.reportedAt.desc(),
    ),
    capabilityReportedIdx: index("ai_hallucination_cap_reported_idx").on(
      t.capabilityId,
      t.reportedAt.desc(),
    ),
    // The AI Safety Owner's queue. Partial on the two OPEN statuses — a closed report is history, and
    // the SEV-1 sweep that drives W3's kill switch must not scan it.
    openTriageIdx: index("ai_hallucination_open_triage_idx")
      .on(t.triageStatus, t.severity)
      .where(sql`triage_status IN ('open','investigating')`),

    dispositionCheck: check(
      "ai_hallucination_disposition_check",
      sql`triage_disposition IS NULL OR triage_disposition IN ('prompt_iteration_required','model_rollback_required','edge_case_acknowledged','false_alarm')`,
    ),
  }),
);

export type AiHallucinationReportRow = typeof aiHallucinationReport.$inferSelect;
export type NewAiHallucinationReportRow = typeof aiHallucinationReport.$inferInsert;
