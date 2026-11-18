// apps/backend/src/modules/08-encounters/closure/open-status.ts — the ONE definition of "an open visit note" (ADR-0113).
//
// A note is still owed by its author while it is a `draft` or `finalized` (a finalized note is closed only once signed); `signed`,
// `cosign_pending`, `cosigned` and `voided` are closed. The partial index `encounter_open_clock_idx` (migration 1514) carries the
// same predicate, and the planner only uses it for a LITERAL list: a widened list or bind parameters stop the index being used, so
// SQL that must hit it spells the list through {@link OPEN_NOTE_STATUS_LIST_SQL} (a raw literal built from the constant below).
// `closure-open-status.test.ts` parses the migration's predicate and fails if it drifts from {@link OPEN_NOTE_STATUSES}.
import { type SQL, sql } from "drizzle-orm";

/** The statuses in which a visit note is still open for its author. */
export const OPEN_NOTE_STATUSES = ["draft", "finalized"] as const;

export type OpenNoteStatus = (typeof OPEN_NOTE_STATUSES)[number];

/** `('draft', 'finalized')`: a raw literal list. The values are the constants above, never input, so the raw fragment is safe. */
export const OPEN_NOTE_STATUS_LIST_SQL: SQL = sql.raw(
  `(${OPEN_NOTE_STATUSES.map((status) => `'${status}'`).join(", ")})`,
);

const OPEN_NOTE_STATUS_SET: ReadonlySet<string> = new Set(OPEN_NOTE_STATUSES);

/** True when a note in `status` is still open for its author. */
export function isOpenNoteStatus(status: string): status is OpenNoteStatus {
  return OPEN_NOTE_STATUS_SET.has(status);
}
