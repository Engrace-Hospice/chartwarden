// apps/backend/src/modules/12-dosespot/tenant-config/roster-store.ts — the Drizzle `RosterStore` for a prescriber's vendor
// enrolment, over ONE open org-scoped transaction (RLS scopes every statement to the tenant). Only the registration's status is
// read from `dosespot_clinic_registration`; the roster row is `dosespot_prescriber` (M12-owned, both).
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import type { RosterRow, RosterStore } from "./prescriber-enrollment";

const R = schema.dosespotClinicRegistrations;
const P = schema.dosespotPrescribers;
const M = schema.memberships;

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

    async membershipExists(organizationId, membershipId) {
      const [row] = await tx
        .select({ id: M.id })
        .from(M)
        .where(and(eq(M.id, membershipId), eq(M.organizationId, organizationId)))
        .limit(1);
      return row !== undefined;
    },

    async ensureRequested(organizationId, membershipId, at, claimWindowMs) {
      const [existing] = await tx
        .select()
        .from(P)
        .where(and(eq(P.organizationId, organizationId), eq(P.membershipId, membershipId)))
        .for("update");
      if (!existing) {
        const [created] = await tx
          .insert(P)
          .values({
            organizationId,
            membershipId,
            deaAuthorizedSchedules: [],
            enrolledAt: at,
            vendorEnrollmentRequestedAt: at,
          })
          .returning();
        if (!created) throw new Error("dosespot_prescriber insert returned no row");
        return { row: toRow(created), inProgress: false };
      }
      // a revoked or already-linked prescriber is returned untouched: nothing is stamped and nothing is reinstated
      if (existing.revokedAt !== null || existing.dosespotPrescriberId !== null) {
        return { row: toRow(existing), inProgress: false };
      }
      const marker = existing.vendorEnrollmentRequestedAt;
      if (marker !== null && at.getTime() - marker.getTime() < claimWindowMs) {
        return { row: toRow(existing), inProgress: true };
      }
      const [stamped] = await tx
        .update(P)
        .set({ vendorEnrollmentRequestedAt: at, updatedAt: at })
        .where(eq(P.id, existing.id))
        .returning();
      if (!stamped) throw new Error("dosespot_prescriber update returned no row");
      return { row: toRow(stamped), inProgress: false };
    },

    async releaseRequest(organizationId, membershipId) {
      await tx
        .update(P)
        .set({ vendorEnrollmentRequestedAt: null })
        .where(and(eq(P.organizationId, organizationId), eq(P.membershipId, membershipId)));
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
