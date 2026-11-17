// apps/backend/src/modules/07-care-plan/routes/snapshot-redaction.ts — §7.6 (42 CFR Part 2) applied to
// the version ledger. A version's `stateSnapshot` is the whole plan frozen at finalize, SUD-related
// problems included, so every route that returns it (version list/get, the patient aggregate's
// `versions[]`, the finalize/sign/return-to-draft results) must redact it for a caller without
// disclosure — the same rule the top-level problems/goals/interventions already follow. FAIL CLOSED: a
// snapshot that does not have the expected shape is withheld (null), never passed through.
import { redactCarePlanForCaller } from "../authoring/index";

export function redactStateSnapshot(snapshot: unknown, sudDisclosureAllowed: boolean): unknown {
  if (snapshot === null || snapshot === undefined) return null;
  if (sudDisclosureAllowed) return snapshot;
  const s = snapshot as { problems?: unknown; goals?: unknown; interventions?: unknown };
  if (
    typeof snapshot !== "object" ||
    !Array.isArray(s.problems) ||
    !Array.isArray(s.goals) ||
    !Array.isArray(s.interventions)
  ) {
    return null;
  }
  // Fail closed per problem, as module 15 does: one whose `sudRelated` is not the literal `false` (a missing or
  // mangled flag) is treated as Part 2. A sealed problem always carries the flag, so this only ever withholds.
  const problems = (s.problems as unknown[]).map((problem) => {
    const entry = typeof problem === "object" && problem !== null ? problem : {};
    return (entry as { sudRelated?: unknown }).sudRelated === false
      ? entry
      : { ...entry, sudRelated: true };
  });
  return redactCarePlanForCaller(
    { ...(snapshot as object), problems } as {
      problems: never[];
      goals: never[];
      interventions: never[];
    },
    false,
  );
}

/** A version projection with its snapshot redacted for the caller. */
export function redactVersionForViewer<T extends { stateSnapshot?: unknown }>(
  version: T,
  sudDisclosureAllowed: boolean,
): T {
  if (sudDisclosureAllowed || version === null || typeof version !== "object") return version;
  return { ...version, stateSnapshot: redactStateSnapshot(version.stateSnapshot, false) };
}
