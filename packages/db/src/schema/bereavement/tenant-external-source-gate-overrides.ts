// @wardenx/db — `tenant_bereavement_external_source_gate_override` (M16 §3.3.9). The TIGHTEN-ONLY surface
// for D18's external-source first-contact gate.
//
// D18 is a platform floor: for a plan opened from an `hl7_external` death notification, the counselor's
// first contact is blocked until the medical director's cosign lands (`external_source_metadata.cosignStatus
// = 'cosigned'`). A tenant may ADD preconditions — a death-certificate copy in M22, a coordinator
// acknowledgment — by writing a row here. There is deliberately NO column that can switch the cosign
// requirement off: the shape of this table is the enforcement of "tenants may not loosen".
//
// This is the one M16 table that is org-level CONFIGURATION, not a patient record: no patient_id, no
// provider_entity_id / location_id (ARCH-011's three-column rule applies to PHI-bearing rows), one row per
// tenant, and `ON DELETE cascade` on the organization — an offboarded tenant's gate config has no reason to
// survive the org row, unlike the clinical tables' `restrict`.
//
// CROSS-MODULE FK POLICY: organization_id (M1 core) carries a real FK; configured_by_membership_id is a
// LOGICAL uuid → M2 membership, app-validated (the M15 precedent for every membership reference).
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantBereavementExternalSourceGateOverride = pgTable(
  "tenant_bereavement_external_source_gate_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The unique + FK constraint names are given EXPLICITLY and short. Drizzle's default naming
    // (`<table>_<column>_unique` / `<table>_<column>_<ref>_fk`) produces two names that both exceed
    // PostgreSQL's 63-char identifier limit on this table and TRUNCATE TO THE SAME STRING — the second
    // CREATE then fails with "constraint already exists". Migration 0100 uses these same short names.
    organizationId: uuid("organization_id")
      .notNull()
      .unique("berv_gate_override_org_unique")
      .references(() => organizations.id, { onDelete: "cascade" }),

    requireDeathCertificateUploaded: boolean("require_death_certificate_uploaded")
      .notNull()
      .default(false),
    requireCoordinatorAcknowledgment: boolean("require_coordinator_acknowledgment")
      .notNull()
      .default(false),
    additionalRationale: text("additional_rationale"), // D11 audit-denylisted (free prose)

    configuredByMembershipId: uuid("configured_by_membership_id").notNull(), // logical FK → M2 membership
    configuredAt: timestamp("configured_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export type TenantBereavementExternalSourceGateOverrideRow =
  typeof tenantBereavementExternalSourceGateOverride.$inferSelect;
export type NewTenantBereavementExternalSourceGateOverrideRow =
  typeof tenantBereavementExternalSourceGateOverride.$inferInsert;
