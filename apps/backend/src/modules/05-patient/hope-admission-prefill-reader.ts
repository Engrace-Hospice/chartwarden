import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  PatientHopeAdmissionPrefillFacts,
  PatientHopeAdmissionPrefillReader,
  PatientIdentifierKind,
} from "@wardenx/types";
import { asc, eq } from "drizzle-orm";

const SENSITIVE_IDENTIFIER_KINDS = new Set<PatientIdentifierKind>(["ssn", "state_id"]);

export function buildPatientHopeAdmissionPrefillReader(db: DbClient): PatientHopeAdmissionPrefillReader {
  const P = schema.patients;
  const ID = schema.patientIdentifiers;
  const COMM = schema.patientCommunicationPreferences;

  return {
    async factsForHopeAdmissionPrefill({ organizationId, patientId }) {
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [patient] = await tx
          .select({
            id: P.id,
            organizationId: P.organizationId,
            legalFirstName: P.legalFirstName,
            legalMiddleName: P.legalMiddleName,
            legalLastName: P.legalLastName,
            legalNameSuffix: P.legalNameSuffix,
            dob: P.dob,
            sexAssignedAtBirth: P.sexAssignedAtBirth,
            raceCodes: P.raceCodes,
            ethnicityCodes: P.ethnicityCodes,
            preferredLanguageCode: COMM.preferredLanguageCode,
          })
          .from(P)
          .leftJoin(COMM, eq(COMM.patientId, P.id))
          .where(eq(P.id, patientId))
          .limit(1);
        if (!patient || patient.organizationId !== organizationId) return null;
        const identifiers = await tx
          .select({
            kind: ID.kind,
            value: ID.value,
            effectiveFrom: ID.effectiveFrom,
            effectiveTo: ID.effectiveTo,
          })
          .from(ID)
          .where(eq(ID.patientId, patientId))
          .orderBy(asc(ID.kind), asc(ID.effectiveFrom));
        return {
          patientId: patient.id,
          organizationId: patient.organizationId,
          legalFirstName: patient.legalFirstName,
          legalMiddleName: patient.legalMiddleName ?? null,
          legalLastName: patient.legalLastName,
          legalNameSuffix: patient.legalNameSuffix ?? null,
          dob: patient.dob,
          sexAssignedAtBirth: patient.sexAssignedAtBirth,
          raceCodes: patient.raceCodes ?? [],
          ethnicityCodes: patient.ethnicityCodes ?? [],
          preferredLanguageCode: patient.preferredLanguageCode ?? null,
          identifiers: identifiers.map((identifier) => ({
            kind: identifier.kind as PatientIdentifierKind,
            value: SENSITIVE_IDENTIFIER_KINDS.has(identifier.kind) ? null : identifier.value,
            effectiveFrom: identifier.effectiveFrom,
            effectiveTo: identifier.effectiveTo ?? null,
          })),
        } satisfies PatientHopeAdmissionPrefillFacts;
      });
    },
  };
}
