// apps/backend/src/modules/05-patient/seams/patient-name-fragments-page-for-org.ts - the org-explicit, KEYSET-paged enumeration of
// the NAME TEXT of an org's patients and their people (ADR-0058 name exclusion: M36's global search must never index a name).
//
// Same shape as `patientIdsPageForOrg`: it lives in M5's directory because `patient` and its name tables are M5's, and it is injected
// into M36 as a locally-declared PORT at the composition root (M36 imports no M5 code or schema).
//
// WHAT CROSSES: free-text name FRAGMENTS only, no patient id and no link from a fragment to a patient. The consumer tokenises each
// fragment, replaces the tokens by keyed digests and discards the text in the same call; nothing here is logged or stored by M36.
// WHICH NAMES: the patient's legal first / middle / last name, every alias (preferred, maiden, aka: first / middle / last / full),
// every linked caregiver's first and last name, and every emergency contact's name. Merged-away duplicates are INCLUDED (their name is
// still typed into messages). Bounded (a page is at most PATIENT_NAME_PAGE_MAX patients), ordered by patient id so `afterId` is a
// stable cursor, run under `withOrgContext` so RLS is the wall; the explicit `organization_id` predicate is the belt behind it.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, gt, inArray } from "drizzle-orm";

const P = schema.patients;
const ALIAS = schema.patientNameAliases;
const LINK = schema.patientCaregivers;
const CAREGIVER = schema.caregivers;
const EMERGENCY = schema.emergencyContacts;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention - the M4 audit trigger maps "" to NULL). */
const NAME_PAGE_SYSTEM_USER_ID = "";

/** The largest page a caller may ask for; a bigger request is clamped, never honoured. */
export const PATIENT_NAME_PAGE_MAX = 500;

export interface PatientNameFragmentsPage {
  readonly fragments: readonly string[];
  /** The cursor for the next page, or null when the enumeration is complete. */
  readonly nextAfterId: string | null;
}

const present = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

export async function patientNameFragmentsPageForOrg(
  db: DbClient,
  organizationId: string,
  afterId: string | null,
  limit: number,
): Promise<PatientNameFragmentsPage> {
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), PATIENT_NAME_PAGE_MAX);
  return withOrgContext(db, { organizationId, userId: NAME_PAGE_SYSTEM_USER_ID }, async (rawTx) => {
    const tx = rawTx as unknown as DbClient;
    const patients = await tx
      .select({
        id: P.id,
        first: P.legalFirstName,
        middle: P.legalMiddleName,
        last: P.legalLastName,
      })
      .from(P)
      .where(
        and(eq(P.organizationId, organizationId), afterId === null ? undefined : gt(P.id, afterId)),
      )
      .orderBy(asc(P.id))
      .limit(pageSize);
    if (patients.length === 0) return { fragments: [], nextAfterId: null };
    const ids = patients.map((p) => p.id);
    const [aliases, caregivers, contacts] = await Promise.all([
      tx
        .select({
          first: ALIAS.firstName,
          middle: ALIAS.middleName,
          last: ALIAS.lastName,
          full: ALIAS.fullName,
        })
        .from(ALIAS)
        .where(and(eq(ALIAS.organizationId, organizationId), inArray(ALIAS.patientId, ids))),
      tx
        .select({ first: CAREGIVER.firstName, last: CAREGIVER.lastName })
        .from(LINK)
        .innerJoin(
          CAREGIVER,
          and(
            eq(CAREGIVER.organizationId, LINK.organizationId),
            eq(CAREGIVER.id, LINK.caregiverId),
          ),
        )
        .where(and(eq(LINK.organizationId, organizationId), inArray(LINK.patientId, ids))),
      tx
        .select({ name: EMERGENCY.name })
        .from(EMERGENCY)
        .where(
          and(eq(EMERGENCY.organizationId, organizationId), inArray(EMERGENCY.patientId, ids)),
        ),
    ]);
    const fragments = [
      ...patients.flatMap((p) => [p.first, p.middle, p.last]),
      ...aliases.flatMap((a) => [a.first, a.middle, a.last, a.full]),
      ...caregivers.flatMap((c) => [c.first, c.last]),
      ...contacts.map((c) => c.name),
    ].filter(present);
    const lastPatient = patients[patients.length - 1];
    return {
      fragments,
      nextAfterId: patients.length < pageSize || !lastPatient ? null : lastPatient.id,
    };
  });
}
