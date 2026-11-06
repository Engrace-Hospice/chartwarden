// apps/backend/src/modules/12-dosespot/tenant-config/roster-store.ts — the Drizzle `RosterStore` for a prescriber's vendor
// enrolment, over ONE open org-scoped transaction (RLS scopes every statement to the tenant). Only the registration's status is
// read from `dosespot_clinic_registration`; the roster row is `dosespot_prescriber` (M12-owned, both).
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import type { RosterRow, RosterStore } from "./prescriber-enrollment";

const R = schema.dosespotClinicRegistrations;
const P = schema.dosespotPrescribers;

const toRow = (r: typeof P.$inferSelect): RosterRow => ({
  id: r.id,
  membershipId: r.membershipId,
  dosespotPrescriberId: r.dosespotPrescriberId,
  revokedAt: r.revokedAt,
  vendorEnrollmentRequestedAt: r.vendorEnrollmentRequestedAt,
  npi: r.npi,
});

export function createDrizzleRosterStore(tx: DbClient): RosterStore {
  return {
    async configStatus(organizationId) {
      const [row] = await tx
        .select({ status: R.status })
        .from(R)
        .where(eq(R.organizationId, organizationId))
        .limit(1);
      return row?.status ?? null;
    },

    async ensureRequested(organizationId, membershipId, at) {
      const [row] = await tx
        .insert(P)
        .values({
          organizationId,
          membershipId,
          deaAuthorizedSchedules: [],
          enrolledAt: at,
          vendorEnrollmentRequestedAt: at,
        })
        .onConflictDoUpdate({
          target: [P.organizationId, P.membershipId],
          set: {
            vendorEnrollmentRequestedAt: at,
            // a prescriber re-enrolled with the vendor is back on the roster
            enrolledAt: at,
            revokedAt: null,
            revocationReason: null,
            updatedAt: at,
          },
        })
        .returning();
      if (!row) throw new Error("dosespot_prescriber upsert returned no row");
      return toRow(row);
    },

    async recordVendorId(organizationId, membershipId, input) {
      const [row] = await tx
        .update(P)
        .set({
          dosespotPrescriberId: input.dosespotPrescriberId,
          npi: input.npi,
          updatedAt: input.at,
        })
        .where(and(eq(P.organizationId, organizationId), eq(P.membershipId, membershipId)))
        .returning();
      if (!row) throw new Error("the roster row vanished before its vendor id was recorded");
      return toRow(row);
    },
  };
}
