// @chartwarden/types — the ADL dependence score: how many of the ADLs assessed on a visit the patient needed hands-on help with.
//
// ONE definition shared by the visit-note Functional Status panel (apps/web, live as the clinician picks levels) and the note's
// functional-status sentence (@chartwarden/hearthnote): the same definition of "dependent" and the same thresholds. They do not read
// the same data: the panel previews the unsaved form (and shows no progression clause), while the note states the saved record.
//
// It is an ADVISORY DECLINE INDICATOR for the clinician, never an eligibility determination: nothing here is read by the finalize or
// sign gate, and the clinician and the IDG decide whether the patient remains appropriate for hospice.
//
// SOURCE OF THE DEFINITIONS. The repo's specs hold no definition of "dependent" (no Katz scoring, and the HOPE section G / Flacker
// "ADL dependency" inputs are not scored in code), so these are the product owner's stated rule:
//   - "dependent" = needs hands-on help: limited assistance, extensive assistance or total dependence on the MDS-style assistance
//     scale the ADL record already uses (`ADL_LEVELS` in @chartwarden/hearthnote). Supervision (oversight or cueing, no physical help)
//     is NOT dependent here; the Katz index would count it, so a clinician who scores Katz will see a lower number than their own.
//   - the clinical guideline looks for dependence in 2 to 3 ADLs, so the range is bounded by the two thresholds below and a count
//     lands in one of three bands: below 2, exactly 2, and 3 or more.
// An ADL that "did not occur", or was not assessed (absent), is counted neither as dependent nor as assessed.

/** The levels that count as dependent: the patient needed hands-on help. */
export const ADL_DEPENDENT_LEVELS = [
  "limited_assist",
  "extensive_assist",
  "total_dependence",
] as const;

/** The levels that were assessed and are not dependent. (`did_not_occur` is in neither list: it is not assessed.) */
export const ADL_NOT_DEPENDENT_LEVELS = ["independent", "supervision"] as const;

/** The fewest dependent ADLs the clinical guideline typically looks for. */
export const ADL_DEPENDENCE_LOWER_THRESHOLD = 2;
/** The most dependent ADLs the guideline's stated range reaches; this many or more is the upper band. */
export const ADL_DEPENDENCE_UPPER_THRESHOLD = 3;

/** `below` the lower threshold, `lower` (it is reached, the upper is not), or `upper` (the upper threshold or more). */
export type AdlDependenceBand = "below" | "lower" | "upper";

export interface AdlDependenceScore<Item extends string> {
  /** The ADLs the patient is dependent in, in the caller's canonical order. */
  readonly dependent: readonly Item[];
  /** How many ADLs were assessed: the denominator. */
  readonly assessed: number;
  /** Where the dependent count falls; `null` when nothing was assessed (there is no score to place). */
  readonly band: AdlDependenceBand | null;
}

const isLevelIn = (levels: readonly string[], value: unknown): boolean =>
  typeof value === "string" && levels.includes(value);

/**
 * Whether a recorded ADL record states an assistance level for at least one ADL ("did not occur" is a stated level; an item left
 * unassessed is absent or null). This is the rule by which a SAVED record populates a note section that states ADLs: a record holding
 * only continence or devices states no level, so the signed note would carry no sentence for it. One definition for the server's gate
 * (`sectionsPopulatedByFindings`) and the composer's rail, so the "documented" mark never disagrees with finalize.
 */
export function statesAdlItemLevel(
  items: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return Object.values(items ?? {}).some((level) => level !== null && level !== undefined);
}

/** Where a count of dependent ADLs falls against the guideline's range. */
export function adlDependenceBand(dependentCount: number): AdlDependenceBand {
  if (dependentCount >= ADL_DEPENDENCE_UPPER_THRESHOLD) return "upper";
  if (dependentCount >= ADL_DEPENDENCE_LOWER_THRESHOLD) return "lower";
  return "below";
}

/**
 * Score the assistance levels recorded on one visit. `order` names the ADLs and fixes the order they are listed in; a key of `items`
 * outside it, and a level outside the scale (stale data), are ignored rather than counted.
 */
export function scoreAdlDependence<Item extends string>(
  items: Readonly<Partial<Record<Item, string | null>>> | undefined,
  order: readonly Item[],
): AdlDependenceScore<Item> {
  const levelOf = (item: Item): string | null | undefined =>
    items !== undefined && Object.hasOwn(items, item) ? items[item] : undefined;
  const assessed = order.filter(
    (item) =>
      isLevelIn(ADL_DEPENDENT_LEVELS, levelOf(item)) ||
      isLevelIn(ADL_NOT_DEPENDENT_LEVELS, levelOf(item)),
  );
  const dependent = assessed.filter((item) => isLevelIn(ADL_DEPENDENT_LEVELS, levelOf(item)));
  return {
    dependent,
    assessed: assessed.length,
    band: assessed.length === 0 ? null : adlDependenceBand(dependent.length),
  };
}
