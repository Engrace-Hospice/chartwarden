// apps/backend/src/modules/08-encounters/encounter-draft-reader.ts — M8's `EncounterDraftReader` seam (WF09): who owns a visit, which patient it
// documents and whether its note is still being written.
//
// M7 change proposals and M9 wound observations carry the `sourceEncounterId` of the visit they were recorded in, a logical uuid neither
// module can check (no M8 import, no table access). Each asks this seam before it binds a record to a visit, so a record cannot be tied to
// another clinician's note, another patient's, or a note already closed (a closed note never releases it again). The answer is ids, enums and
// one boolean: whether the note's template has a section that states wounds, which M8 resolves from the visit's type and discipline with the
// same template registry the note is assembled from (the section flagged `woundSummary`). The read opens its OWN org-scoped `withOrgContext` envelope (empty acting user, the seam-read convention) with an explicit
// `organization_id` predicate behind RLS; an unknown or cross-tenant id is `null`, never a throw.
import { type DbClient, schema } from "@chartwarden/db";
import { resolveTemplate } from "@chartwarden/hearthnote";
import { withOrgContext } from "@chartwarden/tenancy";
import type { EncounterDiscipline, EncounterDraftReader, EncounterType } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";

const E = schema.encounters;

/** Whether the note a visit of this type and discipline is written in has a section that states wounds (telephonic, therapy, social work: no). */
export function noteStatesWounds(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): boolean {
  return (
    resolveTemplate(encounterType, discipline)?.sections.some(
      (section) => section.woundSummary === true,
    ) ?? false
  );
}

/** Same empty-acting-user sentinel the other M8 seam readers use (the audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

export function createDrizzleEncounterDraftReader(db: DbClient): EncounterDraftReader {
  return {
    draftOf({ organizationId, encounterId }) {
      return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
        const [row] = await (tx as unknown as DbClient)
          .select({
            patientId: E.patientId,
            status: E.status,
            authoredByMembershipId: E.authoredByMembershipId,
            encounterType: E.encounterType,
            discipline: E.discipline,
          })
          .from(E)
          .where(and(eq(E.organizationId, organizationId), eq(E.id, encounterId)))
          .limit(1);
        if (!row) return null;
        const { encounterType, discipline, ...facts } = row;
        return {
          ...facts,
          templateStatesWounds: noteStatesWounds(
            encounterType as EncounterType,
            discipline as EncounterDiscipline,
          ),
        };
      });
    },
  };
}

/** The seam registrar's shape: the composition root's `registerSeam`. */
export type EncounterDraftSeamRegistrar = (
  name: "EncounterDraftReader",
  impl: EncounterDraftReader,
) => void;

/** Publish M8's `EncounterDraftReader` so M7 and M9 resolve it with `getSeam("EncounterDraftReader")`. Called from the composition root. */
export function registerEncounterDraftReader(
  register: EncounterDraftSeamRegistrar,
  db: DbClient,
): void {
  register("EncounterDraftReader", createDrizzleEncounterDraftReader(db));
}
