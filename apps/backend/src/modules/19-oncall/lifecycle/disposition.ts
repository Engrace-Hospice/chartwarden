// apps/backend/src/modules/19-oncall/lifecycle/disposition.ts — M19-T03 (D6, §6, §7.1–§7.3, §7.5, §7.9).
//
// The disposition is the enumerable commitment that ends the call, and this file decides two things about
// it: MAY this actor select it (§7.3's scope-of-practice matrix) and IS the payload the arm it claims to
// be (D6's discriminated union). §6 is explicit that the role × disposition matrix is enforced "inside the
// disposition handler, not via a separate registered ABAC predicate" — so it lives here, in the pure
// domain, where it is unit-testable without a session.
//
// TWO ENUM MEMBERS ARE NOT SELECTABLE HERE, deliberately. `escalated_unresolved` and `abandoned` are both
// `triage_disposition` members AND `triage_call_state` members, and §2.2.1 reaches each by its own command
// — `escalateUnresolved(tier)` (guarded by `triage.escalate`) and `markAbandoned(reason)` (guarded by
// `triage.close_abandoned`). Letting the plain disposition route write either would hand every actor with
// `triage.disposition` a way around the permission the dedicated command carries. `SELECTABLE_DISPOSITIONS`
// is therefore the eight outcome dispositions, and the two others raise `DISPOSITION_NOT_SELECTABLE`.
//
// THE SIDE EFFECTS ARE PART OF THE DECISION (§2.4). `visit_dispatched_now` and `visit_scheduled_first_light`
// emit `m19.triage_call.visit_needed` into M17's proposal queue; `gip_admission_proposed` emits its own
// topic for M37; every disposition triggers the M8 `EncounterCreator` call (D8) that parks the call in
// `documented_pending_encounter`. Declaring them alongside the validation is what keeps "the call was
// dispositioned but M17 never heard" impossible.
import type {
  TriageDisposition,
  TriageDispositionData,
  TriageEscalationTier,
} from "@wardenx/types";
import type { TriageSideEffect } from "./effects";
import { require_ } from "./errors";
import type { TriageActorDiscipline } from "./protocol";

/** D6 / §2.2.1 — the dispositions `selectDisposition` may write. See the header for why the other two
 *  members of the §3.2 enum are excluded. */
export const SELECTABLE_DISPOSITIONS = [
  "caregiver_education_only",
  "prn_intervention_authorized",
  "verbal_order_recorded",
  "visit_dispatched_now",
  "visit_scheduled_first_light",
  "gip_admission_proposed",
  "ed_transfer_acknowledged",
  "pronouncement_scheduled",
] as const satisfies readonly TriageDisposition[];

/** One of the eight outcome dispositions. */
export type SelectableDisposition = (typeof SELECTABLE_DISPOSITIONS)[number];

/** §6 / §7.3 — the scope bands the matrix is keyed on. Derived from the actor's discipline by
 *  {@link dispositionScopeFor}; kept separate from `TriageActorDiscipline` because four disciplines
 *  collapse onto one band and the matrix should say so once. */
export type TriageDispositionScope = "rn_or_above" | "lpn" | "msw" | "external_vendor";

/**
 * §6 / §7.3 — the role × disposition matrix, and every exclusion's source:
 *
 *   • `rn_or_above` (TN / RN / Clin Supv / DON / Med Dir) — all eight. §6's disposition row.
 *   • `lpn` — §6's LPN note names the permitted pair verbatim ("`caregiver_education_only`,
 *     `prn_intervention_authorized` only") and lists the seven clinician-judgment dispositions as
 *     RN-or-above. §7.3 is the worked scenario: the LPN's selector renders only these two and a forged
 *     POST for a third returns 403 `DISPOSITION_OUT_OF_SCOPE`.
 *   • `msw` — §6's MSW note: "the psychosocial subset (`caregiver_education_only`, `escalated_unresolved`)
 *     plus `triage.escalate` to hand off; clinical / medical dispositions are not available."
 *     `escalated_unresolved` is not a selectable disposition (see header), so the matrix entry is the one
 *     remaining member and the hand-off runs through `escalateUnresolved`.
 *   • `external_vendor` (Ext Triage Op) — §6 calls it a "(PHI-min subset)". Three exclusions, each with its
 *     own citation rather than a blanket judgement:
 *       – `gip_admission_proposed`: D13 / §7.5 / §6 name it explicitly ("gated to in-agency clinicians").
 *       – `verbal_order_recorded`: §6's own "take verbal order during call" row grants Ext Triage Op
 *         nothing, and D9's path requires M2 step-up on a WardenX identity a vendor operator does not hold.
 *       – `pronouncement_scheduled`: §7.9's pronouncement is an agency RN dispatched under the tenant's
 *         death-pronouncement policy; a vendor operator scheduling one commits an agency clinician.
 *     Everything else the vendor may select, which is what makes §7.5's "the operator worked the call and
 *     escalated" flow possible without a second class of call row.
 */
