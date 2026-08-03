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
import { and, eq, isNull } from "drizzle-orm";

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
  };
}
