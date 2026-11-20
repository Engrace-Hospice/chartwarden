// apps/backend/src/modules/05-patient/caregiver-roster-reader.ts — M5 `PatientCaregiverRosterReader` seam impl
// (GAP-129).
//
// M16 seeds a bereavement plan's contact list from the decedent's caregivers (spec §4.2 `seedFromCaregivers`).
// Before this seam the only bound M5 reads returned identity, not a roster, so the program opened with the counselor's
// additions or not at all. A seam, not a schema import: M16 has no edge into M5's tables (ADR-0005), mirroring
// `address-reader.ts` / `coverage-reader.ts`.
//
// `caregiversForPatient`: current links only (`involvement_to IS NULL`). `caregiversOn` (ADR-0114 S2b): the links in force on a given day,
// from their own involvement dates. Both: the primary caregiver first, then by creation order so the roster is stable across reads. Runs under `withOrgContext` (RLS scopes by `app.org_id`) with an org-explicit predicate on
// top — the caller is an HTTP route or an outbox consumer.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { PatientCaregiverRosterEntry, PatientCaregiverRosterReader } from "@chartwarden/types";
import { type SQL, and, asc, desc, eq, gte, isNull, lte, or } from "drizzle-orm";

/** A `YYYY-MM-DD` string that is a real calendar day (2026-02-30 is not): the one shape `caregiversOn` takes. */
function assertCalendarDay(on: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on);
  const real =
    match !== null &&
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
      .toISOString()
      .slice(0, 10) === on;
  if (!real) throw new RangeError(`caregiversOn: '${on}' is not a YYYY-MM-DD date`);
}

export function buildPatientCaregiverRosterReader(db: DbClient): PatientCaregiverRosterReader {
  const LINK = schema.patientCaregivers;
  const CAREGIVER = schema.caregivers;

  /** The roster rows whose link also satisfies `involved` (the current-links rule, or the as-of-a-day rule), primary first. */
  async function roster(
    organizationId: string,
    patientId: string,
    involved: SQL | undefined,
  ): Promise<readonly PatientCaregiverRosterEntry[]> {
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
            and(eq(LINK.organizationId, organizationId), eq(LINK.patientId, patientId), involved),
          )
          .orderBy(desc(LINK.isPrimary), asc(LINK.createdAt), asc(LINK.id));
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
  }

  return {
    caregiversForPatient: (organizationId, patientId) =>
      roster(organizationId, patientId, isNull(LINK.involvementTo)),

    // ADR-0114 S2b (VN-D11): as of a day, from each link's own involvement dates, never from today's state.
    caregiversOn(organizationId, patientId, on) {
      assertCalendarDay(on);
      return roster(
        organizationId,
        patientId,
        and(
          lte(LINK.involvementFrom, on),
          or(isNull(LINK.involvementTo), gte(LINK.involvementTo, on)),
        ),
      );
    },
  };
}
