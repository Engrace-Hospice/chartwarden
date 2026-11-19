// apps/backend/src/modules/08-encounters/drafting/note-versions.ts — a signed note with amendments, as one reader may see it (S1 PR E2; VN-D30,
// VN-D13, design 3.1 "Amendment" and "Per-viewer view"). Sits beside `pinned-note.ts`, whose per-viewer rule it applies to EVERY version.
//
//   * The CURRENT view is the latest signed text of each section: an amendment replaces the section it amends, in the section's place. It comes
//     as the legacy one-string `text` AND a structured view (`structured`) in which a withheld section carries `text: null`, so a web client never
//     receives the marker as data. (`viewPinnedNote` stays the ORIGINAL-note view the document consumers read.)
//   * The HISTORY lists every version of each amended section, oldest first (the original, then each amendment in the order its addendum was
//     signed), with author, date and, for an amendment, the addendum. The last one is `current`.
//   * Part 2 (VN-D13). A viewer without disclosure sees the withheld marker for any version whose row is `part2_derived`, and its sealed text is
//     never opened. The history of a section whose ORIGINAL was `part2_derived` stays withheld whole for such a viewer, though the current view
//     still shows that section's latest text when its row is not Part 2.
// The verdict is asked once, and only when some version is `part2_derived`; a check that fails is 503 `NOTE_VIEW_UNAVAILABLE`, never a denial.
import { type DbClient, schema } from "@chartwarden/db";
import { joinBlocks } from "@chartwarden/hearthnote";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import {
  PART2_WITHHELD_MARKER,
  type PinnedNoteReaders,
  type PinnedNoteRows,
  loadPinnedNote,
  mayReadPart2,
} from "./pinned-note";

const SIGNED = schema.hearthnoteSignedSections;
const ADDENDUM = schema.encounterAddenda;

/** One signed amendment row as stored, text unopened. Rows exist only for a signed addendum (the guard trigger writes them in its sign). */
export interface AmendmentRow {
  readonly sectionId: string;
  readonly textCipher: string;
  readonly part2Derived: boolean;
  readonly addendumId: string;
  readonly authoredByMembershipId: string;
  readonly signedAt: Date | null;
}

/** Who wrote the note and when it was signed: the author and date of the ORIGINAL version of every section. */
export interface NoteOriginal {
  readonly authoredByMembershipId: string;
  readonly signedAt: Date | null;
}

export interface SectionVersion {
  readonly kind: "original" | "amendment";
  /** The addendum that amended the section; `null` for the original. */
  readonly addendumId: string | null;
  readonly authoredByMembershipId: string;
  readonly signedAt: string | null;
  /** The signed text; `null` when withheld (no marker and no content ever reaches a structured consumer as data). */
  readonly text: string | null;
  readonly withheld: boolean;
  /** The latest version of the section: what the current view shows. */
  readonly current: boolean;
}

export interface NoteHistory {
  /** Only the amended sections, in note order. */
  readonly sections: readonly {
    readonly sectionId: string;
    readonly versions: readonly SectionVersion[];
  }[];
}

/** The signed amendment rows of an encounter: oldest addendum first (the order of their signing, which the parent's row lock serialises), then in note order. */
export async function loadAmendmentRows(
  tx: DbClient,
  encounterId: string,
): Promise<readonly AmendmentRow[]> {
  const rows = await tx
    .select({
      sectionId: SIGNED.sectionId,
      textCipher: SIGNED.textCipher,
      part2Derived: SIGNED.part2Derived,
      addendumId: ADDENDUM.id,
      authoredByMembershipId: ADDENDUM.authoredByMembershipId,
      signedAt: ADDENDUM.signedAt,
    })
    .from(SIGNED)
    .innerJoin(ADDENDUM, eq(ADDENDUM.id, SIGNED.addendumId))
    .where(and(eq(SIGNED.encounterId, encounterId), isNotNull(SIGNED.addendumId)))
    .orderBy(asc(ADDENDUM.signedAt), asc(ADDENDUM.id), asc(SIGNED.position));
  return rows;
}

