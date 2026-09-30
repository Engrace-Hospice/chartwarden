// @wardenx/billing — §4.5 rule `icd10_sequencing` (icd, error, regulatory). The principal ICD-10 must be
// the terminal diagnosis; related conditions are secondary; unrelated conditions must be explicitly
// flagged; no truncated / non-billable codes; specificity sufficient. ICD billability/specificity is
// resolved by M38 as-of the claim's service-from (in `terminology.icd10Billable`). PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "icd10_sequencing";

export const icd10Sequencing: Rule = {
  key: KEY,
  version: 1,
  category: "icd",
  title: "ICD-10 sequencing and specificity",
  description:
    "The principal ICD-10 must be the terminal diagnosis (position 1, terminal relationship); related " +
    "conditions secondary, unrelated conditions flagged; every code billable/non-truncated with " +
    "sufficient specificity (M38 lookup, as-of service-from).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "medical_director",
  check: (ctx) => {
    // F-214 (#251) — 42 CFR Part 2. M7 withheld diagnosis code(s) because the patient has no valid Part 2
    // release covering disclosure for billing. This is evaluated FIRST and is never skipped: a claim that would
    // otherwise go out silently short of a diagnosis must be HELD (error severity) for a biller to resolve the
    // consent. The message names a COUNT only — never a code or description (they are Part 2 protected).
    const withheld = ctx.claim.diagnosesWithheldForConsent;
    const withheldDefects: string[] = [];
    if (withheld > 0) {
      if (ctx.claim.terminalDiagnosisWithheldForConsent) {
        withheldDefects.push(
          "the principal (terminal) diagnosis is withheld pending 42 CFR Part 2 consent; it is not substituted",
        );
      }
      withheldDefects.push(
        `${withheld} diagnosis code(s) withheld pending 42 CFR Part 2 consent (not on the claim)`,
      );
    }
    const heldFix = {
      summary:
        "A diagnosis was withheld pending 42 CFR Part 2 consent. Obtain/renew the patient's Part 2 release (M39), then reassemble the claim.",
      blameTarget: "claim" as const,
      blameTargetId: ctx.claim.claimId,
      fixAction: "edit_in_m6" as const,
    };
    if (!ctx.seams.terminologyBound) {
      if (withheldDefects.length > 0) {
        return fail(
          KEY,
          "error",
          `ICD-10 sequencing has ${withheldDefects.length} defect(s).`,
          heldFix,
          { defectCount: withheldDefects.length, firstDefect: withheldDefects[0] ?? "" },
        );
      }
      return skip(
        KEY,
        "error",
        "seam_not_bound",
        "Terminology (M38) not bound — ICD validation deferred.",
      );
    }
    const seq = [...ctx.claim.icd10Sequence].sort((a, b) => a.position - b.position);
    if (seq.length === 0 && withheldDefects.length > 0) {
      return fail(
        KEY,
        "error",
        `ICD-10 sequencing has ${withheldDefects.length} defect(s).`,
        heldFix,
        { defectCount: withheldDefects.length, firstDefect: withheldDefects[0] ?? "" },
      );
    }
    if (seq.length === 0) {
      return fail(KEY, "error", "The claim has no ICD-10 diagnosis sequence.", {
        summary: "Add the principal terminal diagnosis and any related conditions (M6/M9).",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "edit_in_m6",
      });
    }
    const defects: string[] = [...withheldDefects];

    // Position 1 must be the terminal diagnosis.
    const principal = seq[0];
    if (
      principal === undefined ||
      principal.position !== 1 ||
      principal.relationship !== "terminal"
    ) {
      // When the terminal was withheld for consent the dedicated message above already says why; do not add a
      // second, misleading "not the terminal" line — and never promote a related diagnosis to principal.
      if (!ctx.claim.terminalDiagnosisWithheldForConsent) {
        defects.push("principal (position 1) is not the terminal diagnosis");
      }
    }
    // No secondary code may itself be terminal (only one terminal, sequenced first).
    for (let i = 1; i < seq.length; i++) {
      const p = seq[i];
      if (p !== undefined && p.relationship === "terminal") {
        defects.push(`position ${p.position} is a second terminal diagnosis`);
      }
    }
    // Every code must be a billable, sufficiently-specific (non-truncated) leaf per M38.
    for (const p of seq) {
      const billable = ctx.terminology.icd10Billable[p.code];
      if (billable !== true) {
        defects.push(`code ${p.code} (pos ${p.position}) is truncated or not billable`);
      }
    }

    if (defects.length === 0) {
      return pass(KEY, "error", "ICD-10 sequence is correctly ordered, specific and billable.");
    }
    return fail(
      KEY,
      "error",
      `ICD-10 sequencing has ${defects.length} defect(s).`,
      {
        summary:
          withheldDefects.length > 0
            ? heldFix.summary
            : "Re-sequence diagnoses (terminal first) and replace any truncated/non-billable code.",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "edit_in_m6",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "" },
    );
  },
};
