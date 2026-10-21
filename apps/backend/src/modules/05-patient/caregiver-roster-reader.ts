// apps/backend/src/modules/05-patient/caregiver-roster-reader.ts — M5 `PatientCaregiverRosterReader` seam impl
// (GAP-129).
//
// M16 seeds a bereavement plan's contact list from the decedent's caregivers (spec §4.2 `seedFromCaregivers`).
// Before this seam the only bound M5 reads returned identity, not a roster, so the program opened with the counselor's
// additions or not at all. A seam, not a schema import: M16 has no edge into M5's tables (ADR-0005), mirroring
// `address-reader.ts` / `coverage-reader.ts`.
//
// Current links only (`involvement_to IS NULL`), the primary caregiver first, then by creation order so the roster
// is stable across reads. Runs under `withOrgContext` (RLS scopes by `app.org_id`) with an org-explicit predicate on
// top — the caller is an HTTP route or an outbox consumer.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientCaregiverRosterEntry, PatientCaregiverRosterReader } from "@chartwarden/types";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

export function buildPatientCaregiverRosterReader(db: DbClient): PatientCaregiverRosterReader {
  const LINK = schema.patientCaregivers;
  const CAREGIVER = schema.caregivers;

  return {
    async caregiversForPatient(organizationId, patientId) {
      return withOrgContext(
        db,
        { organizationId, userId: "system" },
        async (tx): Promise<readonly PatientCaregiverRosterEntry[]> => {
          const rows = await tx
            .select({
              patientCaregiverId: LINK.id,
              caregiverId: CAREGIVER.id,
              firstName: CAREGIVER.firstName,
              lastName: CAREGIVER.lastName,
              relationship: LINK.relationship,
              isPrimary: LINK.isPrimary,
              email: CAREGIVER.email,
              phone: CAREGIVER.phone,
              preferredLanguageCode: CAREGIVER.preferredLanguageCode,
            })
            .from(LINK)
            .innerJoin(CAREGIVER, eq(CAREGIVER.id, LINK.caregiverId))
            .where(
              and(
                eq(LINK.organizationId, organizationId),
                eq(LINK.patientId, patientId),
                isNull(LINK.involvementTo),
              ),
            )
            .orderBy(desc(LINK.isPrimary), asc(LINK.createdAt));
          return rows.map((r) => ({
            caregiverId: r.caregiverId,
            patientCaregiverId: r.patientCaregiverId,
            displayName: `${r.firstName} ${r.lastName}`.trim(),
            relationship: r.relationship,
            isPrimary: r.isPrimary,
            email: r.email ?? null,
            phone: r.phone ?? null,
            preferredLanguageCode: r.preferredLanguageCode ?? null,
          }));
        },
      );
    },
  };
}
