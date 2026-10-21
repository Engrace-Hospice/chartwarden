// apps/backend/src/modules/12-dosespot/jobs/patient-sync-store.ts — the §2.6 `dosespot_patient_sync` mapping
// (F-230, #248): WardenX patient -> DoseSpot-side patient id, written ONLY from a real `upsertPatient`
// response and read by the MedHx-fetch worker to key the pull. Before migration 0303 no such table existed
// (`vendor-boundary.ts`'s `M12DosespotPatientIdUnbound`); a patient that has never had a successful upsert
// resolves to `null` — never a guessed or derived id.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { DosespotPatientIdResolver } from "./vendor-boundary";

const SYNC = schema.dosespotPatientSync;

/** §2.6 "on success": upsert the mapping row with the vendor-returned id (an org-scoped tx). */
export async function recordPatientSyncSuccess(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly dosespotPatientId: string;
    readonly syncedAt: Date;
  },
): Promise<void> {
  await tx
    .insert(SYNC)
    .values({
      organizationId: input.organizationId,
      patientId: input.patientId,
      lastDosespotPatientId: input.dosespotPatientId,
      lastSyncAt: input.syncedAt,
      lastSyncOutcome: "success",
      retryCount: 0,
      lastErrorClass: null,
    })
    .onConflictDoUpdate({
      target: [SYNC.organizationId, SYNC.patientId],
      set: {
        lastDosespotPatientId: input.dosespotPatientId,
        lastSyncAt: input.syncedAt,
        lastSyncOutcome: "success",
        retryCount: 0,
        lastErrorClass: null,
        updatedAt: input.syncedAt,
      },
    });
}

/** §2.6 "on failure": record the outcome + bump `retry_count`, WITHOUT clobbering a previously recorded
 *  vendor id (an earlier successful upsert still identifies the patient at DoseSpot). */
export async function recordPatientSyncFailure(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly patientId: string;
    readonly errorClass: string;
    readonly at: Date;
  },
): Promise<void> {
  await tx
    .insert(SYNC)
    .values({
      organizationId: input.organizationId,
      patientId: input.patientId,
      lastSyncOutcome: "failed",
      retryCount: 1,
      lastErrorClass: input.errorClass,
    })
    .onConflictDoUpdate({
      target: [SYNC.organizationId, SYNC.patientId],
      set: {
        lastSyncOutcome: "failed",
        retryCount: sql`${SYNC.retryCount} + 1`,
        lastErrorClass: input.errorClass,
        updatedAt: input.at,
      },
    });
}

/** The REAL resolver — reads the recorded mapping under `withOrgContext` (RLS-scoped). `null` ⇒ this patient
 *  has never had a successful upsert (honest "not synced yet", not an error). */
export function createDrizzleDosespotPatientIdResolver(db: DbClient): DosespotPatientIdResolver {
  return {
    resolve(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await (tx as DbClient)
          .select({ id: SYNC.lastDosespotPatientId })
          .from(SYNC)
          .where(and(eq(SYNC.organizationId, organizationId), eq(SYNC.patientId, patientId)))
          .limit(1);
        return row?.id ?? null;
      });
    },
  };
}
