// apps/backend/src/modules/07-care-plan/authoring/redaction.ts — M7-T06 (§7.6).
//
// SUD problem confidentiality. A problem flagged `sud_related=true` is visible only to the assigned RN
// Case Manager and to clinicians whose session carries a satisfied `42_cfr_part_2_release` consent
// context (decided by the `sud_disclosure_allowed` ABAC predicate over Module 39 — abac-predicates.ts).
// For everyone else the SUD problem is OMITTED from the response (§7.6: a server-side filter, not a UI
// hide), and its dependent goals/interventions are dropped with it (a goal/intervention that anchors to
// a hidden problem must not leak the problem's existence).
//
// CRITICAL (§7.6): this is a per-CALLER read filter only. The SIGNING path evaluates quorum and the
// terminal-problem-present invariant over the FULL problem set under a system actor, so redaction never
// changes which signatures are required — the caller-redacted view's `terminal-problem-present` count
// is for that caller's UI only. Pure data in / data out — `sudDisclosureAllowed` is decided upstream.

/** The minimal problem shape the SUD filter keys off (the slice/Drizzle row subset). */
export interface RedactableProblem {
  readonly id: string;
  readonly sudRelated: boolean;
}

/** A goal/intervention anchored to a problem — dropped when its parent problem is redacted. */
export interface ProblemAnchored {
  readonly problemId: string;
}

/**
 * §7.6: the SUD problems a caller may NOT see (so a higher layer can attach an audit `redacted` marker).
 * Empty when disclosure is allowed.
 */
export function redactedSudProblemIds(
  problems: readonly RedactableProblem[],
  sudDisclosureAllowed: boolean,
): readonly string[] {
  if (sudDisclosureAllowed) return [];
  return problems.filter((p) => p.sudRelated).map((p) => p.id);
}

/**
 * §7.6: drop SUD-flagged problems the caller may not see. When `sudDisclosureAllowed` is true the list is
 * returned unchanged. Fail-closed: pass `false` whenever the consent context is unknown.
 */
export function filterVisibleProblems<T extends RedactableProblem>(
  problems: readonly T[],
  sudDisclosureAllowed: boolean,
): T[] {
  if (sudDisclosureAllowed) return [...problems];
  return problems.filter((p) => !p.sudRelated);
}

/**
 * §7.6: drop goals/interventions whose anchoring problem was redacted (the parent's existence must not
 * leak through a child). `hiddenProblemIds` is the set returned by {@link redactedSudProblemIds}.
 */
export function filterAnchoredToVisible<T extends ProblemAnchored>(
  entries: readonly T[],
  hiddenProblemIds: readonly string[],
): T[] {
  if (hiddenProblemIds.length === 0) return [...entries];
  const hidden = new Set(hiddenProblemIds);
  return entries.filter((e) => !hidden.has(e.problemId));
}

/** A care-plan read projection the §7.6 filter rewrites (problems + their dependent children). */
export interface RedactableCarePlanView {
  readonly problems: readonly RedactableProblem[];
  readonly goals: readonly ProblemAnchored[];
  readonly interventions: readonly ProblemAnchored[];
}

/**
 * §7.6 one-shot redaction for a per-caller care-plan read: omit SUD problems the caller may not see and
 * every goal/intervention anchored to them, flagging `redacted` when anything was withheld. The signing
 * path must NOT call this — it operates on the full set under a system actor.
 */
export function redactCarePlanForCaller<V extends RedactableCarePlanView>(
  view: V,
  sudDisclosureAllowed: boolean,
): V & { redacted: boolean } {
  const hidden = redactedSudProblemIds(view.problems, sudDisclosureAllowed);
  if (hidden.length === 0) return { ...view, redacted: false };
  return {
    ...view,
    problems: filterVisibleProblems(view.problems, sudDisclosureAllowed),
    goals: filterAnchoredToVisible(view.goals, hidden),
    interventions: filterAnchoredToVisible(view.interventions, hidden),
    redacted: true,
  };
}
