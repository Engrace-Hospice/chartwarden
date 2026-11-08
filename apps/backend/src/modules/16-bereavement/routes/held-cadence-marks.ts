// apps/backend/src/modules/16-bereavement/routes/held-cadence-marks.ts — ADR-0109 D4.
//
// The cadence marks a contact's schedule already holds, read before a FORWARD fill (a tier-change top-up,
// regenerate, resume, rescind) so the fill adds only the floor contacts that are missing. A row counts as
// holding its mark in every status except `cancelled`: scheduled, in progress, completed, declined, missed and
// no-response rows are all contacts the family has been (or will be) given, while a cancelled row is exactly
// what a fill exists to replace. A row written before `cadence_mark` existed is classified by
// `inferLegacyMark`; one that matches no floor contact (an ad-hoc touchpoint) holds nothing.
import { type BereavementCadenceMark, inferLegacyMark } from "@chartwarden/bereavement";
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, ne } from "drizzle-orm";

const OUTREACH = schema.bereavementOutreach;

export async function heldCadenceMarks(
  tx: Pick<DbClient, "select">,
  contactId: string,
): Promise<BereavementCadenceMark[]> {
  const rows = await tx
    .select({
      cadenceMark: OUTREACH.cadenceMark,
      kind: OUTREACH.kind,
      anniversaryMark: OUTREACH.anniversaryMark,
      deathAnchorAt: OUTREACH.deathAnchorAt,
      dueAt: OUTREACH.dueAt,
    })
    .from(OUTREACH)
    .where(and(eq(OUTREACH.bereavedContactId, contactId), ne(OUTREACH.status, "cancelled")));
  return rows.flatMap((row) => {
    const mark =
      (row.cadenceMark as BereavementCadenceMark | null) ??
      inferLegacyMark({
        kind: row.kind,
        anniversaryMark: row.anniversaryMark,
        deathAnchorAt: row.deathAnchorAt.toISOString(),
        dueAt: row.dueAt.toISOString(),
      });
    return mark === null ? [] : [mark];
  });
}
