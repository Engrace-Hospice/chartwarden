// @wardenx/medicaid-adapters — §4.6 EVV (D9, tighter than M23) + cap-coherence rules. PURE: read ctx only.
import { fail, pass, skip } from "./types";
import type { MedicaidRule } from "./types";

/**
 * medicaid_evv_bracket_coherence (D9) — TIGHTER than M23: `unresolved_missing` ALWAYS blocks AND
 * `documented_missing` blocks too, UNLESS the resolved adapter declares acceptsDocumentedMissingEvv
 * (every Phase-1 adapter declares false — federal Cures Act §12006). compliant / not_required pass.
 */
export const medicaidEvvBracketCoherence: MedicaidRule = {
  key: "medicaid_evv_bracket_coherence",
  version: 1,
  category: "evv",
  title: "EVV bracket coherence (D9, Medicaid-tight)",
  description:
    "Every backing encounter's EVV bracket is compliant/not_required; unresolved_missing always blocks, " +
    "and documented_missing blocks unless the state adapter accepts it (Phase-1: none do).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "compliance_officer",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_evv_bracket_coherence";
    const acceptsDocMissing = ctx.adapterMetadata.acceptsDocumentedMissingEvv;
    const blocking = ctx.evvBrackets.filter((b) => {
      if (b.bracketState === "unresolved_missing") return true;
      if (b.bracketState === "documented_missing") return !acceptsDocMissing;
      return false;
    });
    if (blocking.length === 0) {
      return pass(KEY, "error", "All backing encounters are EVV-coherent for state Medicaid.");
    }
    return fail(
      KEY,
      "error",
      `${blocking.length} backing encounter(s) have a blocking EVV bracket (Cures Act §12006).`,
      {
        summary: "Resolve the missing EVV verification (M18) for the flagged encounter(s).",
        blameTarget: "encounter",
        fixAction: "resolve_in_m18",
      },
      { blockingCount: blocking.length },
    );
  },
};

/**
 * medicaid_cap_coherence — the per-beneficiary cap projection (payer-agnostic; Medicaid contributes) is
 * within cap. WARN until M26 locks (then tightens to error). SKIPs under the cap-seam deny-stub.
 */
export const medicaidCapCoherence: MedicaidRule = {
  key: "medicaid_cap_coherence",
  version: 1,
  category: "cap",
  title: "Medicaid cap coherence",
  description:
    "The per-beneficiary aggregate cap projection (Medicare + Medicaid paid) is within cap. Warn until " +
    "M26 binds; SKIPs while the cap seam is a deny-stub.",
  severity: "warn",
  regulatoryRequired: true,
  overrideRoleRequired: "compliance_officer",
  applicableStates: [],
  check: (ctx) => {
    const KEY = "medicaid_cap_coherence";
    if (!ctx.seams.capProjectionBound || ctx.capProjection === null) {
      return skip(KEY, "warn", "seam_not_bound", "Cap projection seam unbound; rule deferred.");
    }
    return ctx.capProjection.patientWithinCap
      ? pass(KEY, "warn", "Patient is within the aggregate cap.")
      : fail(KEY, "warn", "Patient projection exceeds the aggregate cap.", {
          summary: "Review the beneficiary's cap projection (M26) before further billing.",
          fixAction: "review_cap_in_m26",
        });
  },
};
