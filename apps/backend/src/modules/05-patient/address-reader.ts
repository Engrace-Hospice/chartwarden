// apps/backend/src/modules/05-patient/address-reader.ts — M5 `PatientAddressReader` seam impl
// (TASK-015/ARCH-018).
//
// The single fact the M31 `state_two_party_recording_consent_present` ABAC predicate needs (D9/§3.8):
// the patient's current residence state, to check against the two-party recording-consent matrix. A
// seam, not a shared service import, so M31 gains no schema edge into M5 (ADR-0005) — mirrors the
// `PatientCoverageReader` precedent (`coverage-reader.ts`).
//
// Reads run under `withOrgContext` so Postgres RLS scopes them to the calling org. "Current" means the
// row with `effective_to IS NULL` (M5's append-only address-history convention); "primary" is the
// `is_primary` flag M5 maintains as at most one true row per patient.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { PatientAddressReader } from "@wardenx/types";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";

export function buildPatientAddressReader(db: DbClient): PatientAddressReader {
  const ADDRESS = schema.patientAddresses;

  return {
    async primaryResidenceState(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [row] = await tx
          .select({ state: ADDRESS.state })
          .from(ADDRESS)
          .where(
            and(
              eq(ADDRESS.organizationId, organizationId),
              eq(ADDRESS.patientId, patientId),
              eq(ADDRESS.isPrimary, true),
              isNull(ADDRESS.effectiveTo),
            ),
          )
          .limit(1);
        return row?.state ?? null;
      });
    },
    async residenceAt(organizationId, patientId, asOfDate) {
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [row] = await tx
          .select({
            kind: ADDRESS.kind,
            facilityId: ADDRESS.facilityId,
            postalCode: ADDRESS.postalCode,
          })
          .from(ADDRESS)
          .where(
            and(
              eq(ADDRESS.organizationId, organizationId),
              eq(ADDRESS.patientId, patientId),
              eq(ADDRESS.isPrimary, true),
              lte(ADDRESS.effectiveFrom, asOfDate),
              or(isNull(ADDRESS.effectiveTo), gte(ADDRESS.effectiveTo, asOfDate)),
            ),
          )
          .limit(1);
        return row
          ? { kind: row.kind, facilityId: row.facilityId, postalCode: row.postalCode ?? null }
          : null;
      });
    },
  };
}

/** The current residence address row M6 snapshots onto an admission's service address. */
export interface CurrentResidenceAddress {
  readonly id: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string | null;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * The patient's CURRENT residence (`effective_to IS NULL`, `kind = 'home'` or `is_primary`), primary first
 * then most-recently effective — the address M6 snapshots onto an admission as its service address.
 *
 * Unlike {@link buildPatientAddressReader}'s seam methods (which open their own `withOrgContext`), this
 * runs on the CALLER's org-context tx: M6 (which lists M5 in `dependsOn`) reads it inside the same
 * admission-update transaction that writes the snapshot, so RLS scope and snapshot are the caller's.
 */
export async function readCurrentResidenceAddress(
  tx: DbClient,
  organizationId: string,
  patientId: string,
): Promise<CurrentResidenceAddress | null> {
  const ADDRESS = schema.patientAddresses;
  const [addr] = await tx
    .select({
      id: ADDRESS.id,
      line1: ADDRESS.line1,
      line2: ADDRESS.line2,
      city: ADDRESS.city,
      state: ADDRESS.state,
      postalCode: ADDRESS.postalCode,
      country: ADDRESS.country,
    })
    .from(ADDRESS)
    .where(
      and(
        eq(ADDRESS.organizationId, organizationId),
        eq(ADDRESS.patientId, patientId),
        isNull(ADDRESS.effectiveTo),
        or(eq(ADDRESS.kind, "home"), eq(ADDRESS.isPrimary, true)),
      ),
    )
    .orderBy(desc(ADDRESS.isPrimary), desc(ADDRESS.effectiveFrom))
    .limit(1);
  return addr ?? null;
}
