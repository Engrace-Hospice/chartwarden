// @wardenx/db — `care_plan_signature` (M7 §3.3). One row per signer attestation on a care_plan_version
// (the D5 quorum is satisfied when every requiredSignerSet role has a row). PHI-bearing → three-column
// tenancy rule. membershipId references M1 `membership` (the signing actor). One signature per
// (version, signer_role) — the partial of the quorum. Structural row, no free-text denylist (§3.5).
// RLS + the M4 write-audit trigger land in migration 0029 (M7-T02).
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { carePlanSignerRole } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { carePlanVersions } from "./care-plan-versions";

export const carePlanSignatures = pgTable(
  "care_plan_signature",
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
    carePlanVersionId: uuid("care_plan_version_id")
      .notNull()
      .references(() => carePlanVersions.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    signerRole: carePlanSignerRole("signer_role").notNull(),
    signatureMethod: text("signature_method").notNull(), // 'passkey' | 'password_step_up'
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    attestationText: text("attestation_text").notNull(),
  },
  (t) => ({
    versionRoleUq: uniqueIndex("care_plan_signature_version_role_uq").on(
      t.carePlanVersionId,
      t.signerRole,
    ),
    versionIdx: index("care_plan_signature_version_idx").on(t.carePlanVersionId),
  }),
);

export type CarePlanSignature = typeof carePlanSignatures.$inferSelect;
export type NewCarePlanSignature = typeof carePlanSignatures.$inferInsert;
