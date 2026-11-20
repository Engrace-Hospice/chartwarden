// apps/web/src/modules/08-encounters/review — the web's mirror of the server's compliance-gate register (apps/backend/src/modules/
// 08-encounters/gate/checks.ts). Pure: no I/O, no imports, so a backend test can read it by path (gate-register-web-mirror.test.ts holds
// the two registers together).
//
// The server has no route that returns this register, and no route that previews the gate: `POST /encounters/:id/finalize` is the only
// check, and it finalizes the note when it passes. So this file says WHAT the server checks and WHEN, in plain words. It never says
// that any check passed: only the server's last answer does, and a check that is conditional (vitals, scales, the care-plan review, the
// drafted sections) is silent when its condition does not apply.

export type GateCheckId =
  | "required_sections"
  | "required_vitals"
  | "required_scales"
  | "required_hope_items"
  | "late_entry_ceiling"
  | "care_plan_review"
  | "layer2_decisions"
  | "step_up_fresh"
  | "attestation_confirmed"
  | "eligible_cosigner"
  | "f2f_attested"
  | "vocab_version_pin"
  | "draft_sections_resolved";

/**
 * What decides the check, as the server's register says it:
 * - `finalize_gate`: decided by the gate function, from facts the server resolves (the server's `evaluated`);
 * - `enforced_elsewhere`: decided by a guard in the same transition, not by the gate function (`elsewhere`);
 * - `not_evaluated`: nothing decides it (`deferred`);
 * - `unrecorded`: asked of the clinician, but the server does not record the answer (check 9: `elsewhere` in the server's register, a
 *   client-sent `true` that nothing writes down).
 */
export type CheckKind = "finalize_gate" | "enforced_elsewhere" | "not_evaluated" | "unrecorded";

/**
 * Where the panel lists the check: when the note is finalized (a check listed there may also be re-run, or have a later half, at sign:
 * its description says so), when it is signed, or among what ChartWarden does not check.
 */
export type CheckGroup = "finalize" | "sign" | "not_checked";

export interface RegisterCheck {
  readonly id: GateCheckId;
  /** The server's numbering (spec §2.6, then ADR-0114's check 13). */
  readonly ordinal: number;
  readonly kind: CheckKind;
  readonly group: CheckGroup;
  readonly title: string;
  /** What the server does, and when it does it: written so that a check that may not apply says so. */
  readonly description: string;
}

export const GATE_REGISTER: readonly RegisterCheck[] = [
  {
    id: "required_sections",
    ordinal: 1,
    kind: "finalize_gate",
    group: "finalize",
    title: "Required sections",
    description:
      "Every section the template requires has a selection, your own text, a saved ADL or nutrition record, or confirmed drafted text. Recorded vitals and wounds do not fill a section.",
  },
  {
    id: "required_vitals",
    ordinal: 2,
    kind: "finalize_gate",
    group: "finalize",
    title: "Required vitals",
    description:
      "Only for visit types whose template requires a vitals review: blood pressure, heart rate, respiratory rate, temperature, SpO₂ and pain are each recorded for the visit.",
  },
  {
    id: "required_scales",
    ordinal: 3,
    kind: "finalize_gate",
    group: "finalize",
    title: "Required scales",
    description:
      "Only for recertification visits: a PPS and an ESAS-r are on file for the patient.",
  },
  {
    id: "required_hope_items",
    ordinal: 4,
    kind: "not_evaluated",
    group: "not_checked",
    title: "Required HOPE items",
    description:
      "Not checked. ChartWarden cannot tell which note carries a HOPE timepoint, so it does not check that the items were captured.",
  },
  {
    id: "late_entry_ceiling",
    ordinal: 5,
    kind: "enforced_elsewhere",
    // Listed with the finalize checks because the reason is judged there (before the gate runs, with the date the note is finalized); the
    // override is judged at sign, and the description says so.
    group: "finalize",
    title: "Late entry",
    description:
      "A note documented more than 1 calendar day after the visit date needs a reason of at least 40 characters. The server checks this when you finalize, before the other checks, and again when you sign. At sign, a note more than 3 days late also needs an override recorded beforehand by a supervisor, and more than 14 days late by a director.",
  },
  {
    id: "care_plan_review",
    ordinal: 6,
    kind: "finalize_gate",
    group: "finalize",
    title: "Care-plan review",
    description:
      "Only when the patient has an active care plan: it has had its 5-day initial review and is not past its 15-day review window.",
  },
  {
    id: "layer2_decisions",
    ordinal: 7,
    kind: "not_evaluated",
    group: "not_checked",
    title: "AI review decisions",
    description:
      "Not checked. AI enhancement of the note is not available, so there are no AI passages to decide on.",
  },
  {
    id: "step_up_fresh",
    ordinal: 8,
    kind: "enforced_elsewhere",
    group: "sign",
    title: "Recent sign-in",
    description: "Signing needs a step-up sign-in from the last 5 minutes.",
  },
  {
    id: "attestation_confirmed",
    ordinal: 9,
    kind: "unrecorded",
    group: "not_checked",
    title: "Acknowledgment recording",
    description:
      "Signing asks you to tick an acknowledgment box. The server does not record this acknowledgment.",
  },
  {
    id: "eligible_cosigner",
    ordinal: 10,
    kind: "enforced_elsewhere",
    group: "sign",
    title: "RN cosigner",
    description:
      "For LPN and home health aide notes, the patient has an RN case manager who can cosign the note.",
  },
  {
    id: "f2f_attested",
    ordinal: 11,
    kind: "enforced_elsewhere",
    group: "sign",
    title: "Face-to-face record",
    description:
      "For a face-to-face visit, the encounter must already be linked to its face-to-face record before it can be signed. Signing does not write that record.",
  },
  {
    id: "vocab_version_pin",
    ordinal: 12,
    kind: "enforced_elsewhere",
    group: "finalize",
    title: "Vocabulary version",
    description:
      "After the checks above, the server confirms your selections were saved under the current clinical vocabulary. If it changed, save the selections again.",
  },
  {
    id: "draft_sections_resolved",
    ordinal: 13,
    kind: "finalize_gate",
    group: "finalize",
    title: "Drafted sections",
    description:
      "Only when your organization has the visit-note draft on and this visit's template has a drafted section: every drafted section is confirmed or deselected.",
  },
];

export function checksInGroup(group: CheckGroup): readonly RegisterCheck[] {
  return GATE_REGISTER.filter((check) => check.group === group);
}
