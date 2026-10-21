// apps/backend/src/modules/05-patient/geocode-coverage.ts — M5 read for the GAP-054 rollout signal.
//
// "Geofence-ready" mirrors what `PatientAddressReader.serviceAddressCoordinate` resolves when M18 supplies no
// address id: the patient's CURRENT PRIMARY address (`is_primary`, `effective_to IS NULL`) with BOTH
// `geocode_lat` and `geocode_lng` set. An ACTIVE patient with no such row (including no primary address at
// all) is one whose captures will record `no_geofence_baseline`. Counts only — no address or coordinate leaves
// this function, so the result is not PHI. (A visit pinned to a non-primary address is approximated by the
// primary one; the count is a rollout signal, not an audit of every visit.)
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";

export interface ActivePatientGeocodeCount {
  readonly activePatients: number;
  readonly ungeocoded: number;
}

export async function countActivePatientsWithoutGeocode(
  db: DbClient,
  organizationId: string,
): Promise<ActivePatientGeocodeCount> {
  const PATIENT = schema.patients;
  const ADDRESS = schema.patientAddresses;
  return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
    const geocodedPrimary = tx
      .select({ one: sql`1` })
      .from(ADDRESS)
      .where(
        and(
          eq(ADDRESS.organizationId, organizationId),
          eq(ADDRESS.patientId, PATIENT.id),
          eq(ADDRESS.isPrimary, true),
          isNull(ADDRESS.effectiveTo),
          isNotNull(ADDRESS.geocodeLat),
          isNotNull(ADDRESS.geocodeLng),
        ),
      );
    const active = and(eq(PATIENT.organizationId, organizationId), eq(PATIENT.status, "active"));
    const [row] = await tx
      .select({
        activePatients: sql<string>`count(*)`,
        ungeocoded: sql<string>`count(*) filter (where ${notExists(geocodedPrimary)})`,
      })
      .from(PATIENT)
      .where(active);
    return {
      activePatients: Number(row?.activePatients ?? 0),
      ungeocoded: Number(row?.ungeocoded ?? 0),
    };
  });
}
