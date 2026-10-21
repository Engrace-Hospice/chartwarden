// apps/backend/src/modules/05-patient/seams/mbi-reader.ts — org-explicit MBI read for BACKGROUND
// consumers (F-131, #248 — the `admissionSchedulingContextForOrg` precedent one module over,
// apps/backend/src/modules/06-admission/seams/drizzle-store.ts).
//
// M26's cap-accrual outbox consumer needs a canonical MBI per patient to populate
// `cap_beneficiary_accrual.mbi_normalized` (NOT NULL) the first time it opens a roll-up row for a
// patient. It cannot reach this fact through the published, request-scoped `PatientReader` seam
// (a relay tick is not a request, and `PatientIdentity` does not carry an `mbi` field regardless —
// `createDrizzlePatientReaderStore`'s `identitiesFor` already batch-reads `patient_identifier` for
// the ssn tail + external MRNs in the SAME round trip and simply never asked for kind='mbi'), and M26
// does not list `5` in its manifest `dependsOn` ([1, 23, 36]) — it cannot import this module's code
// directly either way. The composition root injects this function as a typed port instead, the
// `ProviderCcnPort` shape (M23's `routes/write-service.ts`) one module over.
//
// MBI is stored PLAINTEXT on `patient_identifier` (kind='mbi') — the §2.2 envelope-encryption split
// applies only to ssn/state_id — and `patient_identifier_mbi_format` already CHECKs the canonical CMS
// format (`^[1-9][AC-HJ-NP-RT-Y][0-9AC-HJ-NP-RT-Y]{9}$`, no hyphens) on write, so the stored value IS
// already the canonical join key M26 wants; nothing here re-normalizes it.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const ID = schema.patientIdentifiers;

/** The seam envelope's actor id — a cross-module identity read has no acting membership. */
const MBI_READER_SYSTEM_USER_ID = "";

/**
 * The patient's CURRENT (`effective_to IS NULL`) MBI, org-explicit and worker-callable. `null` when
 * the patient carries no MBI identifier — a real, unremarkable case (not yet captured on intake, or a
 * patient with no Medicare eligibility on file) — never fabricated. `null` also when the id is unknown
 * in `organizationId`, indistinguishable from another tenant's, which is the point.
 */
export function mbiNormalizedForPatient(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<string | null> {
  return withOrgContext(db, { organizationId, userId: MBI_READER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await tx
      .select({ value: ID.value })
      .from(ID)
      .where(
        and(
          eq(ID.organizationId, organizationId),
          eq(ID.patientId, patientId),
          eq(ID.kind, "mbi"),
          isNull(ID.effectiveTo),
        ),
      )
      .limit(1);
    return row?.value ?? null;
  });
}
