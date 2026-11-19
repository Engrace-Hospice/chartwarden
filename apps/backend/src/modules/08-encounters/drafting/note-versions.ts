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
//   * What a viewer without disclosure is NOT told about a withheld section (S1): its id, who amended it and when. In the current view a withheld
//     section keeps its place in the array but carries `sectionId`, `amendedByAddendumId` and `signedAt` of `null`; the history OMITS every section
//     that has a withheld version (and is `null` when none is left), so neither names a Part 2 section nor dates an amendment of one. That a section
//     is withheld at all, and the marker, are what the viewer is shown. A viewer with disclosure sees every id, author and date.
// The verdict is asked once per read (`renderNoteVersions`), and only when some version is `part2_derived`; a check that fails is 503
// `NOTE_VIEW_UNAVAILABLE`, never a denial.
import { type DbClient, schema } from "@chartwarden/db";
import { joinBlocks } from "@chartwarden/hearthnote";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { type CosignDisplayStatus, cosignDisplayStatus } from "../cosignature/subject";
import {
  PART2_WITHHELD_MARKER,
  type PinnedNoteReaders,
  type PinnedNoteRows,
  loadPinnedNote,
  mayReadPart2,
} from "./pinned-note";

const SIGNED = schema.hearthnoteSignedSections;
const ADDENDUM = schema.encounterAddenda;
const ADDENDUM_REQUEST = schema.addendumCosignatureRequests;

/** One signed amendment row as stored, text unopened. Rows exist only for a signed addendum (the guard trigger writes them in its sign). */
export interface AmendmentRow {
  readonly sectionId: string;
  readonly textCipher: string;
  readonly part2Derived: boolean;
  readonly addendumId: string;
  readonly authoredByMembershipId: string;
  readonly signedAt: Date | null;
  /** Where the addendum's own cosignature stands (ADR-0114 VN-D30): `not_required` unless its note needed a cosigner and it amended a section. */
  readonly cosignStatus: CosignDisplayStatus;
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
  /** An amendment's own cosignature (`not_required | pending | cosigned | released`); `null` for the original version. */
  readonly cosignStatus: CosignDisplayStatus | null;
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
      cosignRequestStatus: ADDENDUM_REQUEST.status,
    })
    .from(SIGNED)
    .innerJoin(ADDENDUM, eq(ADDENDUM.id, SIGNED.addendumId))
    .leftJoin(ADDENDUM_REQUEST, eq(ADDENDUM_REQUEST.addendumId, ADDENDUM.id))
    .where(and(eq(SIGNED.encounterId, encounterId), isNotNull(SIGNED.addendumId)))
    .orderBy(asc(ADDENDUM.signedAt), asc(ADDENDUM.id), asc(SIGNED.position));
  return rows.map(({ cosignRequestStatus, ...row }) => ({
    ...row,
    cosignStatus: cosignDisplayStatus(cosignRequestStatus),
  }));
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
  /**
   * The section id; `null` for a pin with no sealed rows (finalized, not signed, or signed with the draft off: the whole narrative is one block),
   * and for a section withheld from this reader (`withheld`: its id is not told, S1).
   */
  readonly sectionId: string | null;
  /** The latest signed text. `null` when withheld: no marker and no content ever reaches a structured consumer as data. */
  readonly text: string | null;
  readonly withheld: boolean;
  /** The addendum whose amendment is the latest version of the section; `null` when the section is as the note was signed, or is withheld. */
  readonly amendedByAddendumId: string | null;
  /** When the latest version was signed (the addendum's, or the note's own); `null` for a withheld section. */
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
  return renderNote(
    note,
    amendments,
    original,
    readers.open,
    await isEntitled(note, amendments, readers),
  );
}

/** Whether the reader may see every version: true when nothing is Part 2 derived (no one is asked), else M39's verdict, asked once. */
async function isEntitled(
  note: PinnedNoteRows,
  amendments: readonly AmendmentRow[],
  readers: PinnedNoteReaders,
): Promise<boolean> {
  return !hasPart2(note, amendments) || (await mayReadPart2(readers.entitled));
}

