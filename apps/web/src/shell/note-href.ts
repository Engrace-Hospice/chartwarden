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

/**
 * Where a visit's (or a patient's) encounter is opened from a list, a visit or the calendar (Workflow 09, WP1): a draft is still being
 * written, so it opens in the composer; every other status (finalized, signed, cosign pending, cosigned, void) is read, signed or
 * corrected on the encounter record. Unlike `noteHref` this never sends a finished note to the composer: `noteHref` answers "where does
 * an OPEN note get worked on", this answers "where does THIS encounter open".
 *
 * The composer's route needs `encounter.author`, so a session without it (a scheduler or DON who may read) is sent to the record, as it
 * was before WP1. That is a choice of link target, not authorization: the server stays the gate.
 */
export function encounterEntryHref(
  encounter: OpenNote,
  options: { readonly canAuthor: boolean },
): string {
  const base = `/patients/${encounter.patientId}/encounters/${encounter.id}`;
  return encounter.status === "draft" && options.canAuthor ? `${base}/compose` : base;
}

/** Whether a session's permissions include the composer's permission; one source for every link that chooses between composer and record. */
export function canAuthorEncounters(permissions: readonly string[] | undefined): boolean {
  return permissions?.includes("encounter.author") === true;
}

export function openNoteLabel(status: string): string {
  return status === "finalized" ? "Review and Sign" : "Continue Documentation";
}
