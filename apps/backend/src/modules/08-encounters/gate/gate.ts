// apps/backend/src/modules/08-encounters/gate/gate.ts — the §2.6 Layer-3 compliance gate (#121).
//
// "The gate is a pure function over the finalized state. Returns `{ pass: true } | { pass: false,
// remediation: [...] }`" — spec §2.6. This is that function. It follows the lifecycle module's rule
// exactly: NO IO. Every fact a check needs (the stored selection tree, M7's care-plan overdue status)
// is resolved by the service and passed in, so the gate is decidable in a unit test and identical in
// the Drizzle service and the in-memory slice.
//
// What each of the twelve §2.6 checks is today — evaluated here, enforced elsewhere in the same
// transition, or deferred with a named blocker — is the register in ./checks. Read that first; it is
// the honest inventory, and `gate.test.ts` pins it against what this file actually decides.
import { resolveTemplate } from "@wardenx/hearthnote";
import type { CarePlanOverdueStatus, EncounterDiscipline, EncounterType } from "@wardenx/types";
import { EncounterStateError } from "../lifecycle/errors";
import type { GateCheckId } from "./checks";

/**
 * One section as the gate sees it: the id, how many vocabulary entries it carries, and whether the
 * clinician attached prose. Deliberately NOT the section's content — §2.6 check 1 asks whether a
 * section is populated, and presence is answerable without reading (or decrypting) a word of PHI.
 */
export interface GateSectionSelection {
  readonly sectionId: string;
  readonly entryCount: number;
  readonly hasFreeText: boolean;
}

/** The facts the encounter gate decides over (all resolved upstream — see the module header). */
export interface EncounterGateFacts {
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  /** The stored HearthNote selection tree. An empty array is the "nothing was documented" case. */
  readonly sections: readonly GateSectionSelection[];
  /**
   * M7 §7.8 `CarePlanReader.isReviewOverdue`. `null` means the patient has no active care plan, which
   * is NOT a failure: there is no review window to have missed. Only `overdue: true` blocks.
   */
  readonly carePlanOverdue: CarePlanOverdueStatus | null;
}

/** One structured remediation hint — the §2.6 "422 with remediation" payload, one entry per failure. */
export interface GateRemediation {
  /** Which §2.6 check produced this (lines the UI's copy up with the register). */
  readonly check: GateCheckId;
  /** The machine-readable remediation code the UI keys its message off. */
  readonly code: string;
  /** The field/section the UI scrolls to and highlights, when the failure names one. */
  readonly field?: string;
  readonly message: string;
}

export type GateResult =
  | { readonly pass: true }
  | { readonly pass: false; readonly remediation: readonly GateRemediation[] };

/** A section counts as populated when it carries ≥ 1 selection OR the clinician's own prose (§2.6). */
function isPopulated(s: GateSectionSelection): boolean {
  return s.entryCount > 0 || s.hasFreeText;
}

/**
 * Run the §2.6 gate for one encounter. Used as a PREVIEW at finalize (a failure keeps the row in draft
 * with the remediation list) and ENFORCED at sign (§2.6 "always-on, signing-blocking").
 */
export function runEncounterComplianceGate(facts: EncounterGateFacts): GateResult {
  const remediation: GateRemediation[] = [];

  // ── Check 1 — every required template section is populated ────────────────────────────────────────
  const template = resolveTemplate(facts.encounterType, facts.discipline);
  if (template === undefined) {
    // An illegal pair is a §2.7 service guard (INVALID_ENCOUNTER_DISCIPLINE_PAIR) that runs long before
    // this, and the DB CHECK is under that. Reaching here means both were bypassed, so the gate refuses
    // rather than passing a note it has no template to judge.
    remediation.push({
      check: "required_sections",
      code: "NO_TEMPLATE_FOR_PAIR",
      message: `no HearthNote template exists for '${facts.encounterType} × ${facts.discipline}'`,
    });
  } else {
    const populated = new Set(facts.sections.filter(isPopulated).map((s) => s.sectionId));
    for (const section of template.sections) {
      if (!section.required || populated.has(section.id)) continue;
      remediation.push({
        check: "required_sections",
        code: "MISSING_SECTION",
        field: section.id,
        message: `'${section.heading}' is required for a ${facts.encounterType} note and has no selections`,
      });
    }
  }

  // ── Check 6 — the M7 care-plan review window (CoP 418.56) ─────────────────────────────────────────
  const cp = facts.carePlanOverdue;
  if (cp?.overdue) {
    remediation.push({
      check: "care_plan_review",
      code: "CARE_PLAN_REVIEW_OVERDUE",
      field: "carePlan",
      message: cp.initialOverdue
        ? "the patient's care plan has not had its 5-day initial review"
        : "the patient's care plan is past its 15-day review window",
    });
  }

  return remediation.length === 0 ? { pass: true } : { pass: false, remediation };
}

/**
 * Run the gate for one addendum. NARROWER than the encounter gate, and deliberately: §2.6 names an
 * addendum template (`addendum_clinical_finding_v1`) that the registry does not contain, so an
 * addendum's REQUIRED-section set is undefined — and judging it against the parent's set would demand
 * a full visit note from a one-finding correction. What is defined without that template is that an
 * addendum with nothing in it documents nothing, which is the check run here.
 */
export function runAddendumComplianceGate(sections: readonly GateSectionSelection[]): GateResult {
  if (sections.some(isPopulated)) return { pass: true };
  return {
    pass: false,
    remediation: [
      {
        check: "required_sections",
        code: "ADDENDUM_EMPTY",
        message:
          "an addendum must carry at least one selection or free-text annotation before it signs",
      },
    ],
  };
}

/**
 * Raise the §2.6 "422 with structured remediation hints" when the gate failed. The remediation rides
 * the M1 error envelope's own `details` array (`{ field?, code, message }`) — the shape §4.3 already
 * publishes — so the UI's "scroll to the first remediation and highlight the field" flow needs no new
 * response contract.
 *
 * The service calls this and then hands `result.pass` to the state machine, which guards the same
 * condition again. That is not redundancy for its own sake: `transitionEncounter` is a pure function
 * with other callers (`planF2fDualWrite`, the in-memory slice), so its guard is the floor and this is
 * the layer that can say WHY — the same relationship `validateVitals` has with the `vitals_*` DB CHECKs.
 */
export function assertGatePassed(result: GateResult, at: "finalize" | "sign"): void {
  if (result.pass) return;
  throw new EncounterStateError(
    "COMPLIANCE_GATE_FAILED",
    at === "finalize"
      ? "the Layer-3 compliance gate did not pass; the encounter stays in draft"
      : "the Layer-3 compliance gate did not pass; the encounter cannot be signed",
    result.remediation.map((r) => ({
      ...(r.field === undefined ? {} : { field: r.field }),
      code: r.code,
      message: r.message,
    })),
  );
}
