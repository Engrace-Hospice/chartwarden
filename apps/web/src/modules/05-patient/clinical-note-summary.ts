// apps/web/src/modules/05-patient — what the Clinical tab's "Recent Clinical Notes" says of one note (ADR-0114 VN-D30, S1 PR E3).
//
// The summary is read from `finalDocumentationView` (the note as structured data for THIS viewer), never from the legacy
// `finalDocumentation` string, which still carries a generic withheld sentence for a viewer without 42 CFR Part 2 disclosure: nothing here
// matches on that sentence. The legacy string is used only when the API sent no structured view at all (an older server).
const SUMMARY_LENGTH = 90;

interface ViewSection {
  readonly text: string | null;
  readonly withheld: boolean;
}

export interface SummarisedNote {
  readonly finalDocumentation: string | null;
  readonly finalDocumentationView?: {
    readonly withheld: boolean;
    readonly sections: readonly ViewSection[];
  } | null;
  /** The note's read was refused 503 NOTE_VIEW_UNAVAILABLE: its Part 2 view could not be decided. */
  readonly viewUnavailable?: boolean;
}

export type NoteSummary =
  | { readonly kind: "text"; readonly text: string; readonly someWithheld: boolean }
  | { readonly kind: "withheld" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "none" };

const NONE: NoteSummary = { kind: "none" };

function flatten(text: string | null): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_LENGTH ? `${flat.slice(0, SUMMARY_LENGTH - 2)}…` : flat;
}

export function summariseNote(note: SummarisedNote): NoteSummary {
  if (note.viewUnavailable) return { kind: "unavailable" };
  const view = note.finalDocumentationView;
  if (view === undefined) {
    const text = flatten(note.finalDocumentation);
    return text ? { kind: "text", text, someWithheld: false } : NONE;
  }
  if (view === null || view.sections.length === 0) {
    return view?.withheld ? { kind: "withheld" } : NONE;
  }
  const readable = view.sections.filter((s) => !s.withheld && s.text !== null);
  const text = flatten(readable.map((s) => s.text).join(" "));
  if (!text) return { kind: "withheld" };
  return { kind: "text", text, someWithheld: readable.length < view.sections.length };
}
