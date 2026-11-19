import { type DbClient, schema } from "@chartwarden/db";
// apps/backend/src/modules/08-encounters/drafting/signed-sections.ts — the sealed per-section rows of a signed note (S1 PR C2b2; design §3.1/§3.2).
//
// One row per section of the note, written in the SAME transaction as the sign and as the note's `final_cipher`, which sign (re)writes from
// the same `FinalNote`, so the ordered rows ARE the narrative by construction (a test pins it). The text is sealed with the narrative's
// envelope; the row's hash is SHA-256 of the text it seals, so anyone holding the unsealed row can check it. Source ids are ids and kinds only.
// Part 2 fails closed: a confirmed section's flag is the compiler's; the clinician's own words are not classified (design §3.1).
import type { DraftSourceRef } from "@chartwarden/hearthnote";
import { and, desc, eq } from "drizzle-orm";
import { EncounterStateError } from "../lifecycle/errors";
import { sha256Hex } from "./compute";
import type { FinalNote } from "./final-note";

const OUT = schema.hearthnoteAssembledOutputs;
const SIGNED = schema.hearthnoteSignedSections;

export interface SealedSectionRow {
  readonly sectionId: string;
  readonly position: number;
  readonly textCipher: string;
  readonly contentHash: string;
  readonly part2Derived: boolean;
  readonly sourceRefs: readonly DraftSourceRef[];
}

/** Seals every section of `note`. Any one seal failing fails the set (no partial rows). */
export function sealedSectionRows(
  note: FinalNote,
  seal: (plaintext: string) => Promise<string>,
): Promise<readonly SealedSectionRow[]> {
  return Promise.all(
    note.sections.map(
      async (section): Promise<SealedSectionRow> => ({
        sectionId: section.sectionId,
        position: section.position,
        textCipher: await seal(section.text),
        contentHash: sha256Hex(section.text),
        part2Derived: section.part2Derived,
        sourceRefs: section.sourceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
      }),
    ),
  );
}

export interface SignedNoteWrite {
  readonly organizationId: string;
  readonly encounterId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
  readonly note: FinalNote;
  /** Seals one text under the tenant DEK with the narrative's envelope. */
  readonly seal: (plaintext: string) => Promise<string>;
}

/**
 * At sign, inside the sign transaction: pins the signed note's text as the encounter's `final_cipher` (and `layer1_cipher`, equal to it
 * while Layer 2 is off) and writes one sealed row per section next to it. The finalize-time pin is what the author's draft said then; this
 * is what the signer's draft says now, and a note is signed against exactly that. Refuses (`ILLEGAL_TRANSITION`) when there is no pinned
 * output to update or Layer 2 took part in it, since this write has no Layer-2 text to carry.
 */
export async function pinAndSealSignedNote(tx: DbClient, write: SignedNoteWrite): Promise<void> {
  const [pinned] = await tx
    .select({ id: OUT.id })
    .from(OUT)
    .where(and(eq(OUT.encounterId, write.encounterId), eq(OUT.kind, "primary_finalize")))
    .orderBy(desc(OUT.createdAt))
    .limit(1);
  if (pinned === undefined) {
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      "the encounter has no pinned narrative to seal its signed sections against",
    );
  }
  const [layer1Cipher, finalCipher, rows] = await Promise.all([
    write.seal(write.note.narrative),
    write.seal(write.note.narrative),
    sealedSectionRows(write.note, write.seal),
  ]);
  const updated = await tx
    .update(OUT)
    .set({ layer1Cipher, finalCipher })
    .where(and(eq(OUT.id, pinned.id), eq(OUT.layer2InvolvedAtFinalize, false)))
    .returning({ id: OUT.id });
  if (updated.length === 0) {
    throw new EncounterStateError(
      "ILLEGAL_TRANSITION",
      "the pinned narrative took part in a Layer-2 enhancement, which the signed draft text does not carry",
    );
  }
  if (rows.length === 0) return;
  await tx.insert(SIGNED).values(
    rows.map((row) => ({
      organizationId: write.organizationId,
      providerEntityId: write.providerEntityId,
      locationId: write.locationId,
      encounterId: write.encounterId,
      assembledOutputId: pinned.id,
      sectionId: row.sectionId,
      position: row.position,
      textCipher: row.textCipher,
      contentHash: row.contentHash,
      part2Derived: row.part2Derived,
      sourceRefs: [...row.sourceRefs],
    })),
  );
}
