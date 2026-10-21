// apps/backend/src/modules/05-patient/seams/dosespot-sync-snapshot-for-org.ts — the org-explicit,
// worker-callable read M12's `dosespot_sync_queue` drain needs to build a `PatientSyncSnapshot`
// (M12 `handlers-unbound` group, #248). The `admissionSchedulingContextForOrg` (M6) /
// `electionPeriodContextForOrg` (M6) shape applied to M5: a background job is not an ambient HTTP
// request, so the read opens its own `withOrgContext` rather than `withOrgContextFromRequest`, and it
// lives HERE — in M5's own directory — because `patient_address`/`patient_phone` are NOT in
// `check-table-ownership.ts`'s `CROSS_MODULE_SCHEMA_READ_EXEMPT` set (only the bare `patient` table is,
// for the narrow universal-eraser-precondition read every module's eraser performs). M12's manifest
// `dependsOn` includes 5, but a declared dependency still requires cross-module reads to go through the
// owner's exported seam/repository, never a direct schema import (see that gate's own file header) — this
// is that seam. Injected as a PORT into M12's `PatientSyncSnapshotResolver`
// (`12-dosespot/jobs/vendor-boundary.ts`) at the composition root, the F-160 `CapConsumerStore` /
// `bereavementPlanSitingForOrg` shape.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

/** The 48-hour-unbound-worker system-actor convention (§3.3 / F-102) for a read with no acting human. */
const PATIENT_READER_SYSTEM_USER_ID = "";

/** The demographic fields `@chartwarden/dosespot`'s `PatientSyncSnapshot` needs, before the `patientId`/
 *  `active`/`updatedAt` fields the caller already has from its own trigger event are folded in. */
export interface DosespotSyncDemographics {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly gender: string;
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly phone?: string;
  readonly status: string;
  readonly updatedAt: string;
}

/** `null` when the id is unknown in `organizationId` — indistinguishable from another tenant's or a
 *  deleted patient, which is the point (the caller's honest "no such patient any more" skip). */
export function dosespotSyncDemographicsForOrg(
  db: DbClient,
  organizationId: string,
  patientId: string,
): Promise<DosespotSyncDemographics | null> {
  const P = schema.patients;
  const PA = schema.patientAddresses;
  const PH = schema.patientPhones;
  return withOrgContext(
    db,
    { organizationId, userId: PATIENT_READER_SYSTEM_USER_ID },
    async (tx) => {
      const t = tx as unknown as DbClient;
      const [patient] = await t
        .select()
        .from(P)
        .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)))
        .limit(1);
      if (!patient) return null;

      const [address] = await t
        .select()
        .from(PA)
        .where(
          and(
            eq(PA.organizationId, organizationId),
            eq(PA.patientId, patientId),
            eq(PA.isPrimary, true),
            isNull(PA.effectiveTo),
          ),
        )
        .limit(1);
      const [phone] = await t
        .select()
        .from(PH)
        .where(
          and(
            eq(PH.organizationId, organizationId),
            eq(PH.patientId, patientId),
            eq(PH.isPrimary, true),
          ),
        )
        .limit(1);

      return {
        firstName: patient.legalFirstName,
        lastName: patient.legalLastName,
        dateOfBirth: patient.dob,
        gender: patient.sexAssignedAtBirth,
        addressLine1: address?.line1 ?? "",
        ...(address?.line2 ? { addressLine2: address.line2 } : {}),
        city: address?.city ?? "",
        state: address?.state ?? "",
        postalCode: address?.postalCode ?? "",
        ...(phone?.e164 ? { phone: phone.e164 } : {}),
        status: patient.status,
        updatedAt: patient.updatedAt.toISOString(),
      };
    },
  );
}
