// apps/backend/src/modules/15-discipline-care-plans/routes/snapshot-redaction.ts — §7.8 (42 CFR Part 2)
// applied to the version ledger. A version's `stateSnapshot` is the plan's goals frozen at finalize, SUD
// goals (`sudRelated: true`) included, so every route that returns it (version detail, the finalize and
// sign results) must redact it for a caller without disclosure — the same verdict `getPlan` already
// applies to the live goals in SQL. FAIL CLOSED: a snapshot whose shape is not recognised is withheld
// (null), and a goal whose `sudRelated` is anything but the literal `false` is dropped. Pure: never
// mutates its input (the stored snapshot stays sealed).
//
// The module 07 precedent: `07-care-plan/routes/snapshot-redaction.ts`.

export function redactDisciplineSnapshot(snapshot: unknown, sudAllowed: boolean): unknown {
  if (snapshot === null || snapshot === undefined) return null;
  if (sudAllowed) return snapshot;
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Readonly<Record<string, unknown>>;
  // A draft working snapshot holds only `volunteerOutOfScopeAcknowledged` — no goals, nothing to withhold.
  if (!("goals" in record)) return snapshot;
  const { goals } = record;
  if (!Array.isArray(goals)) return null;
  const visibleGoals = (goals as readonly unknown[]).filter(
    (goal) =>
      typeof goal === "object" &&
      goal !== null &&
      (goal as { readonly sudRelated?: unknown }).sudRelated === false,
  );
  return { ...record, goals: visibleGoals };
}

/** A version projection with its snapshot redacted for the caller. */
export function redactVersionForCaller<T extends { readonly stateSnapshot: unknown }>(
  version: T,
  sudAllowed: boolean,
): T {
  if (sudAllowed) return version;
  return { ...version, stateSnapshot: redactDisciplineSnapshot(version.stateSnapshot, false) };
}
