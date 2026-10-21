// apps/backend/src/modules/12-dosespot/seams/idg-medication-history-for-org.ts — the org-explicit, BATCHED
// external-medication-history state the M14 IDG packet's `medicationHistory` slot needs (M12 spec §5.5
// W-MR-05 "the M14 IDG packet shows this state explicitly"; F-230, #248). The seam-PULL binding of the
// `m14 <- m12.medication_history_pulled` pair: M14 builds the packet by seam reads at build time (its own
// spec §1.1 / "Done means"), so it reads this, it is not invalidated by the event.
//
// Reads ONLY the `medication_history_pull` ledger (M12-owned, written only by a real ingested pull): the
// LATEST pull per patient decides the state. A patient with no ledger row is `not_pulled` — NEVER "no
// external history" (that claim requires a pull that actually returned zero entries). Counts + instants only;
// no drug name, no sig, no pharmacy crosses this seam. RLS scopes by `app.org_id` (`withOrgContext`).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, inArray } from "drizzle-orm";

const PULL = schema.medicationHistoryPulls;

/** An IDG caseload is dozens; a list this long is a caller bug. */
export const IDG_MEDICATION_HISTORY_MAX_PATIENTS = 500;

/** Structural twin of M14's `PacketMedicationHistory` (`@chartwarden/types`). */
export interface IdgMedicationHistoryState {
  readonly state: "not_pulled" | "none_available" | "available";
  readonly recordCount: number;
  readonly lastPulledAt: string | null;
}

/** Every requested patient is present in the result (`not_pulled` when no ledger row exists). ONE query. */
export async function idgMedicationHistoryForOrg(
  db: DbClient,
  organizationId: string,
  patientIds: readonly string[],
): Promise<ReadonlyMap<string, IdgMedicationHistoryState>> {
  const ids = [...new Set(patientIds)];
  const out = new Map<string, IdgMedicationHistoryState>();
  if (ids.length === 0) return out;
  if (ids.length > IDG_MEDICATION_HISTORY_MAX_PATIENTS) {
    throw new Error(
      `idgMedicationHistoryForOrg: ${ids.length} patients exceeds the ${IDG_MEDICATION_HISTORY_MAX_PATIENTS} cap`,
    );
  }
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const rows = await (tx as unknown as DbClient)
      .select({
        patientId: PULL.patientId,
        rowsCreated: PULL.rowsCreated,
        pulledAt: PULL.pulledAt,
      })
      .from(PULL)
      .where(and(eq(PULL.organizationId, organizationId), inArray(PULL.patientId, ids)))
      .orderBy(desc(PULL.pulledAt), desc(PULL.createdAt));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.patientId)) latest.set(r.patientId, r);
    for (const id of ids) {
      const r = latest.get(id);
      out.set(
        id,
        r
          ? {
              state: r.rowsCreated > 0 ? "available" : "none_available",
              recordCount: r.rowsCreated,
              lastPulledAt: r.pulledAt.toISOString(),
            }
          : { state: "not_pulled", recordCount: 0, lastPulledAt: null },
      );
    }
    return out;
  });
}