async function renderNote(
  note: PinnedNoteRows,
  amendments: readonly AmendmentRow[],
  original: NoteOriginal,
  open: PinnedNoteReaders["open"],
  entitled: boolean,
): Promise<NoteView> {
  const originalSignedAt = original.signedAt?.toISOString() ?? null;
  if (note.sections.length === 0) {
    if (!entitled) {
      return {
        text: PART2_WITHHELD_MARKER,
        withheld: true,
        structured: { withheld: true, sections: [] },
      };
    }
    const text = await open(note.finalCipher);
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
    const text = hide ? null : await open(version.textCipher);
    sections.push(
      hide
        ? // Position only: no id, no amending addendum and no date for a section the viewer may not read (S1).
          { sectionId: null, text: null, withheld: true, amendedByAddendumId: null, signedAt: null }
        : {
            sectionId: row.sectionId,
            text,
            withheld: false,
            amendedByAddendumId: amended?.addendumId ?? null,
            signedAt:
              amended === undefined ? originalSignedAt : (amended.signedAt?.toISOString() ?? null),
          },
    );
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
  readonly cosignStatus: CosignDisplayStatus | null;
}

async function versionOf(
  candidate: Candidate,
  current: boolean,
  open: PinnedNoteReaders["open"],
): Promise<SectionVersion> {
  return {
    kind: candidate.kind,
    addendumId: candidate.addendumId,
    authoredByMembershipId: candidate.authoredByMembershipId,
    signedAt: candidate.signedAt?.toISOString() ?? null,
    text: await open(candidate.textCipher),
    withheld: false,
    current,
    cosignStatus: candidate.cosignStatus,
  };
}

export async function viewNoteHistory(
  note: PinnedNoteRows,
  amendments: readonly AmendmentRow[],
  original: NoteOriginal,
  readers: PinnedNoteReaders,
): Promise<NoteHistory | null> {
  if (amendments.length === 0) return null;
  return renderHistory(
    note,
    amendments,
    original,
    readers.open,
    await isEntitled(note, amendments, readers),
  );
}

/**
 * Every version of each amended section. For a reader without disclosure a section with ANY Part 2 derived version (the original or an
 * amendment) is left out whole: its id, its authors and its dates are what would say that a Part 2 section exists and who amended it (S1). When
 * every amended section is left out there is no history to show, which reads as `null`.
 */
async function renderHistory(
  note: PinnedNoteRows,
  amendments: readonly AmendmentRow[],
  original: NoteOriginal,
  open: PinnedNoteReaders["open"],
  entitled: boolean,
): Promise<NoteHistory | null> {
  const sections: NoteHistory["sections"][number][] = [];
  for (const originalRow of note.sections) {
    const amended = amendments.filter((a) => a.sectionId === originalRow.sectionId);
    if (amended.length === 0) continue;
    const candidates: Candidate[] = [
      { ...original, kind: "original", addendumId: null, cosignStatus: null, ...originalRow },
      ...amended.map((a): Candidate => ({ ...a, kind: "amendment" })),
    ];
    if (!entitled && candidates.some((candidate) => candidate.part2Derived)) continue;
    const versions: SectionVersion[] = [];
    for (const [index, candidate] of candidates.entries()) {
      versions.push(await versionOf(candidate, index === candidates.length - 1, open));
    }
    sections.push({ sectionId: originalRow.sectionId, versions });
  }
  return sections.length === 0 ? null : { sections };
}

/** The pin, its sealed rows and the signed amendment rows of an encounter as stored, ciphers unopened: what a read needs from the database. */
export interface NoteVersionRows {
  readonly note: PinnedNoteRows;
  readonly amendments: readonly AmendmentRow[];
}

/** The database half of a read; `null` when nothing is pinned. Opens no cipher and asks no verdict, so a caller can close its transaction first (S3). */
export async function loadNoteVersionRows(
  tx: DbClient,
  encounterId: string,
): Promise<NoteVersionRows | null> {
  const note = await loadPinnedNote(tx, encounterId);
  if (note === null) return null;
  return { note, amendments: await loadAmendmentRows(tx, encounterId) };
}

/**
 * The ids of the sections with ANY Part 2 derived version (the original or an amendment of it): the ones whose existence a reader without
 * disclosure is not told. Empty for a reader with disclosure and when nothing is Part 2 derived.
 */
function withheldSectionIds(rows: NoteVersionRows, entitled: boolean): ReadonlySet<string> {
  if (entitled) return new Set();
  const { note, amendments } = rows;
  return new Set([
    ...note.sections.filter((s) => s.part2Derived).map((s) => s.sectionId),
    ...amendments.filter((a) => a.part2Derived).map((a) => a.sectionId),
  ]);
}

/** `ids` without the withheld ones: the list of sections an addendum names, for a reader who may not be told a Part 2 section was named (S1). */
export const visibleSectionIds = (
  ids: readonly string[],
  withheld: ReadonlySet<string>,
): readonly string[] => ids.filter((id) => !withheld.has(id));

/**
 * The current view and the history of loaded rows for one reader, with the section ids withheld from them. The Part 2 verdict is asked ONCE for
 * all of it (and only when some version is Part 2 derived), so a read cannot see two different answers or leave two consent-evaluation rows (B4).
 */
export async function renderNoteVersions(
  rows: NoteVersionRows,
  original: NoteOriginal,
  readers: PinnedNoteReaders,
): Promise<{
  readonly current: NoteView;
  readonly history: NoteHistory | null;
  readonly withheldSectionIds: ReadonlySet<string>;
}> {
  const { note, amendments } = rows;
  const entitled = await isEntitled(note, amendments, readers);
  return {
    withheldSectionIds: withheldSectionIds(rows, entitled),
    current: await renderNote(note, amendments, original, readers.open, entitled),
    history:
      amendments.length === 0
        ? null
        : await renderHistory(note, amendments, original, readers.open, entitled),
  };
}

/** The current view of the encounter's pinned note and its history, for one reader; `null` when nothing is pinned. */
export async function readNoteVersions(
  tx: DbClient,
  encounterId: string,
  original: NoteOriginal,
  readers: PinnedNoteReaders,
): Promise<Awaited<ReturnType<typeof renderNoteVersions>> | null> {
  const rows = await loadNoteVersionRows(tx, encounterId);
  return rows === null ? null : renderNoteVersions(rows, original, readers);
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
