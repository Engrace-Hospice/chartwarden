// apps/backend/src/modules/05-patient/mbi-unlock-reader.ts — M5's `MbiUnlockReader` seam impl (M23 §4.4 /
// §8.7; M5-published, M23-ONLY consumer: the HETS 270 build).
//
// Returns the transient beneficiary identity a HETS 270 needs (CMS HETS Companion Guide §7.3: MBI + legal
// last/first name + DOB) for the patient's Medicare FFS coverage. The MBI is `patient_payer.subscriber_id`
// for a `medicare_ffs` coverage (M5 §3.4). Coverage choice: the caller's `expectedPatientPayerId` when given (exactly
// that row, scoped to patient + org, or nothing); otherwise the highest-ranked `medicare_ffs` coverage in force on the
// as-of date, else the patient's current (open-ended) `medicare_ffs` coverage — HETS itself answers for the
// requested dates, so a coverage row whose dates were keyed imprecisely still gets checked.
//
// This module returns the value and holds nothing: no cache, no log line. EVERY unlock carries a `disclosure` and
// writes a `patient_payer.mbi_disclosed` audit_event (ids + purpose + actor, never the MBI) in the SAME transaction
// as the read, so a disclosure that cannot be audited returns nothing. Reads run under `withOrgContext` as the system actor
// (RLS scopes them to the org the caller names — a seam has no request context).
import { randomUUID } from "node:crypto";
import { audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import {
  type EligibilitySubscriberIdentity,
  MBI_DISCLOSURE_PURPOSES,
  type MbiUnlockReader,
} from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const day = (d: Date | string | null): string | null => {
  if (d === null) return null;
  return (d instanceof Date ? d.toISOString() : new Date(d).toISOString()).slice(0, 10);
};

/** The audit event type for an MBI unlock made for a disclosure purpose (see `disclosure` on the seam). */
export const MBI_DISCLOSED_EVENT = "patient_payer.mbi_disclosed";

type MbiUnlockInput = Parameters<MbiUnlockReader["unlockForEligibility"]>[0];

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCLOSURE_PURPOSES: ReadonlySet<string> = new Set(MBI_DISCLOSURE_PURPOSES);

/**
 * The audit context is ids-only: a purpose outside the closed set, or a subject/actor that is not uuid-shaped, could
 * smuggle an identifier (an MBI, a name) into the audit row, so it is refused before anything is read.
 */
function assertDisclosureShape(disclosure: MbiUnlockInput["disclosure"]): void {
  if (!DISCLOSURE_PURPOSES.has(disclosure.purpose)) {
    throw new Error("MBI unlock refused: disclosure.purpose is not a recognised purpose");
  }
  if (!UUID_SHAPE.test(disclosure.subjectId)) {
    throw new Error("MBI unlock refused: disclosure.subjectId must be a uuid");
  }
  if (disclosure.actorUserId !== undefined && !UUID_SHAPE.test(disclosure.actorUserId)) {
    throw new Error("MBI unlock refused: disclosure.actorUserId must be a uuid");
  }
  if (disclosure.correlationId !== undefined && !UUID_SHAPE.test(disclosure.correlationId)) {
    throw new Error("MBI unlock refused: disclosure.correlationId must be a uuid");
  }
}

export function buildMbiUnlockReader(db: DbClient): MbiUnlockReader {
  const PAYER = schema.patientPayers;
  const PATIENT = schema.patients;

  return {
    async unlockForEligibility({
      organizationId,
      patientId,
      onDate,
      disclosure,
      expectedPatientPayerId,
    }) {
      assertDisclosureShape(disclosure);
      return withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
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
          expectedPatientPayerId !== undefined
            ? ranked.find((c) => c.id === expectedPatientPayerId)
            : (ranked.find((c) => c.from <= onDate && (c.to === null || c.to >= onDate)) ??
              ranked.find((c) => c.to === null));
        if (!chosen) return null;
        await audit(
          tx,
          {
            organizationId,
            userId: disclosure.actorUserId ?? null,
            actorKind: disclosure.actorUserId === undefined ? "system" : "user",
            correlationId: disclosure.correlationId ?? randomUUID(),
          },
          {
            eventType: MBI_DISCLOSED_EVENT,
            resourceKind: "patient_payer",
            resourceId: chosen.id,
            outcome: "success",
            severity: "warn",
            context: {
              purpose: disclosure.purpose,
              subjectId: disclosure.subjectId,
              patientId,
            },
          },
        );
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
