// apps/backend/src/modules/10-hope/hope-assemble-candidates.ts — which signed records ONE `assembleSubmission` call looks
// at, how many, and the re-assertion that they are still packageable once the package is written.
//
// THE CAP. A call considers at most ASSEMBLE_CANDIDATE_LIMIT records, oldest signed first. Everything after the candidate
// read runs behind the per-provider-entity advisory key on one pooled connection, and each validation opens a second one, so
// an unbounded set (cancelling a large batch frees all of its records at once) held the key for minutes while a second
// assemble waited 5 s and answered `M10_RECORD_BUSY`. A package therefore holds at most that many records; the rest stay
// eligible, and the next call packages the next ones (the ordinary `409` "nothing eligible" says the entity is done).
//
// KNOWN-REFUSED RECORDS GO LAST. A record the validator refuses (an unresolved ERROR finding from its last final
// validation) or cannot validate (no location: its findings have nowhere to be stored) stays eligible by the SQL test, so
// ordering by age alone would let that many old refused records fill the cap and hide every newer record for good. They sort
// after the rest, so they are retried only when the cap has room.
import { type DbClient, schema } from "@chartwarden/db";
import { type SQL, and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { HopeValidationFindingSitingError } from "./hope-validation-service";
import { ASSEMBLE_BLOCKING_ITEM_STATUSES } from "./jobs/assemble-store";

const ASSESS = schema.hopeAssessments;
const SUBITEM = schema.hopeSubmissionItems;
const FINDING = schema.hopeValidationFindings;

/** The most signed records one assemble call looks at (and so the most one package holds). */
export const ASSEMBLE_CANDIDATE_LIMIT = 200;

type AssessmentRow = typeof ASSESS.$inferSelect;

/**
 * Every test of "this record may go into a package", all of them the database's. A signed record stays `signed` after it is
 * accepted, so these exclude what is already answered: frozen to a spec and ISC, no iQIES record id yet, and no item that
 * is pending or already answered. A rejected original is never re-sent unchanged: it is fixed by a correction (a new signed
 * row, which carries no item yet and so passes) in a NEW batch. A cancelled item does not count, so its record is packaged
 * again. A blank `iqies_record_id` is no longer a case: the result import does not stamp one, and `IS NULL` is what the
 * partial index `idx_hope_assess_org_unsubmitted` can answer (the cron scan reads the same test).
 */
function packageableRecords(organizationId: string, providerEntityId: string): SQL {
  return and(
    eq(ASSESS.organizationId, organizationId),
    eq(ASSESS.providerEntityId, providerEntityId),
    eq(ASSESS.status, "signed"),
    isNotNull(ASSESS.specVersionId),
    isNotNull(ASSESS.isc),
    isNull(ASSESS.iqiesRecordId),
    sql`not exists (select 1 from ${SUBITEM} where ${SUBITEM.hopeAssessmentId} = ${ASSESS.id} and ${inArray(
      SUBITEM.itemStatus,
      [...ASSEMBLE_BLOCKING_ITEM_STATUSES],
    )})`,
  ) as SQL;
}

/** True for a record the validator has refused before or cannot validate (see the file header). */
const knownRefused = sql`(${ASSESS.locationId} is null or exists (select 1 from ${FINDING} where ${FINDING.hopeAssessmentId} = ${ASSESS.id} and ${FINDING.organizationId} = ${ASSESS.organizationId} and ${FINDING.resolved} = false and ${FINDING.severity} = 'error'))`;

/**
 * The ids of the records to validate, in the order to try them: not known-refused first, then oldest signed first. Ids only:
 * the `data` payload of the rows is read once, for the records that pass (`lockPackageableRecords`).
 */
export async function readAssembleCandidateIds(
  t: DbClient,
  organizationId: string,
  providerEntityId: string,
  limit: number = ASSEMBLE_CANDIDATE_LIMIT,
): Promise<string[]> {
  const rows = await t
    .select({ id: ASSESS.id })
    .from(ASSESS)
    .where(packageableRecords(organizationId, providerEntityId))
    .orderBy(knownRefused, asc(ASSESS.signedAt), asc(ASSESS.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * The ids whose final validation raised no ERROR finding. A record with no siting (no provider entity or location, so its
 * findings cannot be stored) is SKIPPED, not fatal: one such record used to answer a 409 for every assemble of its entity.
 * `onUnsited` is told its id (a log line carries ids only). Any other failure is the caller's.
 */
export async function validateCandidates(
  candidateIds: readonly string[],
  validate: (
    assessmentId: string,
  ) => Promise<{ readonly findings: readonly { severity: string }[] }>,
  onUnsited: (assessmentId: string) => void,
): Promise<string[]> {
  const passed: string[] = [];
  for (const assessmentId of candidateIds) {
    try {
      const { findings } = await validate(assessmentId);
      if (!findings.some((finding) => finding.severity === "error")) passed.push(assessmentId);
    } catch (error) {
      if (!(error instanceof HopeValidationFindingSitingError)) throw error;
      onUnsited(assessmentId);
    }
  }
  return passed;
}

/**
 * The validated records that are STILL packageable, locked `FOR SHARE`, as full rows (the serializer reads `data`), oldest
 * first. The candidates were read, and validated one by one, before this: a correction SIGNED meanwhile has already flipped
 * its original to `superseded` (migration 0225: the trigger fires when the correction goes draft -> signed), and a record
 * that fell out of the test for any other reason must not be packaged either. Judging again here, under the advisory key and
 * just before the items are written, closes that window; the share lock keeps the trigger's UPDATE of these rows behind this
 * transaction (a wait bounded by the lock timeout the advisory key already set), so none is superseded between this read and
 * the item inserts.
 */
export async function lockPackageableRecords(
  t: DbClient,
  organizationId: string,
  providerEntityId: string,
  validatedIds: readonly string[],
): Promise<AssessmentRow[]> {
  if (validatedIds.length === 0) return [];
  return (await t
    .select()
    .from(ASSESS)
    .where(
      and(
        packageableRecords(organizationId, providerEntityId),
        inArray(ASSESS.id, [...validatedIds]),
      ),
    )
    .orderBy(asc(ASSESS.signedAt), asc(ASSESS.id))
    .for("share")) as AssessmentRow[];
}
