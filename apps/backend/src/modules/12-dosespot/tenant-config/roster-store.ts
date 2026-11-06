// apps/backend/src/modules/12-dosespot/tenant-config/roster-store.ts — the Drizzle `RosterStore` for a prescriber's vendor
// enrolment, over ONE open org-scoped transaction (RLS scopes every statement to the tenant). Only the registration's status and
// environment are read from `dosespot_clinic_registration`; the roster row is `dosespot_prescriber` (M12-owned, both).
import { type DbClient, schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, isNull } from "drizzle-orm";
import type { RosterRow, RosterStore } from "./prescriber-enrollment";

const R = schema.dosespotClinicRegistrations;
const P = schema.dosespotPrescribers;
const M = schema.memberships;

const rosterChanged = (): ChartWardenError =>
  new ChartWardenError(
    "DOSESPOT_ROSTER_CHANGED",
    "the prescriber roster changed while the enrollment was being prepared; try again",
    409,
  );

const toRow = (r: typeof P.$inferSelect): RosterRow => ({
  id: r.id,
  membershipId: r.membershipId,
  dosespotPrescriberId: r.dosespotPrescriberId,
  revokedAt: r.revokedAt,
  vendorEnrollmentRequestedAt: r.vendorEnrollmentRequestedAt,
  npi: r.npi,
  externalPhysicianMdmId: r.externalPhysicianMdmId,
});

export function createDrizzleRosterStore(tx: DbClient): RosterStore {
  return {
    async registration(organizationId) {
      const [row] = await tx
        .select({ status: R.status, environment: R.environment })
        .from(R)
        .where(eq(R.organizationId, organizationId))
        .limit(1);
      return row ?? null;
    },

    async membershipExists(organizationId, membershipId) {
      const [row] = await tx
        .select({ id: M.id })
        .from(M)
        .where(
          and(
            eq(M.id, membershipId),
            eq(M.organizationId, organizationId),
            eq(M.status, "active"), // a suspended or revoked member is not enrolled with the vendor
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async rosterRow(organizationId, membershipId) {
      const [row] = await tx
        .select()
        .from(P)
        .where(and(eq(P.organizationId, organizationId), eq(P.membershipId, membershipId)))
        .limit(1);
      return row ? toRow(row) : null;
    },

    async ensureRequested(organizationId, membershipId, at, claimWindowMs, expectedPhysicianMdmId) {
      const [existing] = await tx
        .select()
        .from(P)
        .where(and(eq(P.organizationId, organizationId), eq(P.membershipId, membershipId)))
        .for("update");
      // the profile was derived from the physician record this row linked a moment ago: a roster edit since then voids it
      if (!existing || existing.externalPhysicianMdmId !== expectedPhysicianMdmId) {
        throw rosterChanged();
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

    async releaseRequest(organizationId, membershipId, claimedAt) {
      await tx
        .update(P)
        .set({ vendorEnrollmentRequestedAt: null })
        .where(
          and(
            eq(P.organizationId, organizationId),
            eq(P.membershipId, membershipId),
            // only THIS attempt's own marker: a newer claim by someone else is left standing
            eq(P.vendorEnrollmentRequestedAt, claimedAt),
          ),
        );
    },

    async recordVendorId(organizationId, membershipId, input) {
      const [row] = await tx
        .update(P)
        .set({
          dosespotPrescriberId: input.dosespotPrescriberId,
          npi: input.npi,
          updatedAt: input.at,
        })
        .where(
          and(
            eq(P.organizationId, organizationId),
            eq(P.membershipId, membershipId),
            isNull(P.revokedAt), // revoked while the vendor call was in flight: never link a revoked prescriber
          ),
        )
        .returning();
      if (!row) {
        throw new ChartWardenError(
          "DOSESPOT_PRESCRIBER_REVOKED",
          "this prescriber was revoked from the roster while the enrollment was in flight; nothing was linked",
          409,
        );
      }
      return toRow(row);
    },
  };
}
