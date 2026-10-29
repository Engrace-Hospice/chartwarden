import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, sql } from "drizzle-orm";

/** The small patient identity an already authorized admission read may display. */
export interface AdmissionPatientIdentity {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly mrn: string;
}

/** Runs on the caller's tenant-scoped transaction; M5 alone reads its patient table. */
export async function patientAdmissionIdentitiesInTx(
  tx: DbClient,
  organizationId: string,
  patientIds: readonly string[],
): Promise<Map<string, AdmissionPatientIdentity>> {
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: schema.patients.id,
      firstName: schema.patients.legalFirstName,
      lastName: schema.patients.legalLastName,
      mrn: schema.patients.mrn,
    })
    .from(schema.patients)
    .where(
      and(eq(schema.patients.organizationId, organizationId), inArray(schema.patients.id, ids)),
    );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Whole-year ages for the census list (no date of birth leaves M5). Same tenant-scoped transaction as
 * the identity read; a patient the caller's transaction cannot see is simply absent from the map.
 */
export async function patientAgeYearsInTx(
  tx: DbClient,
  organizationId: string,
  patientIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: schema.patients.id,
      ageYears: sql<number>`date_part('year', age(${schema.patients.dob}))::int`,
    })
    .from(schema.patients)
    .where(
      and(eq(schema.patients.organizationId, organizationId), inArray(schema.patients.id, ids)),
    );
  return new Map(rows.map((row) => [row.id, Number(row.ageYears)]));
}
