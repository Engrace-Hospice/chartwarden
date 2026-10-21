// @chartwarden/db — `comfort_kit_deployment` (M13 §3.3 / §2.7 D5). One row per emergency/comfort-kit deployment to a
// patient's home: the deploy event, the M21 supply-dispatch back-ref, and the disposal/return lifecycle (the
// deceased/discharge cascade flips it to return_required). PHI-bearing (patient_id) → the three-column tenancy rule
// (provider_entity_id + location_id NOT NULL). Non-partitioned (§3.5). Cross-module refs (M5 patient, M6 admission,
// M21 supply dispatch) are plain uuid app-validated, NOT cross-module FKs. RLS + grants + the M4 write-audit trigger
// land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { comfortKitDisposalStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const comfortKitDeployments = pgTable(
  "comfort_kit_deployment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),

    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull(),
    deployedByMembershipId: uuid("deployed_by_membership_id"),
    m21SupplyDispatchId: uuid("m21_supply_dispatch_id"), // M21 (app-validated; no FK)

    disposalStatus: comfortKitDisposalStatus("disposal_status").notNull().default("deployed"),
    returnRequiredAt: timestamp("return_required_at", { withTimezone: true }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    disposalReconciliationStatus: text("disposal_reconciliation_status"), // 'matched' | 'discrepancy' | 'pending'

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPatient: index("kit_deploy_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.deployedAt.desc(),
    ),
    activeReturnRequired: index("kit_deploy_return_required_idx")
      .on(t.organizationId, t.returnRequiredAt.asc())
      .where(sql`disposal_status = 'return_required'`),
    // F-166 (#248, migration 0259) — the `m21.comfort_kit.deployed_at_patient` consumer's redelivery
    // guard. NULLS DISTINCT (default): rows with no dispatch link coexist freely.
    byM21Dispatch: unique("comfort_kit_deployment_m21_dispatch_uq").on(
      t.organizationId,
      t.m21SupplyDispatchId,
    ),
  }),
);

export type ComfortKitDeployment = typeof comfortKitDeployments.$inferSelect;
export type NewComfortKitDeployment = typeof comfortKitDeployments.$inferInsert;
