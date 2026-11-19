// apps/web/src/modules/08-encounters — the signed note as the API sends it, and the rules the screens read off it (ADR-0114 VN-D30).
//
// `finalDocumentationView` is the note as structured data for THIS viewer: one entry per sealed section (or one block for a pin with no
// sealed rows), a withheld section keeping its place and carrying `text: null`, `sectionId: null` and no amendment or date (the reader is
// not told which section is Part 2). `noteHistory` and `addenda[].amendsSectionIds` leave such a section out the same way. It exists so no screen ever has to read the legacy `finalDocumentation` string,
// which still carries a generic withheld sentence for a Part 2 viewer without disclosure: nothing in the web matches on that sentence.
// `noteHistory` lists every version of each amended section. The server decides what each viewer may read; this only words and orders it.
import type { operations } from "@chartwarden/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type EncounterBody = Json<operations["getApiV1EncountersByEncounterId"]["responses"][200]>;

export type FinalDocumentationView = NonNullable<EncounterBody["finalDocumentationView"]>;
export type NoteSection = FinalDocumentationView["sections"][number];
export type NoteHistory = NonNullable<EncounterBody["noteHistory"]>;
export type NoteVersion = NoteHistory["sections"][number]["versions"][number];

/** The words for withheld text: the app's own, said the same everywhere a reader meets it. */
export const WITHHELD_LABEL = "Withheld";
/** The heading of a section withheld from the reader: it names no section, since the API sends no id for one (S1). */
export const WITHHELD_SECTION_HEADING = "Withheld section";
export const WITHHELD_SECTION_TEXT =
  "Protected by 42 CFR Part 2. Your access does not include this section.";
export const WITHHELD_NOTE_TEXT =
  "Protected by 42 CFR Part 2. Your access does not include this note.";
export const WITHHELD_VERSION_TEXT =
  "Protected by 42 CFR Part 2. Your access does not include this version.";

/** Same "YYYY-MM-DD HH:mm" form the Sign-off card uses (UTC wall time from the server string). */
export function shortStamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * The versions of one amended section as the server listed them (oldest first), or null when there is nothing to list: the section was not
 * amended, no history came, or the server left the section out (a group with a withheld version is omitted whole, and the history is null
 * when none is left) or sent it with no version. Never an empty list: a heading over nothing is a hole.
 */
export function historyOfSection(
  history: NoteHistory | null | undefined,
  sectionId: string,
): readonly NoteVersion[] | null {
  const versions = history?.sections.find((s) => s.sectionId === sectionId)?.versions;
  return versions && versions.length > 0 ? versions : null;
}

export const versionCount = (versions: readonly NoteVersion[] | null): number =>
  versions?.length ?? 0;

export interface AmendableSection {
  readonly sectionId: string;
}

/**
 * The sealed sections a clinician may name in an amending addendum; none for a pin with no sealed rows, a withheld note or no view. A section
 * withheld from the viewer has no id to name (S1) and is not listed: nobody amends text they cannot see.
 */
export function amendableSections(
  view: FinalDocumentationView | null | undefined,
): readonly AmendableSection[] {
  return (view?.sections ?? []).flatMap((section): AmendableSection[] =>
    section.sectionId === null || section.withheld ? [] : [{ sectionId: section.sectionId }],
  );
}
