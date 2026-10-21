import { sql } from "drizzle-orm";
// @chartwarden/db — `claim_line` (M23 Billing-Medicare §3.3; retention class `compliance`). Child line
// table of `claim`; internal-only write surface (the routes expose it read-only after a claim leaves
// DRAFT — spec §3.1). ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// PARTITIONING (declared in the SQL migration 0074+, NOT in Drizzle): spec §3.2 Phase B proposes
// partitioning claim_line like claim — LIST-partitioned on provider_entity_id, then created-at RANGE
// QUARTERLY. NOTE FOR THE MIGRATION AGENT: the spec DDL for claim_line does NOT carry a provider_entity_id column
// (only claim does). Resolve this in the migration phase — either denormalize provider_entity_id onto
// claim_line (preferred, so the partition key exists locally) or co-locate partitions with the parent.
// Do NOT silently add a column here at the kernel layer; the partition key decision is a migration call.
//
// CROSS-MODULE FK POLICY (architecture WINS): only organization_id (core) + claim_id (intra-M23) get
// real `.references(...)`. level_of_care_period_id (M6) and the M8 encounter ids inside
// backing_encounter_ids are LOGICAL FKs (mirrors the M27 cost-report precedent).
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claim } from "./claim";
import { m23ClaimLineLevelOfCare, m23ClaimLineQCode, m23ClaimLineRevenueCode } from "./types";
import type {
  ClaimLineBackingEncounterIds,
  ClaimLineIcdPointerPositions,
  ClaimLineModifiers,
} from "./types";

export const claimLine = pgTable(
  "claim_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id, { onDelete: "restrict" }),

    lineNumber: integer("line_number").notNull(), // 1..N within a claim

    revenueCode: m23ClaimLineRevenueCode("revenue_code").notNull(),
    qCode: m23ClaimLineQCode("q_code").notNull(),
    levelOfCare: m23ClaimLineLevelOfCare("level_of_care").notNull(),
    hcpcsCode: text("hcpcs_code"), // optional ancillary HCPCS

    serviceDateFrom: date("service_date_from").notNull(),
    serviceDateTo: date("service_date_to").notNull(),
    unitCount: integer("unit_count").notNull(), // days for per-diem; visits for SIA visits
    unitRateCents: bigint("unit_rate_cents", { mode: "number" }).notNull(),
    lineChargeCents: bigint("line_charge_cents", { mode: "number" }).notNull(),

    // Logical FKs back to M6/M8:
    levelOfCarePeriodId: uuid("level_of_care_period_id").notNull(), // M6
    backingEncounterIds: jsonb("backing_encounter_ids")
      .$type<ClaimLineBackingEncounterIds>()
      .notNull()
      .default(sql`'[]'::jsonb`), // M8 encounter UUIDs

    // ICD-10 pointer positions (claim-level ICD list maintained on the parent claim's payload):
    icdPointerPositions: jsonb("icd_pointer_positions")
      .$type<ClaimLineIcdPointerPositions>()
      .notNull()
      .default(sql`'[]'::jsonb`), // int[] referencing the claim's ICD list 1..12

    // Modifier codes (M38 value set cms_hospice_modifiers):
    modifiers: jsonb("modifiers").$type<ClaimLineModifiers>().notNull().default(sql`'[]'::jsonb`), // string[] up to 4 per X12

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    claimIdx: index("claim_line_claim_idx").on(t.claimId, t.lineNumber),
    uniqueLine: uniqueIndex("claim_line_unique_line_uq").on(t.claimId, t.lineNumber),
    serviceDateInRange: sql`CHECK (service_date_to >= service_date_from)`,
    unitPositive: sql`CHECK (unit_count > 0 AND unit_rate_cents >= 0)`,
    chargeMatches: sql`CHECK (line_charge_cents = unit_count * unit_rate_cents)`,
  }),
);

export type ClaimLine = typeof claimLine.$inferSelect;
export type NewClaimLine = typeof claimLine.$inferInsert;
