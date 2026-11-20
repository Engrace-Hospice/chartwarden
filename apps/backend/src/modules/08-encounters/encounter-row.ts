// apps/backend/src/modules/08-encounters/encounter-row.ts — loading one encounter row inside a caller's org-scoped transaction.
//
// The one implementation behind the route service's `loadEnc` and the findings service's `loadEncounter`. RLS scopes every row by
// tenant; a caller that also has the organization id passes it, which adds the explicit organization filter as the second lock.
// A missing row and another tenant's read the same: the non-leaking 404.
//
// `lock` takes a row lock on the encounter for the rest of the transaction. It is how a write that must agree with the note's pin
// (a findings PUT, and finalize itself) serialises with the other: both take `no key update`, which conflicts with itself, so a PUT
// either commits before finalize reads the findings (the pinned note states it) or waits, then sees the finalized status and is
// refused. `no key update` rather than `update` so it does not block the foreign-key checks of unrelated inserts (vitals, mileage).
// Lock order everywhere is: the encounter row first, then its satellites.
import { type DbClient, schema } from "@chartwarden/db";
import { NotFoundError } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";

const ENC = schema.encounters;

export type EncounterRow = typeof ENC.$inferSelect;

export type EncounterRowLock = "no key update";

export async function loadEncounterRow(
  tx: DbClient,
  encounterId: string,
  organizationId?: string,
  lock?: EncounterRowLock,
): Promise<EncounterRow> {
  const query = tx
    .select()
    .from(ENC)
    .where(
      organizationId === undefined
        ? eq(ENC.id, encounterId)
        : and(eq(ENC.id, encounterId), eq(ENC.organizationId, organizationId)),
    )
    .limit(1);
  const [row] = lock === undefined ? await query : await query.for(lock);
  if (!row) throw new NotFoundError("encounter");
  return row;
}
