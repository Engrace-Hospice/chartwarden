// @chartwarden/db — `portal_access_grant` (M31 §3.3, M31-T02). D5/D6/D7's per-patient authorization: one
// active row per (account, patient) says "this account may read THIS patient's records, in THIS scope,
// on the authority of THIS M39 consent". Revocation writes a terminal row and a re-grant is a NEW row
// (§3.3 partial unique on `revoked_at IS NULL`).
//
// TENANCY (ARCH-011): this row IS patient-bearing (patient_id), so beyond organization_id NOT NULL it
// carries provider_entity_id NOT NULL + location_id (nullable) — denormalized from the patient's
// admission/care context at grant time so the §4.3 caseload-equivalent + engagement seams roll up per
// CCN/location without joining through M5/M6. The spec §3.3 sketch omits these two columns; ARCH-011's
// three-column rule for PHI rows is authoritative, so they are added here (the gate — check-tenancy —
// requires them). RLS keys on app.org_id ALONE (0139); the per-account narrowing
// (`portal_grant_active_for_patient`) is M3 ABAC at the route, never a second permissive policy.
//
// CROSS-MODULE FK POLICY: organization/provider_entity/location (M1 core) + the intra-M31 account parent
// carry real FKs. patient_id (M5), source_consent_record_id (M39), granted_by/revoked_by_membership_id
// (M2) are LOGICAL uuid, app-validated at the write boundary.
//
// AUDIT DENYLIST (§3.6): `scope_set_jsonb` (size — grant metadata is logged separately) and
// `revoke_reason_cipher` (free-text) are denylisted (mirrors `M31_AUDIT_DENYLIST.portal_access_grant`).
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { portalAccessGrantKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { portalAccounts } from "./portal-accounts";

export const portalAccessGrants = pgTable(
  "portal_access_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    portalAccountId: uuid("portal_account_id")
      .notNull()
      .references(() => portalAccounts.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5 patient

    grantKind: portalAccessGrantKind("grant_kind").notNull(),
    // §2.3 resolved scope set (platform-floor + tenant-tighten); shape = @chartwarden/types `PortalScopeSet`.
    scopeSetJsonb: jsonb("scope_set_jsonb").notNull(), // §3.6 audit-denylisted (size)

    sourceConsentRecordId: uuid("source_consent_record_id").notNull(), // logical FK → M39 consent_record
    sourceConsentVersion: text("source_consent_version").notNull(),

    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    // NOT NULL relaxed in mig 0257 (F-150/F-164, #248): the D6 bereaved-mode lateral flip is a system
    // cascade off `m16.bereavement.plan_opened` (an outbox consumer, not a human actor) — the
    // `order_discontinuation.actor_membership_id` precedent, "NULL for system-actor cascades".
    grantedByMembershipId: uuid("granted_by_membership_id"), // logical FK → M2 membership

    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReasonCipher: text("revoke_reason_cipher"), // §3.6 audit-denylisted (free-text)
    revokedByMembershipId: uuid("revoked_by_membership_id"), // logical FK → M2 membership
    // §2.2.2 — WHY a grant was revoked; required whenever revoked_at is set (the CHECK below). Value set =
    // @chartwarden/types `PortalGrantRevokeCascadeSource` (text, app-validated).
    revokeCascadeSource: text("revoke_cascade_source"),

    version: integer("version").notNull().default(0), // §2.5 If-Match
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("portal_access_grant_org_idx").on(t.organizationId),
    accountPatientIdx: index("portal_access_grant_account_patient_idx").on(
      t.portalAccountId,
      t.patientId,
    ),
    // §3.4 — "who has portal access to this patient" caseload-equivalent lookup (active only).
    patientActiveIdx: index("portal_access_grant_patient_active_idx")
      .on(t.organizationId, t.patientId)
      .where(sql`revoked_at IS NULL`),
    // Only one active grant per (account, patient) — a re-grant after revocation is a new row.
    accountPatientActiveUnique: uniqueIndex("portal_access_grant_account_patient_active_unique")
      .on(t.portalAccountId, t.patientId)
      .where(sql`revoked_at IS NULL`),
    revokedRequiresSource: check(
      "portal_access_grant_revoked_requires_source",
      sql`revoked_at IS NULL OR revoke_cascade_source IS NOT NULL`,
    ),
  }),
);

export type PortalAccessGrantRow = typeof portalAccessGrants.$inferSelect;
export type NewPortalAccessGrantRow = typeof portalAccessGrants.$inferInsert;
