// apps/backend/src/modules/16-bereavement/seams/physician-letter-note-for-org.ts — ADR-0109 D6.
//
// The org-explicit PULL read M22's render consumer uses for the approved physician condolence letter: the reviewer's personal note is sealed
// in `bereavement_physician_letter.personal_note_cipher` and is NEVER put on the outbox (an outbox payload cannot be reached by the eraser, and
// the dispatcher would keep a plaintext copy forever). M22 asks for the note at render time, through a port the composition root binds, so
// no `dependsOn` edge is added (ADR-0005 D1; the `bereavementCensusForOrg` / `renderGuard` precedent).
//
// Not a request: it opens its own `withOrgContext` envelope (empty acting user) with an explicit `organization_id` predicate behind RLS, and
// opens the blob AFTER that transaction closes (the key provider takes its own connection, the M21-T05 self-deadlock). Only an approved (or rendered)
// letter yields a note: a declined or still-pending letter, an erased note (cipher shredded to NULL) and an unknown id all answer null. A blob
// that cannot be opened THROWS: the render retries then dead-letters visibly instead of issuing a letter that silently dropped the note.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import type { BereavementCipher } from "../bereavement-crypto";

const LETTER = schema.bereavementPhysicianLetter;
const SEAM_READER_SYSTEM_USER_ID = "";

export async function physicianLetterNoteForOrg(
  db: DbClient,
  cipher: BereavementCipher,
  organizationId: string,
  letterId: string,
): Promise<string | null> {
  const sealed = await withOrgContext(
    db,
    { organizationId, userId: SEAM_READER_SYSTEM_USER_ID },
    async (scoped) => {
      const [row] = await (scoped as DbClient)
        .select({ blob: LETTER.personalNoteCipher })
        .from(LETTER)
        .where(
          and(
            eq(LETTER.id, letterId),
            eq(LETTER.organizationId, organizationId),
            inArray(LETTER.status, ["approved", "rendered"]),
          ),
        )
        .limit(1);
      return row?.blob ?? null;
    },
  );
  if (sealed === null) return null;
  return cipher.decrypt(organizationId, "bereavement_physician_letter.personal_note", sealed);
}
