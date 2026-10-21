// @chartwarden/db — `care_plan_signature` (M7 §3.3). One row per signer attestation on a care_plan_version
// (the D5 quorum is satisfied when every requiredSignerSet role has a row). PHI-bearing → three-column
// tenancy rule. membershipId references M1 `membership` (the signing actor). One signature per
// (version, signer_role) — the partial of the quorum. Structural row, no free-text denylist (§3.5).
// RLS + the M4 write-audit trigger land in migration 0029 (M7-T02).
import { sql } from "drizzle-orm";
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
    // Denormalized siting; nullable (inherited from the version, which may be unsited; mig 0127).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    carePlanVersionId: uuid("care_plan_version_id")
      .notNull()
      .references(() => carePlanVersions.id, { onDelete: "restrict" }),
    // membership_id (signer) + attestation_text nullable: the sign route carries only the signer_role;
    // the CarePlanRouteService does not thread the acting membership yet (mig 0127).
    membershipId: uuid("membership_id").references(() => memberships.id, { onDelete: "restrict" }),
    signerRole: carePlanSignerRole("signer_role").notNull(),
    signatureMethod: text("signature_method").notNull().default("password_step_up"), // 'passkey' | 'password_step_up'
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    attestationText: text("attestation_text"),
    // D8: a return-to-draft INVALIDATES (never deletes) the collected signatures — chartwarden_app has no
    // DELETE on care-plan tables (append-only). Null = live; set = cleared (mig 0127).
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (t) => ({
    // Uniqueness is PARTIAL on live rows, so the same role can re-sign after a return-to-draft (mig 0127).
    versionRoleUq: uniqueIndex("care_plan_signature_version_role_uq")
      .on(t.carePlanVersionId, t.signerRole)
      .where(sql`invalidated_at IS NULL`),
    versionIdx: index("care_plan_signature_version_idx").on(t.carePlanVersionId),
  }),
);

export type CarePlanSignature = typeof carePlanSignatures.$inferSelect;
export type NewCarePlanSignature = typeof carePlanSignatures.$inferInsert;
