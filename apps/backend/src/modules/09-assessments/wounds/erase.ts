// apps/backend/src/modules/09-assessments/wounds/erase.ts — patient destruction for the wound record. Called by the M9
// assessment eraser (erasers/assessment-eraser.ts) inside its tenant transaction, with a privileged connection (the
// application role has no DELETE on either table). Observations go first: they reference the wound, and a correction
// references the observation it supersedes (the one statement removes both ends).
import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";

export interface WoundEraseCounts {
  readonly woundObservations: number;
  readonly wounds: number;
}

export async function eraseWoundSubtree(
  tx: DbClient,
  patientId: string,
): Promise<WoundEraseCounts> {
  const O = schema.woundObservations;
  const W = schema.wounds;
  const woundObservations = (
    await tx.delete(O).where(eq(O.patientId, patientId)).returning({ id: O.id })
  ).length;
  const wounds = (await tx.delete(W).where(eq(W.patientId, patientId)).returning({ id: W.id }))
    .length;
  return { woundObservations, wounds };
}
