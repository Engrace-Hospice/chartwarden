// apps/backend/src/modules/05-patient/mbi-unlock-reader.ts — M5's `MbiUnlockReader` seam impl (M23 §4.4 /
// §8.7; M5-published, M23-ONLY consumer: the HETS 270 build).
//
// Returns the transient beneficiary identity a HETS 270 needs (CMS HETS Companion Guide §7.3: MBI + legal
// last/first name + DOB) for the patient's Medicare FFS coverage. The MBI is `patient_payer.subscriber_id`
// for a `medicare_ffs` coverage (M5 §3.4). Coverage choice: the highest-ranked `medicare_ffs` coverage in
// force on the as-of date, else the patient's current (open-ended) `medicare_ffs` coverage — HETS itself
// answers for the requested dates, so a coverage row whose dates were keyed imprecisely still gets checked.
//
// This module returns the value and holds nothing: no cache, no log line, no audit capture. Reads run under
// `withOrgContext` (RLS scopes them to the org the caller names — a seam has no request context).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { EligibilitySubscriberIdentity, MbiUnlockReader } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const day = (d: Date | string | null): string | null => {
  if (d === null) return null;
  return (d instanceof Date ? d.toISOString() : new Date(d).toISOString()).slice(0, 10);
};

export function buildMbiUnlockReader(db: DbClient): MbiUnlockReader {
  const PAYER = schema.patientPayers;
  const PATIENT = schema.patients;

  return {
    async unlockForEligibility({ organizationId, patientId, onDate }) {
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [patient] = await tx
          .select({
            lastName: PATIENT.legalLastName,
            firstName: PATIENT.legalFirstName,
            dob: PATIENT.dob,
          })
          .from(PATIENT)
          .where(and(eq(PATIENT.organizationId, organizationId), eq(PATIENT.id, patientId)))
          .limit(1);
        if (!patient) return null;
        const coverages = await tx
          .select({
            id: PAYER.id,
            rank: PAYER.rank,
            subscriberId: PAYER.subscriberId,
            effectiveFrom: PAYER.effectiveFrom,
            effectiveTo: PAYER.effectiveTo,
          })
          .from(PAYER)
          .where(
            and(
              eq(PAYER.organizationId, organizationId),
              eq(PAYER.patientId, patientId),
              eq(PAYER.coverageKind, "medicare_ffs"),
            ),
          );
        const ranked = coverages
          .map((c) => ({ ...c, from: day(c.effectiveFrom) ?? "", to: day(c.effectiveTo) }))
          .filter((c) => c.subscriberId.trim().length > 0)
          .sort((a, b) => a.rank - b.rank);
        const chosen =
          ranked.find((c) => c.from <= onDate && (c.to === null || c.to >= onDate)) ??
          ranked.find((c) => c.to === null);
        if (!chosen) return null;
        const identity: EligibilitySubscriberIdentity = {
          patientPayerId: chosen.id,
          mbi: chosen.subscriberId.trim().toUpperCase(),
          lastName: patient.lastName,
          firstName: patient.firstName,
          dateOfBirth: day(patient.dob) ?? "",
        };
        return identity;
      });
    },
  };
}
