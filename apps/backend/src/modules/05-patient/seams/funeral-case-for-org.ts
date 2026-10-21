// apps/backend/src/modules/05-patient/seams/funeral-case-for-org.ts — the MINIMUM decedent facts a redeemed
// funeral-home session may read (GAP-115 follow-up). `patient` is M5's table and M2 may not read it, so M5 publishes
// the read and the composition root injects it into M2 as a locally-declared port (the `patientIsDeceasedForOrg`
// shape, beside which it lives).
//
// MINIMUM NECESSARY. A funeral home needs to be sure it is handling the right person: the decedent's legal name and
// the date of death. Nothing else crosses - no MRN, no date of birth, no sex, no address, no race/ethnicity, no
// clinical fact, no family contact. FAILS CLOSED: an unknown, cross-tenant, merged-away or not-(yet-)deceased
// patient is `null`, so a link outliving its eligibility reads nothing.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const P = schema.patients;
const SYSTEM_USER_ID = "";

export interface FuneralCase {
  /** Legal name, as recorded (first, middle initial omitted, last, suffix). */
  readonly decedentName: string;
  /** ISO date (YYYY-MM-DD) of death. */
  readonly dateOfDeath: string;
}

export async function funeralCaseForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<FuneralCase | null> {
  const rows = await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) =>
    (tx as unknown as DbClient)
      .select({
        first: P.legalFirstName,
        last: P.legalLastName,
        suffix: P.legalNameSuffix,
        status: P.status,
        deceasedDate: P.deceasedDate,
      })
      .from(P)
      .where(and(eq(P.id, patientId), eq(P.organizationId, organizationId), isNull(P.mergedIntoId)))
      .limit(1),
  );
  const row = rows[0];
  if (!row || row.status !== "deceased" || !row.deceasedDate) return null;
  const decedentName = [row.first, row.last, row.suffix]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  return { decedentName, dateOfDeath: row.deceasedDate };
}
