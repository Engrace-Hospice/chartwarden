// apps/backend/src/modules/12-dosespot/tenant-config/roster-store.ts — the Drizzle `RosterStore` for a prescriber's vendor
// enrolment, over ONE open org-scoped transaction (RLS scopes every statement to the tenant). Only the registration's status and
// environment are read from `dosespot_clinic_registration`; the roster row is `dosespot_prescriber` (M12-owned, both).
import { type DbClient, schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  REGISTRATION_MOVED_CODE,
  type RosterRow,
  type RosterStore,
  linkConfirmedBy,
} from "./prescriber-enrollment";
import { vendorWriteIsCurrent } from "./registration-target";

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
  linkConfirmedMdmId: r.linkConfirmedMdmId,
  linkConfirmedNpi: r.linkConfirmedNpi,
  linkConfirmedByMembershipId: r.linkConfirmedByMembershipId,
  linkedByMembershipId: r.linkedByMembershipId,
});

export function createDrizzleRosterStore(tx: DbClient): RosterStore {
  return {
    async registration(organizationId) {
      const [row] = await tx
        .select({ status: R.status, environment: R.environment, clinicId: R.clinicId })
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

    async ensureRequested(organizationId, membershipId, at, claimWindowMs, expected) {
      const [existing] = await tx
        .select()
        .from(P)
        .where(and(eq(P.organizationId, organizationId), eq(P.membershipId, membershipId)))
        .for("update");
      // the profile was derived from the physician record this row linked, and the prescriber's confirmation covered, a moment ago: a
      // roster edit since then (a re-link or a revoke clears the confirmation) voids both
      if (
        !existing ||
        !linkConfirmedBy(toRow(existing), {
          physicianMdmId: expected.physicianMdmId,
          npi: expected.confirmedNpi,
        })
      ) {
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

    async confirmLink(organizationId, membershipId, input) {
      const [row] = await tx
        .update(P)
        .set({
          linkConfirmedMdmId: input.mdmId,
          linkConfirmedNpi: input.npi,
          linkConfirmedAt: input.at,
          // the member themself: the table's CHECK refuses anyone else's membership here
          linkConfirmedByMembershipId: membershipId,
          updatedAt: input.at,
        })
        .where(
          and(
            eq(P.organizationId, organizationId),
            eq(P.membershipId, membershipId),
            isNull(P.revokedAt),
            // pinned: only while the row still links the record the prescriber was shown
            eq(P.externalPhysicianMdmId, input.mdmId),
            // and only while someone ELSE made that link: a recorded maker other than the member (a re-link by the member themself since
            // the read stops it here, and a link with no recorded maker, which the member could have made, is never confirmable)
            sql`${P.linkedByMembershipId} IS NOT NULL AND ${P.linkedByMembershipId} <> ${membershipId}::uuid`,
          ),
        )
        .returning();
      return row ? toRow(row) : null;
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
      // FIRST, before any row lock of this transaction's own: the registration may have moved to another clinic while the vendor call ran
      if (!(await vendorWriteIsCurrent(tx, organizationId, input.expectedTarget))) {
        throw new ChartWardenError(
          REGISTRATION_MOVED_CODE,
          "the DoseSpot registration moved to another clinic while this enrollment was in flight; nothing was linked, enroll the prescriber again",
          409,
        );
      }
      const mdmMatches =
        input.expectedPhysicianMdmId === null
          ? isNull(P.externalPhysicianMdmId)
          : eq(P.externalPhysicianMdmId, input.expectedPhysicianMdmId);
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
            mdmMatches, // re-linked to another physician meanwhile: the NPI sent to the vendor is not this member's any more
            // and the member's own confirmation of that record and NPI must still stand (a re-link or a revoke clears it)
            eq(P.linkConfirmedMdmId, input.expectedPhysicianMdmId ?? sql`NULL`),
            eq(P.linkConfirmedNpi, input.npi),
            eq(P.linkConfirmedByMembershipId, P.membershipId),
            // and the link has a recorded maker, who is not the confirmer (a link with no recorded maker is never enrolled)
            sql`${P.linkedByMembershipId} IS NOT NULL AND ${P.linkedByMembershipId} IS DISTINCT FROM ${P.linkConfirmedByMembershipId}`,
          ),
        )
        .returning();
      if (row) return toRow(row);
      const [now] = await tx
        .select({ revokedAt: P.revokedAt })
        .from(P)
        .where(and(eq(P.organizationId, organizationId), eq(P.membershipId, membershipId)))
        .limit(1);
      if (now && now.revokedAt === null) throw rosterChanged();
      throw new ChartWardenError(
        "DOSESPOT_PRESCRIBER_REVOKED",
        "this prescriber was revoked from the roster while the enrollment was in flight; nothing was linked",
        409,
      );
    },
  };
}