export const DISPOSITION_SCOPE_MATRIX: {
  readonly [K in TriageDispositionScope]: readonly SelectableDisposition[];
} = {
  rn_or_above: SELECTABLE_DISPOSITIONS,
  lpn: ["caregiver_education_only", "prn_intervention_authorized"],
  msw: ["caregiver_education_only"],
  external_vendor: [
    "caregiver_education_only",
    "prn_intervention_authorized",
    "visit_dispatched_now",
    "visit_scheduled_first_light",
    "ed_transfer_acknowledged",
  ],
} as const;

/** §6 — collapse an actor's discipline onto its scope band. `chaplain` maps to `msw`: §6 grants Chap no
 *  disposition at all, and the psychosocial band is the narrowest one that exists — a chaplain who somehow
 *  reaches the handler is refused everything but caregiver education, and the route-level permission check
 *  (T07) refuses them before that. */
export function dispositionScopeFor(discipline: TriageActorDiscipline): TriageDispositionScope {
  switch (discipline) {
    case "clinical_rn":
    case "supervisor":
    case "medical_director":
      return "rn_or_above";
    case "clinical_lpn":
      return "lpn";
    case "msw":
    case "chaplain":
      return "msw";
    case "external":
      return "external_vendor";
  }
}

/** §7.3 / §5 — the disposition options this actor's selector renders. Exported so the T08 screen and the
 *  server refuse the same set: a UI that offers what the handler rejects teaches clinicians to distrust
 *  the panel at 2 a.m. */
export function permittedDispositions(
  discipline: TriageActorDiscipline,
): readonly SelectableDisposition[] {
  return DISPOSITION_SCOPE_MATRIX[dispositionScopeFor(discipline)];
}

/** §7.3 VERBATIM — `DISPOSITION_OUT_OF_SCOPE` (403). */
export function assertDispositionInScope(
  discipline: TriageActorDiscipline,
  disposition: TriageDisposition,
): asserts disposition is SelectableDisposition {
  require_(
    (SELECTABLE_DISPOSITIONS as readonly TriageDisposition[]).includes(disposition),
    "DISPOSITION_NOT_SELECTABLE",
    `'${disposition}' is reached by its own command (escalateUnresolved / markAbandoned), not by selecting a disposition`,
  );
  require_(
    (permittedDispositions(discipline) as readonly TriageDisposition[]).includes(disposition),
    "DISPOSITION_OUT_OF_SCOPE",
    `a ${discipline} actor may not select '${disposition}'`,
  );
}

/**
 * D6 — the payload must be the arm it claims to be.
 *
 * The discriminant is checked first and separately: a payload whose `disposition` field disagrees with the
 * selected disposition would otherwise be validated against the WRONG arm, and a `caregiver_education_only`
 * body could carry a `verbal_order_recorded` order id into `disposition_data` where the M14 packet reader
 * would find it.
 */
