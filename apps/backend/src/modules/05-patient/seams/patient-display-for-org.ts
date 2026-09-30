// apps/backend/src/modules/05-patient/seams/patient-display-for-org.ts — the org-explicit, BATCHED
// minimum-necessary patient display read M14's IDG meeting screens need (agenda / packet list / decision
// ledger / action-item worklist carry only `patient_id`, so the screens rendered id prefixes).
//
// Same shape as `dosespotSyncDemographicsForOrg` / `hl7OrmDemographicsForOrg`: it lives in M5's own
// directory because `patient` is M5's table (the cross-module schema-read gate exempts only the narrow
// eraser-precondition read), and it is injected into M14 as a locally-declared PORT at the composition root —
// M14 never imports M5 code or schema.
//
// MINIMUM NECESSARY (HIPAA 164.502(b)): the M5 D3 / M14 §2.4 display rule — "First L." (legal first name +
// last INITIAL) plus the MRN's last four characters. The full legal last name, DOB, sex and the full MRN never
// cross this seam. There is deliberately NO SUD/42 CFR Part 2 branch here: Part 2 redaction in M14 governs
// packet CONTENT (encounter narratives, significant-change events — W-SUD-01), not the patient's presence on
// an agenda, and the packet cover already carries "First L." for every caller today.
//
// ONE query for the whole id set (`inArray`), never N+1. RLS (`app.org_id`) is the wall; the explicit
// `organization_id` predicate is the belt behind it, so a cross-tenant / unknown / deleted id is simply
// ABSENT from the result — indistinguishable from "no such patient", which is the point.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray } from "drizzle-orm";

const P = schema.patients;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention — the M4 audit trigger maps "" to NULL). */
const PATIENT_DISPLAY_SYSTEM_USER_ID = "";

/** A patient id list this long is a caller bug (an IDG meeting caseload is dozens, not thousands). */
export const PATIENT_DISPLAY_MAX_IDS = 500;

/** The minimum-necessary display projection for one patient. */
export interface PatientDisplayLabel {
  readonly patientId: string;
  /** "First L." — legal first name + last initial (M5 D3 display rule). */
  readonly displayName: string;
  /** The last four characters of the MRN (the whole MRN when it is shorter), or null when the MRN is blank. */
  readonly mrnSuffix: string | null;
}

const compact = (s: string): string => s.trim();

/** Pure projection (unit-testable without a DB). */
export function toPatientDisplayLabel(row: {
  readonly id: string;
  readonly legalFirstName: string;
  readonly legalLastName: string;
  readonly mrn: string;
}): PatientDisplayLabel {
  const first = compact(row.legalFirstName);
  const initial = compact(row.legalLastName).charAt(0).toUpperCase();
  const displayName = [first, initial.length > 0 ? `${initial}.` : ""]
    .filter((p) => p.length > 0)
    .join(" ");
  const mrn = compact(row.mrn);
  return {
    patientId: row.id,
    displayName: displayName.length > 0 ? displayName : "Unnamed patient",
    mrnSuffix: mrn.length > 0 ? mrn.slice(-4) : null,
  };
}

/**
 * Resolve the display labels for a set of patient ids in ONE query. Ids unknown in `organizationId`
 * (or belonging to another tenant) are omitted from the result map. Empty input performs no query.
 */
export async function patientDisplayLabelsForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
): Promise<ReadonlyMap<string, PatientDisplayLabel>> {
  const ids = [...new Set(patientIds)];
  if (ids.length === 0) return new Map();
  if (ids.length > PATIENT_DISPLAY_MAX_IDS) {
    throw new Error(
      `patientDisplayLabelsForOrg: ${ids.length} ids exceeds the ${PATIENT_DISPLAY_MAX_IDS} cap`,
    );
  }
  const rows = await withOrgContext(
    db,
    { organizationId, userId: PATIENT_DISPLAY_SYSTEM_USER_ID },
    async (tx) =>
      (tx as unknown as DbClient)
        .select({
          id: P.id,
          legalFirstName: P.legalFirstName,
          legalLastName: P.legalLastName,
          mrn: P.mrn,
        })
        .from(P)
        .where(and(eq(P.organizationId, organizationId), inArray(P.id, ids))),
  );
  return new Map(rows.map((r) => [r.id, toPatientDisplayLabel(r)] as const));
}
