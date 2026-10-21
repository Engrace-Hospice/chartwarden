// apps/backend/src/modules/15-discipline-care-plans/consumers/patient-care-hours.ts — §7.6 / M15-F04.
//
// Resolves the 418.78(e) denominator (staff patient-care minutes for one provider entity × fiscal year)
// from M8's signed-encounter digests via the §4.7 `SignedEncountersReader` seam — never M8's tables. The
// patients of a provider entity come from M15's OWN `discipline_care_plan` rows (every admitted patient has
// plan stubs, §2.2.1), so no cross-module table read is needed.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, PatientId } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { getSignedEncountersReader } from "../seams/index";
import {
  type PatientCareHoursTally,
  addTallies,
  denominatorFromTally,
  tallyPatientCareMinutes,
} from "../volunteer/patient-care-hours";

const PLAN = schema.disciplineCarePlan;
const EMPTY: PatientCareHoursTally = { minutes: 0, resolvedCount: 0, unresolvedCount: 0 };

export interface StaffPatientCareMinutesInput {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly fiscalYear: number;
}

export type StaffPatientCareMinutesPort = (
  input: StaffPatientCareMinutesInput,
) => Promise<number | null>;

/** Tally the signed hands-on visits of `patientIds` served in `fiscalYear` (org-explicit seam reads). */
export async function tallyStaffPatientCareMinutes(args: {
  readonly organizationId: string;
  readonly patientIds: ReadonlyArray<PatientId>;
  readonly fiscalYear: number;
}): Promise<PatientCareHoursTally> {
  const reader = getSignedEncountersReader();
  const since = `${args.fiscalYear}-01-01T00:00:00.000Z` as IsoInstant;
  let total = EMPTY;
  for (const patientId of args.patientIds) {
    const digests = await reader.signedEncountersForPatientSince(
      args.organizationId,
      patientId,
      since,
    );
    total = addTallies(total, tallyPatientCareMinutes(digests, args.fiscalYear));
  }
  return total;
}

/**
 * The provider entity's patients are those with M15 plan stubs under that entity (§2.2.1). A patient with no
 * plan stub is NOT included in the denominator (no cross-module table read is made to find them) — documented
 * fallback, no change in behaviour.
 */
async function patientsOfProviderEntity(
  db: DbClient,
  input: StaffPatientCareMinutesInput,
): Promise<PatientId[]> {
  return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
    const rows = await (tx as unknown as DbClient)
      .selectDistinct({ patientId: PLAN.patientId })
      .from(PLAN)
      .where(
        and(
          eq(PLAN.organizationId, input.organizationId),
          eq(PLAN.providerEntityId, input.providerEntityId),
        ),
      );
    return rows.map((r) => r.patientId as PatientId);
  });
}

/**
 * The full denominator tally for one (provider entity × fiscal year): ONE seam call per patient, run by the
 * nightly hour aggregator (never at read time). Encounters with a null duration are excluded and reported
 * through `log`, never counted as 0.
 */
export async function computeStaffPatientCareTally(
  db: DbClient,
  input: StaffPatientCareMinutesInput,
  log?: { warn(obj: Record<string, unknown>, msg: string): void },
): Promise<PatientCareHoursTally> {
  const patientIds = await patientsOfProviderEntity(db, input);
  const tally = await tallyStaffPatientCareMinutes({
    organizationId: input.organizationId,
    patientIds,
    fiscalYear: input.fiscalYear,
  });
  if (tally.unresolvedCount > 0) {
    log?.warn(
      { ...input, unresolved: tally.unresolvedCount },
      "M15 patient-care hours: signed visits excluded — duration unresolved (not counted as zero)",
    );
  }
  return tally;
}

/** The denominator port over {@link computeStaffPatientCareTally}: `null` only when nothing resolved. */
export function createStaffPatientCareMinutesPort(
  db: DbClient,
  log?: { warn(obj: Record<string, unknown>, msg: string): void },
): StaffPatientCareMinutesPort {
  return async (input) => denominatorFromTally(await computeStaffPatientCareTally(db, input, log));
}