const hasPart2 = (note: PinnedNoteRows, amendments: readonly AmendmentRow[]): boolean =>
  note.part2Derived ||
  note.sections.some((s) => s.part2Derived) ||
  amendments.some((a) => a.part2Derived);

/** The latest amendment row of each section (the rows arrive oldest first). */
function latestBySection(amendments: readonly AmendmentRow[]): ReadonlyMap<string, AmendmentRow> {
  return new Map(amendments.map((a) => [a.sectionId, a]));
}

/** One section of the note as the structured view carries it: the latest signed text, or `text: null` where the reader may not see it. */
export interface NoteViewSection {
  /** The section id; `null` for a pin with no sealed rows (finalized, not signed, or signed with the draft off): the whole narrative is one block. */
  readonly sectionId: string | null;
  /** The latest signed text. `null` when withheld: no marker and no content ever reaches a structured consumer as data. */
  readonly text: string | null;
  readonly withheld: boolean;
  /** The addendum whose amendment is the latest version of the section; `null` when the section is as the note was signed. */
  readonly amendedByAddendumId: string | null;
  /** When the latest version was signed (the addendum's, or the note's own). */
  readonly signedAt: string | null;
}

export interface StructuredNoteView {
  /** The WHOLE note is withheld (a finalized pin that carries Part 2 text has no sealed rows to cut by section): `sections` is then empty. */
  readonly withheld: boolean;
  readonly sections: readonly NoteViewSection[];
}

export interface NoteView {
  /**
   * The legacy one-string view: the sections joined by a blank line (the pin's `final_cipher` by the invariant the sealed rows keep), a withheld
   * section as `PART2_WITHHELD_MARKER`, a note withheld whole as that marker alone.
   */
  readonly text: string;
  /** True when something of the note was withheld from this reader. */
  readonly withheld: boolean;
  readonly structured: StructuredNoteView;
}

/**
 * The note as `readers` may see it, once: the legacy string and the structured view come from the same pass over the sealed rows (each is
 * opened once). Without amendments the sections are the note's own rows; with them each amended section is its latest amendment. A pin with
 * no sealed rows is one block, opened from `final_cipher`.
 */
export async function viewNote(
  note: PinnedNoteRows,
  amendments: readonly AmendmentRow[],
  original: NoteOriginal,
  readers: PinnedNoteReaders,
): Promise<NoteView> {
  const entitled = !hasPart2(note, amendments) || (await mayReadPart2(readers.entitled));
  const originalSignedAt = original.signedAt?.toISOString() ?? null;
  if (note.sections.length === 0) {
    if (!entitled) {
      return {
        text: PART2_WITHHELD_MARKER,
        withheld: true,
        structured: { withheld: true, sections: [] },
      };
    }
    const text = await readers.open(note.finalCipher);
    return {
      text,
      withheld: false,
      structured: {
        withheld: false,
        sections: [
          {
            sectionId: null,
            text,
            withheld: false,
            amendedByAddendumId: null,
            signedAt: originalSignedAt,
          },
        ],
      },
    };
  }
  const latest = latestBySection(amendments);
  const sections: NoteViewSection[] = [];
  const blocks: { sectionId: string; text: string }[] = [];
  for (const row of note.sections) {
    const version = latest.get(row.sectionId) ?? row;
    const amended = latest.get(row.sectionId);
    const hide = version.part2Derived && !entitled;
    const text = hide ? null : await readers.open(version.textCipher);
    sections.push({
      sectionId: row.sectionId,
      text,
      withheld: hide,
      amendedByAddendumId: amended?.addendumId ?? null,
      signedAt:
        amended === undefined ? originalSignedAt : (amended.signedAt?.toISOString() ?? null),
    });
    blocks.push({ sectionId: row.sectionId, text: text ?? PART2_WITHHELD_MARKER });
  }
  return {
    text: joinBlocks(blocks),
    withheld: sections.some((section) => section.withheld),
    structured: { withheld: false, sections },
  };
}

