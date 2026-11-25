// apps/web/src/modules/08-encounters/findings — the ADL dependence score under the "Level of help needed" grid (WF09).
//
// How many of the activities assessed on this visit the patient needs hands-on help with, live as the levels change. It reads the form,
// not the stored record, so it always matches the values on screen. Counted by the same `scoreAdlDependence` the note's functional-status
// sentence uses (@chartwarden/types), which also holds the definition of "dependent" and the guideline's 2 to 3 range.
//
// An ADVISORY decline indicator for the clinician. It never says the patient qualifies or is eligible, it is not read by finalize or sign,
// and it says plainly that the clinician and the IDG decide.
import {
  ADL_DEPENDENCE_LOWER_THRESHOLD,
  ADL_DEPENDENCE_UPPER_THRESHOLD,
  type AdlDependenceBand,
  scoreAdlDependence,
} from "@chartwarden/types";
import { InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";
import { ADL_ITEMS, ADL_ITEM_LABEL, type AdlItem } from "./findings-labels";
import type { AdlForm } from "./findings-model";

const GUIDELINE_RANGE = `${ADL_DEPENDENCE_LOWER_THRESHOLD} to ${ADL_DEPENDENCE_UPPER_THRESHOLD} dependent ADLs that clinical guidelines typically look for`;

/** Where the count sits against the guideline range, in words that describe the count and decide nothing. */
const BAND_SENTENCE: Readonly<Record<AdlDependenceBand, string>> = {
  below: `Fewer than the ${GUIDELINE_RANGE}.`,
  lower: `Within the ${GUIDELINE_RANGE}.`,
  upper: `At or above the ${GUIDELINE_RANGE}.`,
};

const DEFINITION =
  "Limited assist, extensive assist and total dependence count as dependent; supervision does not. A guide for your clinical judgement, not an eligibility decision: you and the IDG decide.";

const NONE_ASSESSED =
  "No activity assessed yet. An activity left as Not assessed, or that did not occur, is not counted.";

/** "a", "a and b", "a, b and c". */
function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface AdlDependenceSummaryProps {
  /** The levels as they stand on the form (an activity left as Not assessed is absent). */
  readonly items: AdlForm["items"];
}

export function AdlDependenceSummary({ items }: AdlDependenceSummaryProps): JSX.Element {
  const { dependent, assessed, band } = scoreAdlDependence<AdlItem>(items, ADL_ITEMS);
  const names = dependent.map((item) => ADL_ITEM_LABEL[item].toLowerCase());
  const headline = `Dependent in ${dependent.length} of ${assessed} assessed ${assessed === 1 ? "ADL" : "ADLs"}${
    names.length === 0 ? "" : `: ${listOf(names)}`
  }.`;
  return (
    <fieldset className="wx-form-stack wx-fieldset-reset">
      <legend>ADL dependence</legend>
      {/* Not a live region: arrow-keying through a level's options changes the score at every step, and re-announcing the whole sentence each time buries the select. */}
      <InlineAlert tone="info" live={false}>
        {band === null ? (
          NONE_ASSESSED
        ) : (
          <>
            <strong>{headline}</strong> {BAND_SENTENCE[band]}
          </>
        )}
      </InlineAlert>
      <p className="wx-form-hint">{DEFINITION}</p>
    </fieldset>
  );
}
