// apps/backend/src/modules/05-patient/seams/primary-caregiver-contact-for-org.ts — GAP-087.
//
// The org-explicit read of a patient's PRIMARY caregiver's contact facts, for M30's CAHPS-Hospice sample (the
// survey vendor mails/phones the caregiver of a decedent). `caregiver` / `patient_caregiver` are M5's tables, so
// the read lives in M5's directory (the `patientDisplayLabelsForOrg` shape) and is injected into M30 as a
// locally-declared PORT at the composition root; M30 reads no M5 table and takes no M5 edge.
//
// This is a PHI read (name, phone, email): the caller (the CAHPS sampler) seals the result under the tenant DEK
// before it touches a row, and nothing here is logged. The primary caregiver is resolved as the patient's
// `is_primary` link with the latest `involvement_from` — INCLUDING an ended involvement, because the CAHPS
// respondent is the caregiver the patient had at death, not one who is still involved afterwards.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq } from "drizzle-orm";

const PC = schema.patientCaregivers;
const CG = schema.caregivers;

/** A read with no acting human (the M4 audit trigger maps "" to NULL). */
const SEAM_READER_SYSTEM_USER_ID = "";

export interface PrimaryCaregiverContact {
  /** "First Last" as filed on the caregiver record. */
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  /** The caregiver's `preferred_language_code` as stored (ISO-639), or null when none is filed. */
  readonly preferredLanguageCode: string | null;
}

const blankToNull = (value: string | null): string | null => {
  const t = value?.trim();
  return t ? t : null;
};

/** The patient's primary caregiver contact, or null when none is on file (or the patient is not in the org). */
export function primaryCaregiverContactForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<PrimaryCaregiverContact | null> {
  return withOrgContext(db, { organizationId, userId: SEAM_READER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await (tx as DbClient)
      .select({
        firstName: CG.firstName,
        lastName: CG.lastName,
        phone: CG.phone,
        email: CG.email,
        language: CG.preferredLanguageCode,
      })
      .from(PC)
      .innerJoin(CG, eq(CG.id, PC.caregiverId))
      .where(
        and(
          eq(PC.organizationId, organizationId),
          eq(PC.patientId, patientId),
          eq(PC.isPrimary, true),
        ),
      )
      .orderBy(desc(PC.involvementFrom))
      .limit(1);
    if (!row) return null;
    return {
      name: `${row.firstName} ${row.lastName}`.trim(),
      phone: blankToNull(row.phone),
      email: blankToNull(row.email),
      preferredLanguageCode: blankToNull(row.language),
    };
  });
}
