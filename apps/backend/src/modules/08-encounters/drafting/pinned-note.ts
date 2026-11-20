// apps/backend/src/modules/08-encounters/drafting/pinned-note.ts — the pinned note as one reader may see it (S1 PR E1; VN-D13, design 3.1
// "Per-viewer view"). Every reader of `hearthnote_assembled_output.final_cipher` goes through here.
//
//   * A note with no Part 2 derived section, or a viewer with Part 2 disclosure, gets `final_cipher`, byte for byte.
//   * Any other viewer gets the sealed per-section rows with each `part2_derived` section replaced by a withheld marker. The sealed text of
//     a withheld section is never opened.
//   * A pin that carries Part 2 text but has no rows yet (finalized, not signed: the rows are written at sign) cannot be cut by section, so
//     it is withheld whole for a viewer without disclosure.
// The disclosure verdict is asked only when the note has something to withhold. It is the caller's to supply (M39, through the seam the
// draft uses), and a check that fails is 503, never a denial and never a disclosure.
import { type DbClient, schema } from "@chartwarden/db";
import { joinBlocks } from "@chartwarden/hearthnote";
import { and, asc, desc, eq } from "drizzle-orm";
import { EncounterStateError } from "../lifecycle/errors";
import { guarded } from "./unavailable";

const OUT = schema.hearthnoteAssembledOutputs;
const SIGNED = schema.hearthnoteSignedSections;

/** What stands in for withheld content: generic wording, naming nothing of the note. */
export const PART2_WITHHELD_MARKER =
  "[Withheld: this section contains information protected by 42 CFR Part 2 that your access does not include.]";

/** The pin and its sealed per-section rows as stored, ciphers unopened. */
export interface PinnedNoteRows {
  readonly finalCipher: string;
  /** The pin carries a Part 2 derived section (`hearthnote_assembled_output.part2_derived`, migration 1522). */
  readonly part2Derived: boolean;
  /** The sealed rows in note order; empty until the note is signed. */
  readonly sections: readonly {
    readonly sectionId: string;
    readonly textCipher: string;
    readonly part2Derived: boolean;
  }[];
}

export interface PinnedNote {
  readonly text: string;
  /** True when something of the note was withheld from this reader. */
  readonly withheld: boolean;
}

export interface PinnedNoteReaders {
  /** Opens one narrative envelope under the tenant key. */
  readonly open: (cipher: string) => Promise<string>;
  /** Whether this reader may read the patient's Part 2 content. A document consumer answers `false`: documents are broadly readable. */
  readonly entitled: () => Promise<boolean>;
}

/** The latest `primary_finalize` pin of the encounter and its sealed rows, or `null` when nothing is pinned. */
export async function loadPinnedNote(
  tx: DbClient,
  encounterId: string,
): Promise<PinnedNoteRows | null> {
  const [pinned] = await tx
    .select({ id: OUT.id, finalCipher: OUT.finalCipher, part2Derived: OUT.part2Derived })
    .from(OUT)
    .where(and(eq(OUT.encounterId, encounterId), eq(OUT.kind, "primary_finalize")))
    .orderBy(desc(OUT.createdAt))
    .limit(1);
  if (pinned === undefined) return null;
  const sections = await tx
    .select({
      sectionId: SIGNED.sectionId,
      textCipher: SIGNED.textCipher,
      part2Derived: SIGNED.part2Derived,
    })
    .from(SIGNED)
    .where(eq(SIGNED.assembledOutputId, pinned.id))
    .orderBy(asc(SIGNED.position));
  return { finalCipher: pinned.finalCipher, part2Derived: pinned.part2Derived, sections };
}

/** The verdict of `entitled`, or 503 `NOTE_VIEW_UNAVAILABLE` when it cannot be decided (never a silent denial, never a disclosure). */
export async function mayReadPart2(entitled: () => Promise<boolean>): Promise<boolean> {
  try {
    return await guarded("the Part 2 disclosure check", entitled);
  } catch (cause) {
    throw new EncounterStateError(
      "NOTE_VIEW_UNAVAILABLE",
      "the note cannot be shown: the 42 CFR Part 2 disclosure check could not be decided",
      undefined,
      { cause },
    );
  }
}

export async function viewPinnedNote(
  note: PinnedNoteRows,
  readers: PinnedNoteReaders,
): Promise<PinnedNote> {
  const hasPart2 = note.part2Derived || note.sections.some((s) => s.part2Derived);
  if (!hasPart2 || (await mayReadPart2(readers.entitled))) {
    return { text: await readers.open(note.finalCipher), withheld: false };
  }
  if (note.sections.length === 0) return { text: PART2_WITHHELD_MARKER, withheld: true };
  const blocks: { sectionId: string; text: string }[] = [];
  for (const section of note.sections) {
    blocks.push({
      sectionId: section.sectionId,
      text: section.part2Derived ? PART2_WITHHELD_MARKER : await readers.open(section.textCipher),
    });
  }
  return { text: joinBlocks(blocks), withheld: true };
}

/** The pinned note of an encounter as the reader may see it; `null` when nothing is pinned. */
export async function readPinnedNote(
  tx: DbClient,
  encounterId: string,
  readers: PinnedNoteReaders,
): Promise<PinnedNote | null> {
  const note = await loadPinnedNote(tx, encounterId);
  return note === null ? null : viewPinnedNote(note, readers);
}
