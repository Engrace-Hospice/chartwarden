// apps/backend/src/modules/08-encounters/selection-tree.ts — the stored HearthNote selection tree and how its sealed prose is
// re-attached (#114). The one place that knows the storage shape: the route service (selections read, finalize, addenda) and the
// visit-note draft's selection port (ADR-0114) both read the tree through here.
//
// What lands in `hearthnote_selection.selections`: the vocabulary codes and their numeric slot params, plus `hasFreeText`, a boolean
// saying a section carries prose, never the prose (that is sealed under the tenant DEK in `free_text_cipher`). The API shape
// (`SelectionSectionInput`) has the prose and not the marker; the two are converted at the storage boundary.
import type { SelectionSectionInput } from "./routes/service";

export interface StoredSelectionSection {
  readonly sectionId: string;
  readonly entries: SelectionSectionInput["entries"];
  readonly hasFreeText?: boolean;
}

/** Project the jsonb column to the stored tree (an unwritten row reads as no sections, not a throw). */
export function storedSections(selections: unknown): StoredSelectionSection[] {
  return ((selections as { sections?: StoredSelectionSection[] } | null)?.sections ??
    []) as StoredSelectionSection[];
}

/**
 * Re-attach the sealed prose to the stored tree. `openEnvelope` opens one `free_text_cipher` value; absent, a reader still gets
 * the structured note and the absent `freeText` is the honest answer for it. `hasFreeText` is a storage marker for the gate and
 * never leaves here (the API shape is `{ sectionId, entries, freeText? }`).
 */
export async function openStoredProse(
  row: { readonly selections: unknown; readonly freeTextCipher: string | null },
  openEnvelope: ((envelope: string) => Promise<string>) | undefined,
): Promise<SelectionSectionInput[]> {
  const stored = storedSections(row.selections);
  const project = ({ sectionId, entries }: StoredSelectionSection): SelectionSectionInput => ({
    sectionId,
    entries,
  });
  if (row.freeTextCipher === null || !openEnvelope) return stored.map(project);
  const prose = JSON.parse(await openEnvelope(row.freeTextCipher)) as Record<string, string>;
  return stored.map((s) => {
    const text = prose[s.sectionId];
    return text === undefined ? project(s) : { ...project(s), freeText: text };
  });
}

/** Whether the clinician has put anything of their own into a section: a selected entry, or prose (the stored marker). */
export function sectionHasOwnText(section: StoredSelectionSection): boolean {
  return (section.entries?.length ?? 0) > 0 || section.hasFreeText === true;
}
