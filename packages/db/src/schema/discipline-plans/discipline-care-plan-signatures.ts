// @wardenx/db — `discipline_care_plan_signature` (M15 §3.3). One row per signer per version. The CoP
// 418.76 CHHA row is an ACKNOWLEDGMENT, not a cosignature (`is_acknowledgment = true`) — the §3.5 D11
// required-signer set distinguishes the two, and the sign transition is evaluated against the set frozen
// on the version. Append-only: a re-opened version clears its signatures (§2.2.2).
//
// `attestation_text` is the signer-facing legal attestation captured verbatim at sign time — it is
// audit-denylisted (§3.6) because it can embed patient-identifying prose.
//
// Tenancy (M15-F05): patient-bearing (inherited from the version) → organization_id + provider_entity_id +
// location_id NOT NULL. FKs: M1 core + the intra-module version parent; signer_membership_id (M2) is
// LOGICAL uuid.
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { disciplineCarePlanVersion } from "./discipline-care-plan-versions";

export const disciplineCarePlanSignature = pgTable(
  "discipline_care_plan_signature",
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
    versionId: uuid("version_id")
      .notNull()
      .references(() => disciplineCarePlanVersion.id, { onDelete: "restrict" }),

    signerMembershipId: uuid("signer_membership_id").notNull(), // logical FK → M2 membership
    signerRole: text("signer_role").notNull(), // DisciplineSignerRole (@wardenx/types)
    // §3.5 D11: the CHHA Aide-POC row acknowledges, it does not cosign. Spec §3.3 typed this `text`
    // defaulting to 'false' — a slip; the repo convention (and the semantics) is a real boolean.
    isAcknowledgment: boolean("is_acknowledgment").notNull().default(false),

    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    attestationText: text("attestation_text").notNull(), // audit-denylisted (§3.6)
    sessionClass: text("session_class"), // step-up posture at sign time (M2 §2.6)
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => ({
    versionRoleUq: uniqueIndex("discipline_care_plan_signature_version_role_uq").on(
      t.organizationId,
      t.versionId,
      t.signerRole,
    ),
    // GAP-045 — one membership fills at most ONE signer slot per version. Enforced by the BEFORE INSERT
    // trigger in migration 0329 (raises 23505 naming discipline_care_plan_signature_version_membership_uq),
    // NOT a unique index, so legacy duplicate rows do not block the deploy. No Drizzle mirror by design.
    versionIdx: index("discipline_care_plan_signature_version_idx").on(
      t.organizationId,
      t.versionId,
      t.signerRole,
    ),
  }),
);

export type DisciplineCarePlanSignature = typeof disciplineCarePlanSignature.$inferSelect;
export type NewDisciplineCarePlanSignature = typeof disciplineCarePlanSignature.$inferInsert;
