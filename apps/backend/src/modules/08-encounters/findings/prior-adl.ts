// apps/backend/src/modules/08-encounters/findings/prior-adl.ts — WF09: which earlier visit the note's change-in-dependence statement
// compares against (pure; the query that feeds it is `readPriorAdl` in ./findings-drizzle).
//
// The ADL levels of the patient's most recent EARLIER visit that is SIGNED (the same rule as the prior weight, see ./weight-history:
// another clinician's unsigned record is neither final nor theirs to pin into this note's legal text) and that assessed at least one
// ADL. A visit whose record holds only continence, devices, or ADLs that "did not occur" says nothing about dependence, so the
// comparison reaches back past it to the latest visit that did. The score itself (`scoreAdlDependence`) is computed by the note's
// sentence, from these levels, so the screen, the sentence and the history can never disagree.
import { ADL_ITEMS, type PriorRecordedAdl, type RecordedAdl } from "@chartwarden/hearthnote";
import { scoreAdlDependence } from "@chartwarden/types";

/** One earlier visit's ADL record joined to its encounter's service date. */
export interface PriorAdlRow {
  /** The encounter's org-local service date, `YYYY-MM-DD`. */
  readonly serviceDate: string;
  /** When the record was last saved: breaks a tie between two visits on one service date. */
  readonly updatedAt: Date | string;
  readonly items: RecordedAdl["items"];
}

/**
 * The most earlier-visit records read for one answer. A patient whose newest earlier signed visits all assessed no ADL gets no
 * comparison rather than an unbounded read.
 * ponytail: a query for "latest with an assessed item" would lift the cap; not worth it for a patient with this many empty records.
 */
export const PRIOR_ADL_READ_CAP = 20;

const instantOf = (value: Date | string): number => new Date(value).getTime();

/** The latest earlier visit that assessed any ADL, as the note takes it; `null` when none did. Does not mutate `rows`. */
export function pickPriorAdl(rows: readonly PriorAdlRow[]): PriorRecordedAdl | null {
  const newestFirst = [...rows].sort(
    (a, b) =>
      b.serviceDate.localeCompare(a.serviceDate) || instantOf(b.updatedAt) - instantOf(a.updatedAt),
  );
  const found = newestFirst.find((row) => scoreAdlDependence(row.items, ADL_ITEMS).assessed > 0);
  return found === undefined
    ? null
    : { on: found.serviceDate, ...(found.items === undefined ? {} : { items: found.items }) };
}
