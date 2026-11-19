// apps/web/src/shell — where an open visit note is worked on (ADR-0113). A leaf (no React, no client) shared by the shell's closure banner
// and the encounters module's My notes: the shell may not import a feature module (ADR-0030), but a module may import the shell.

/** The slice of a note both callers have: its id, its patient and its lifecycle status. */
export interface OpenNote {
  readonly id: string;
  readonly patientId: string;
  readonly status: string;
}

/**
 * A draft's home is the composer (#91). A finalized note is finished writing and waits for its signature, which is the read screen's
 * ceremony: sending that author back to the composer would offer them nothing to do. The server counts a finalized note as open, so a
 * link to "the oldest open note" has to honour both.
 */
export function noteHref(note: OpenNote): string {
  const base = `/patients/${note.patientId}/encounters/${note.id}`;
  return note.status === "finalized" ? base : `${base}/compose`;
}

export function openNoteLabel(status: string): string {
  return status === "finalized" ? "Review and Sign" : "Continue Documentation";
}
