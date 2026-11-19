// apps/backend/src/modules/08-encounters/drafting/confirmations.ts — `encounter_draft_confirmation` reads and the upsert (S1 PR C2b1;
// VN-D7, VN-D12). One row per (encounter, section); a re-confirmation replaces it. The source ids in `source_refs` reach the audit
// trail through the table's row trigger.
import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";
import type { ConfirmationWrite } from "./draft-store";
import type { ConfirmationRecord } from "./section-state";

const C = schema.encounterDraftConfirmations;

export async function readConfirmations(
  tx: DbClient,
  encounterId: string,
): Promise<ConfirmationRecord[]> {
  return tx
    .select({
      sectionId: C.sectionId,
      resolution: C.resolution,
      contentHash: C.contentHash,
      corpusVersion: C.corpusVersion,
    })
    .from(C)
    .where(eq(C.encounterId, encounterId));
}

export async function upsertConfirmation(tx: DbClient, write: ConfirmationWrite): Promise<void> {
  const { encounter } = write;
  const resolved = {
    resolution: write.resolution,
    contentHash: write.contentHash,
    corpusVersion: write.corpusVersion,
    edited: write.edited,
    part2Derived: write.part2Derived,
    sourceRefs: [...write.sourceRefs],
    resolvedByMembershipId: write.resolvedByMembershipId,
    resolvedAt: write.resolvedAt,
  };
  await tx
    .insert(C)
    .values({
      organizationId: encounter.organizationId,
      providerEntityId: encounter.providerEntityId,
      locationId: encounter.locationId,
      encounterId: encounter.id,
      sectionId: write.sectionId,
      ...resolved,
    })
    .onConflictDoUpdate({ target: [C.encounterId, C.sectionId], set: resolved });
}
