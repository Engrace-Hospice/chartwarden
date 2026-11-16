// apps/backend/src/modules/15-discipline-care-plans/routes/snapshot-redaction.ts — §7.8 (42 CFR Part 2)
// applied to the version ledger. A version's `stateSnapshot` is the plan's goals and interventions frozen at
// finalize, SUD goals (`sudRelated: true`) included, so every route that returns it (version detail, the
// finalize and sign results) must redact it for a caller without disclosure — the same verdict `getPlan`
// already applies to the live rows. FAIL CLOSED: a snapshot whose shape is not recognised is withheld
// (null), and a goal whose `sudRelated` is anything but the literal `false` is dropped. An intervention that
// serves a dropped goal is dropped with it (it is Part 2 content by its anchor, as module 07 treats a
// problem's dependents), so neither its text nor the hidden goal's id survives in the snapshot. Pure: never
// mutates its input (the stored snapshot stays sealed).
//
// The module 07 precedent: `07-care-plan/routes/snapshot-redaction.ts`.

/** The only keys a draft working snapshot may hold; anything else without `goals` is not a shape we know. */
const DRAFT_SNAPSHOT_KEYS: ReadonlySet<string> = new Set(["volunteerOutOfScopeAcknowledged"]);

/**
 * Whether an intervention serves a goal the caller may not see. `goalRefs` hold the goal ids it is linked to;
 * ids compare lower-cased because a uuid is case-insensitive and the author's casing is stored as given.
 */
export function isSudAnchored(goalRefs: unknown, hiddenGoalIds: ReadonlySet<string>): boolean {
  return (
    Array.isArray(goalRefs) &&
    goalRefs.some((id) => typeof id === "string" && hiddenGoalIds.has(id.toLowerCase()))
  );
}

/** The sentence a redacted snapshot carries when anything was dropped (a rendered PDF prints it as a field). */
export const PART2_WITHHELD_NOTICE =
  "Some content is withheld from this document under 42 CFR Part 2; the signed record holds the whole plan.";

/** A redacted snapshot says so: the signers signed the whole plan, so a copy missing content must not read as complete. */
function withheldNotice<T extends Record<string, unknown>>(snapshot: T, dropped: boolean): T {
  return dropped ? { ...snapshot, partTwoNotice: PART2_WITHHELD_NOTICE } : snapshot;
}

export function redactDisciplineSnapshot(snapshot: unknown, sudAllowed: boolean): unknown {
  if (snapshot === null || snapshot === undefined) return null;
  if (sudAllowed) return snapshot;
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Readonly<Record<string, unknown>>;
  if (!("goals" in record)) {
    // A draft working snapshot has no goals, so nothing to withhold. Only that exact shape passes.
    return Object.keys(record).every((key) => DRAFT_SNAPSHOT_KEYS.has(key)) ? snapshot : null;
  }
  const { goals } = record;
  if (!Array.isArray(goals)) return null;
  const hiddenGoalIds = new Set<string>();
  const visibleGoals: unknown[] = [];
  for (const goal of goals as readonly unknown[]) {
    const entry = goal as { readonly goalId?: unknown; readonly sudRelated?: unknown } | null;
    if (typeof entry === "object" && entry !== null && entry.sudRelated === false) {
      visibleGoals.push(goal);
    } else if (typeof entry?.goalId === "string") {
      hiddenGoalIds.add(entry.goalId.toLowerCase());
    }
  }
  if (!("interventions" in record)) {
    return withheldNotice({ ...record, goals: visibleGoals }, visibleGoals.length < goals.length);
  }
  const { interventions } = record;
  if (!Array.isArray(interventions)) return null;
  const visibleInterventions = (interventions as readonly unknown[]).filter(
    (intervention) =>
      !isSudAnchored(
        (intervention as { readonly goalRefs?: unknown } | null)?.goalRefs,
        hiddenGoalIds,
      ),
  );
  return withheldNotice(
    { ...record, goals: visibleGoals, interventions: visibleInterventions },
    visibleGoals.length < goals.length || visibleInterventions.length < interventions.length,
  );
}

/** A version projection with its snapshot redacted for the caller. */
export function redactVersionForCaller<T extends { readonly stateSnapshot: unknown }>(
  version: T,
  sudAllowed: boolean,
): T {
  if (sudAllowed) return version;
  return { ...version, stateSnapshot: redactDisciplineSnapshot(version.stateSnapshot, false) };
}