export function assertDispositionPayload(
  disposition: TriageDisposition,
  data: TriageDispositionData,
): void {
  require_(
    data.disposition === disposition,
    "DISPOSITION_PAYLOAD_INVALID",
    `payload describes '${data.disposition}' but the selected disposition is '${disposition}'`,
  );

  const nonBlank = (field: string, value: string): void => {
    require_(
      value.trim().length > 0,
      "DISPOSITION_PAYLOAD_INVALID",
      `'${field}' is required for the '${disposition}' disposition`,
    );
  };

  switch (data.disposition) {
    case "caregiver_education_only":
      // The education summary IS the clinical record of an advisory call — without it the row says a call
      // happened and nothing about what the caregiver was told to do.
      nonBlank("educationSummary", data.educationSummary);
      return;
    case "prn_intervention_authorized":
      // D15 — a PRN authorization points at an EXISTING order. Neither id present means the RN authorized
      // a dose with no order behind it, which is the shape M13 cannot administer against.
      require_(
        data.orderRecordId !== null || data.medicationOrderId !== null,
        "DISPOSITION_PAYLOAD_INVALID",
        "a PRN authorization names the existing M11 order or M12 medication order it authorizes",
      );
      nonBlank("instructionsGiven", data.instructionsGiven);
      return;
    case "verbal_order_recorded":
      // D9 — the id M11 returned. It is non-nullable in the union because a verbal-order disposition with
      // no order is a claim that an order was taken and no record that it was.
      nonBlank("orderRecordId", data.orderRecordId);
      return;
    case "visit_dispatched_now":
      nonBlank("requestedDiscipline", data.requestedDiscipline);
      nonBlank("reason", data.reason);
      nonBlank("requestedArrivalBy", data.requestedArrivalBy);
      return;
    case "visit_scheduled_first_light":
      nonBlank("requestedDiscipline", data.requestedDiscipline);
      nonBlank("reason", data.reason);
      nonBlank("proposedForDate", data.proposedForDate);
      return;
    case "gip_admission_proposed":
      nonBlank("gipCriteriaSummary", data.gipCriteriaSummary);
      return;
    case "ed_transfer_acknowledged":
      // CMS 418.52 patient rights — the election text is the record that the family chose the ED against
      // clinical recommendation. It is the single most surveyed field on this disposition.
      nonBlank("electionText", data.electionText);
      return;
    case "pronouncement_scheduled":
      nonBlank("pronouncingDiscipline", data.pronouncingDiscipline);
      return;
    case "escalated_unresolved":
    case "abandoned":
      // Unreachable through `selectDisposition` (the scope assert refuses them first); the arms exist
      // because both are §3.2 enum members that `escalateUnresolved` / `markAbandoned` do write.
      return;
  }
}

/**
 * §2.4 — the outbox + seam effects a disposition carries.
 *
 * Every disposition invokes M8's `EncounterCreator` (D8): §1.1 is unconditional — "on disposition selection
 * + protocol completion, M19 calls M8's published `EncounterCreator` seam" — and the encounter is what the
 * call is waiting on to reach `documented`.
 *
 * `pronouncement_scheduled` ALSO emits `m19.triage_call.visit_needed`. §7.9 is explicit: the pronouncement
 * disposition sends an RN, and M17 creates the dispatch visit from that event. Reading the disposition as
 * merely "scheduled" and emitting nothing would leave the family waiting for a nurse M17 was never asked
 * for. M16's bereavement timeline starts from `m19.triage_call.disposition_selected`, which every
 * disposition emits, so no separate topic is needed for it.
 */
export function dispositionEffects(
  disposition: SelectableDisposition,
): ReadonlyArray<TriageSideEffect> {
  const effects: TriageSideEffect[] = [
    { kind: "outbox", event: "m19.triage_call.disposition_selected" },
  ];

  switch (disposition) {
    case "visit_dispatched_now":
    case "visit_scheduled_first_light":
      effects.push({ kind: "outbox", event: "m19.triage_call.visit_needed" });
      break;
    case "pronouncement_scheduled":
      effects.push({ kind: "outbox", event: "m19.triage_call.visit_needed" });
      break;
    case "gip_admission_proposed":
      effects.push(
        { kind: "outbox", event: "m19.triage_call.gip_admission_proposed" },
        // §1.1 / §2.4 — the level-of-care change is an M11 order draft; M37 consumes the topic above when
        // it locks. Both paths are needed: M37 is a forward seam today, and the order is what actually
        // moves the patient tonight.
        { kind: "outbox", event: "m19.triage_call.care_plan_change_indicated" },
      );
      break;
    case "verbal_order_recorded":
      // D9 — the order itself was taken through M11's seam with M2 step-up BEFORE the disposition is
      // written (the payload carries the id M11 returned); this records the back-reference.
      break;
    case "caregiver_education_only":
    case "prn_intervention_authorized":
    case "ed_transfer_acknowledged":
      break;
  }

  effects.push({ kind: "create_encounter" });
  return effects;
}

/** §7.2 — the tier an unresolved escalation carries when the RN hands the call off rather than
 *  dispositioning it. Exported so the `escalateUnresolved` command and the §5 panel agree on the default. */
export const DEFAULT_UNRESOLVED_ESCALATION_TIER: TriageEscalationTier = "tier_1_rn_supervisor";