interface Candidate {
  readonly kind: SectionVersion["kind"];
  readonly addendumId: string | null;
  readonly authoredByMembershipId: string;
  readonly signedAt: Date | null;
  readonly textCipher: string;
  readonly part2Derived: boolean;
}

async function versionOf(
  candidate: Candidate,
  current: boolean,
  hideAll: boolean,
  entitled: boolean,
  readers: PinnedNoteReaders,
): Promise<SectionVersion> {
  const withheld = !entitled && (hideAll || candidate.part2Derived);
  return {
    kind: candidate.kind,
    addendumId: candidate.addendumId,
    authoredByMembershipId: candidate.authoredByMembershipId,
    signedAt: candidate.signedAt?.toISOString() ?? null,
    text: withheld ? null : await readers.open(candidate.textCipher),
    withheld,
    current,
  };
}

export async function viewNoteHistory(
  note: PinnedNoteRows,
  amendments: readonly AmendmentRow[],
  original: NoteOriginal,
  readers: PinnedNoteReaders,
): Promise<NoteHistory | null> {
  if (amendments.length === 0) return null;
  const entitled = !hasPart2(note, amendments) || (await mayReadPart2(readers.entitled));
  const sections: NoteHistory["sections"][number][] = [];
  for (const originalRow of note.sections) {
    const amended = amendments.filter((a) => a.sectionId === originalRow.sectionId);
    if (amended.length === 0) continue;
    const candidates: Candidate[] = [
      { ...original, kind: "original", addendumId: null, ...originalRow },
      ...amended.map((a): Candidate => ({ ...a, kind: "amendment" })),
    ];
    const versions: SectionVersion[] = [];
    for (const [index, candidate] of candidates.entries()) {
      versions.push(
        await versionOf(
          candidate,
          index === candidates.length - 1,
          originalRow.part2Derived,
          entitled,
          readers,
        ),
      );
    }
    sections.push({ sectionId: originalRow.sectionId, versions });
  }
  return { sections };
}

/** The current view of the encounter's pinned note and its history, for one reader; `null` when nothing is pinned. */
export async function readNoteVersions(
  tx: DbClient,
  encounterId: string,
  original: NoteOriginal,
  readers: PinnedNoteReaders,
): Promise<{ readonly current: NoteView; readonly history: NoteHistory | null } | null> {
  const note = await loadPinnedNote(tx, encounterId);
  if (note === null) return null;
  const amendments = await loadAmendmentRows(tx, encounterId);
  return {
    current: await viewNote(note, amendments, original, readers),
    history: await viewNoteHistory(note, amendments, original, readers),
  };
}

/**
 * The amended sections of each signed addendum as text, for a document: each section's sealed block in note order, a Part 2 derived one as the
 * withheld marker unless `readers.entitled` says otherwise (a document consumer is never entitled and asks no one). Only addenda that amended a section
 * appear; an addendum that names none is untouched by this.
 */
export async function amendmentTextsByAddendum(
  rows: readonly AmendmentRow[],
  readers: PinnedNoteReaders,
): Promise<ReadonlyMap<string, string>> {
  if (rows.length === 0) return new Map();
  const entitled = !rows.some((row) => row.part2Derived) || (await mayReadPart2(readers.entitled));
  const blocks = new Map<string, string[]>();
  for (const row of rows) {
    const text =
      row.part2Derived && !entitled ? PART2_WITHHELD_MARKER : await readers.open(row.textCipher);
    blocks.set(row.addendumId, [...(blocks.get(row.addendumId) ?? []), text]);
  }
  return new Map(
    [...blocks].map(([addendumId, texts]) => [
      addendumId,
      joinBlocks(texts.map((text) => ({ sectionId: "", text }))),
    ]),
  );
}

/** The addendum's own text, then its amended sections (when it amended any), one blank line apart. */
export const addendumDocumentText = (own: string, amended: string | undefined): string =>
  amended === undefined ? own : joinBlocks([own, amended].map((text) => ({ sectionId: "", text })));
