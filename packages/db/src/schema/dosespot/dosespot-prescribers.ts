// @wardenx/db — `dosespot_prescriber` (M12 §3.3). The per-tenant prescriber roster that backs the §4.7 ABAC
// predicates: each row links an M1 `membership` to its DoseSpot prescriber id, NPI/DEA, the DEA-authorized
// schedule array, and the §1311.115 IAL2 identity-proofing status + EPCS enablement (D18). Org-scoped (no
// patient column). `external_physician_mdm_id` (M40) is a plain uuid app-validated, NOT a cross-module FK;
// `membership_id` FKs M1. The `dosespot_prescriber_epcs_consistency` CHECK enforces that EPCS can only be
// enabled once IAL2 is verified AND a DEA number + at least one authorized schedule exist. The
// (organization_id, membership_id) unique index gives one roster entry per member per tenant. RLS + grants +
// the M4 write-audit trigger land in the RLS migration (M12-T02).
import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ial2Status } from "../../enums";
import { organizations } from "../organizations";
import { memberships } from "../memberships";

export const dosespotPrescribers = pgTable(
  "dosespot_prescriber",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    externalPhysicianMdmId: uuid("external_physician_mdm_id"), // M40 (app-validated; no FK)

    dosespotPrescriberId: text("dosespot_prescriber_id"),
    // NOT NULL relaxed in mig 0132 (M12L): `enrollPrescriber` threads no NPI (captured at IAL2 proofing).
    npi: text("npi"),
    dea: text("dea"),
    deaAuthorizedSchedules: text("dea_authorized_schedules").array(),

    ial2Status: ial2Status("ial2_status").notNull().default("not_started"),
    ial2VerifiedAt: timestamp("ial2_verified_at", { withTimezone: true }),
    ial2ExpiresAt: timestamp("ial2_expires_at", { withTimezone: true }),
    epcsEnabled: boolean("epcs_enabled").notNull().default(false),

    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: text("revocation_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerOrgMembership: uniqueIndex("dosespot_prescriber_unique").on(
      t.organizationId,
      t.membershipId,
    ),
    epcsConsistency: check(
      "dosespot_prescriber_epcs_consistency",
      sql`(epcs_enabled = true) <= (ial2_status = 'verified' AND dea IS NOT NULL AND array_length(dea_authorized_schedules, 1) > 0)`,
    ),
  }),
);

export type DosespotPrescriber = typeof dosespotPrescribers.$inferSelect;
export type NewDosespotPrescriber = typeof dosespotPrescribers.$inferInsert;
