// @chartwarden/db — M24 Billing — Medicaid §3.3 — the Room & Board domain (42 CFR §418.302/.310/.318).
// rb_arrangement is the per-patient-per-NF-stay contract instance (NON-partitioned; one ACTIVE window per
// patient enforced by an EXCLUDE USING gist no-overlap constraint in SQL 0093). rb_day is the per-patient-
// per-service-date billing day, PARTITION BY LIST(organization_id) (composite PK (id, organization_id) in
// SQL 0095) — it carries a real FK to the non-partitioned rb_arrangement parent.
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) get real FKs;
// rb_day.rb_arrangement_id → rb_arrangement (intra-M24, non-partitioned) is a real FK. patient_id (M5),
// nf_facility_mdm_id (M40), contract_document_id (M22), loc_period_id_snapshot (M6), medicaid_claim_line_id
// (partitioned), supersedes_arrangement_id (self) are LOGICAL uuid.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { m24ClaimLineLoc, m24RbArrangementState, m24RbDayStatus } from "./enums";

export const rbArrangement = pgTable(
  "rb_arrangement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id), // nullable (§3.3)

    nfFacilityMdmId: uuid("nf_facility_mdm_id").notNull(), // logical FK → M40 facility entity
    nfFacilityNameSnapshot: varchar("nf_facility_name_snapshot", { length: 200 }).notNull(),

    effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: "date" }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true, mode: "date" }), // null = open-ended

    nfPerDiemRoutineCents: integer("nf_per_diem_routine_cents").notNull(),
    nfPerDiemRespCents: integer("nf_per_diem_resp_cents").notNull(),
    nfPerDiemGipCents: integer("nf_per_diem_gip_cents").notNull(), // stored for audit (GIP excluded from R&B)

    passThroughPct: integer("pass_through_pct").notNull(), // 0..100
    retentionPct: integer("retention_pct").notNull(), // 0..100; must sum to 100

    contractDocumentId: uuid("contract_document_id"), // logical FK → M22
    contractStartedAt: timestamp("contract_started_at", { withTimezone: true }),
    contractTerminatedAt: timestamp("contract_terminated_at", { withTimezone: true }),
    terminationReason: text("termination_reason"),
    supersedesArrangementId: uuid("supersedes_arrangement_id"), // self logical FK (chain)

    state: m24RbArrangementState("state").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    updatedByMembershipId: uuid("updated_by_membership_id").notNull(),
  },
  (t) => ({
    byPatientState: index("rb_arrangement_by_patient_state").on(t.patientId, t.state),
    pctSum: check("rb_arrangement_pct_sum", sql`pass_through_pct + retention_pct = 100`),
    pctRange: check(
      "rb_arrangement_pct_range",
      sql`pass_through_pct >= 0 AND pass_through_pct <= 100 AND retention_pct >= 0 AND retention_pct <= 100`,
    ),
    effectiveRange: check(
      "rb_arrangement_effective_range",
      sql`effective_to IS NULL OR effective_from <= effective_to`,
    ),
    ratesPositive: check(
      "rb_arrangement_rates_positive",
      sql`nf_per_diem_routine_cents >= 0 AND nf_per_diem_resp_cents >= 0 AND nf_per_diem_gip_cents >= 0`,
    ),
    // no-overlap EXCLUDE (btree_gist) declared in SQL 0093
  }),
);

export const rbDay = pgTable(
  "rb_day",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, organization_id) in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }), // partition key
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id), // nullable (§3.3)
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    rbArrangementId: uuid("rb_arrangement_id")
      .notNull()
      .references(() => rbArrangement.id, { onDelete: "restrict" }),
    serviceDate: timestamp("service_date", { withTimezone: true, mode: "date" }).notNull(),

    locOfDay: m24ClaimLineLoc("loc_of_day").notNull(), // snapshotted from M6 at sweep
    locPeriodIdSnapshot: uuid("loc_period_id_snapshot").notNull(), // logical FK → M6
    perDiemCentsSnapshot: integer("per_diem_cents_snapshot").notNull(),

    status: m24RbDayStatus("status").notNull().default("pending"),
    exclusionReason: text("exclusion_reason"),

    medicaidClaimLineId: uuid("medicaid_claim_line_id"), // logical FK → medicaid_claim_line (partitioned)

    version: integer("version").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerPatientServiceDate: index("rb_day_unique_per_patient_service_date").on(
      t.organizationId,
      t.patientId,
      t.serviceDate,
    ),
    byArrangementDate: index("rb_day_by_arrangement_date").on(t.rbArrangementId, t.serviceDate),
    billedRequiresClaimLine: check(
      "rb_day_billed_requires_claim_line",
      sql`(status != 'billed') OR (status = 'billed' AND medicaid_claim_line_id IS NOT NULL)`,
    ),
  }),
);
