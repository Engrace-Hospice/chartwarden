// @wardenx/billing — §4.5 rule `evv_bracket_coherence` (evv, error, regulatory, D9). Every claim line's
// EVV-relevant backing encounters must have a bracket state in {compliant, not_required,
// documented_missing}; an `unresolved_missing` bracket BLOCKS submission (the 21st-Century-Cures EVV
// mandate; ADR-0008 — only `unresolved_missing` is ever a billing gate). Reads the resolved `evvBrackets`
// snapshot keyed by encounter id. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "evv_bracket_coherence";

export const evvBracketCoherence: Rule = {
  key: KEY,
  version: 1,
  category: "evv",
  title: "EVV bracket coherence (D9)",
  description:
    "Every claim line's EVV-relevant backing encounters must resolve to compliant / not_required / " +
    "documented_missing; an unresolved_missing EVV bracket blocks submission (ADR-0008).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "compliance_officer",
  check: (ctx) => {
    // Index bracket state by encounter id for line-backing lookup.
    const stateByEncounter = new Map<string, string>();
    for (const b of ctx.evvBrackets) stateByEncounter.set(b.encounterId, b.bracketState);

    const unresolved = new Set<string>();
    for (const line of ctx.lines) {
      for (const encounterId of line.backingEncounterIds) {
        if (stateByEncounter.get(encounterId) === "unresolved_missing") unresolved.add(encounterId);
      }
    }
    // Also catch any unresolved bracket present in context (defensive: brackets not tied via a line).
    for (const b of ctx.evvBrackets) {
      if (b.bracketState === "unresolved_missing") unresolved.add(b.encounterId);
    }

    if (unresolved.size === 0) {
      return pass(KEY, "error", "No EVV bracket is unresolved-missing; all backing encounters are EVV-coherent.");
    }
    return fail(
      KEY,
      "error",
      `${unresolved.size} backing encounter(s) have an unresolved-missing EVV bracket.`,
      {
        summary: "Resolve the missing EVV visit verification (M18) for the flagged encounter(s) before billing.",
        blameTarget: "encounter",
        fixAction: "resolve_in_m18",
      },
      { unresolvedCount: unresolved.size },
    );
  },
};
