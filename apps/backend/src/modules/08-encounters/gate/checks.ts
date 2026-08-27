// apps/backend/src/modules/08-encounters/gate/checks.ts — the §2.6 Layer-3 compliance-gate REGISTER.
//
// Spec §2.6 enumerates twelve checks the gate runs before an encounter may sign. This file is the
// register of all twelve and of what each one is TODAY: evaluated here, enforced elsewhere in the same
// transaction, or deferred with a named blocker. It exists because the failure this gate was fixed from
// (#121) was not a wrong check — it was an ABSENT one that looked present: `transitionEncounter`
// enforces `gatePreviewPassed`/`gatePassed` correctly, and every caller handed it the literal `true`, so
// the twelve checks were nowhere and nothing said so.
//
// The rule this file follows is the repo's `deviceAttestationValid` rule: a check whose inputs do not
// exist yet is a REGISTERED absence carrying its reason, never an unregistered one — both let the sign
// through, only the first is distinguishable from a mistake. `gate.test.ts` pins the register against
// what {@link runEncounterComplianceGate} actually evaluates in both directions, so a check cannot
// quietly stop being evaluated and a deferral cannot outlive its reason without a deliberate edit.

/** The twelve §2.6 checks, in spec order. */
export type GateCheckId =
  | "required_sections" // 1
  | "required_vitals" // 2
  | "required_scales" // 3
  | "required_hope_items" // 4
  | "late_entry_ceiling" // 5
  | "care_plan_review" // 6
  | "layer2_decisions" // 7
  | "step_up_fresh" // 8
  | "attestation_confirmed" // 9
  | "eligible_cosigner" // 10
  | "f2f_attested" // 11
  | "vocab_version_pin"; // 12

export type GateCheckState =
  /** Decided by {@link runEncounterComplianceGate} from the facts the service resolves for it. */
  | { readonly kind: "evaluated" }
  /** Decided, but by a guard the same transition already runs — re-deriving it here would fork the rule. */
  | { readonly kind: "elsewhere"; readonly where: string }
  /** Not decided by anything. `blocker` says why; `needs` says what would un-defer it. */
  | { readonly kind: "deferred"; readonly blocker: string; readonly needs: string };

export interface GateCheck {
  /** The §2.6 numbering, so a reader can line this register up against the spec without counting. */
  readonly ordinal: number;
  /** The spec's own wording, condensed. */
  readonly spec: string;
  readonly state: GateCheckState;
}

export const GATE_CHECKS: Readonly<Record<GateCheckId, GateCheck>> = {
  required_sections: {
    ordinal: 1,
    spec: "all required HearthNote sections per (encounter_type × discipline) have at least one selection",
    state: { kind: "evaluated" },
  },
  required_vitals: {
    ordinal: 2,
    spec: "required vitals captured per encounter type, or marked clinically_not_indicated with a reason",
    state: {
      kind: "deferred",
      blocker:
        "the requirement set does not exist as data anywhere. The template engine declares required SECTIONS and nothing about vitals; the spec names the roster for two encounter types in prose (routine_visit: BP/HR/RR/T/SpO2/pain; telephonic: none) and for none of the others. Writing the missing rosters here would be authoring clinical policy inside a gate, and getting one wrong is a signature refused for a visit that was documented correctly.",
      needs:
        "#125 — a per-encounter-type required-vitals roster declared where the templates are (packages/hearthnote), so the gate reads it rather than deciding it",
    },
  },
  required_scales: {
    ordinal: 3,
    spec: "required clinical scales captured per encounter type — via M9's LatestAssessmentProvider",
    state: {
      kind: "deferred",
      blocker:
        "the seam is real and registered (M9 is 🟢), but WHICH scales an encounter type mandates is declared nowhere — §2.6 says 'if mandated by the type' and no type mandates one in data. The reader exists; the requirement does not.",
      needs: "#125 — a per-encounter-type required-scale roster, alongside the required-vitals one",
    },
  },
  required_hope_items: {
    ordinal: 4,
    spec: "required HOPE items captured for HOPE-timepoint encounters — via M10's seam",
    state: {
      kind: "deferred",
      blocker:
        "M10's HopeTimepointProvider answers which timepoints are due for a PATIENT; nothing maps an encounter to the timepoint it satisfies, so the gate cannot tell whether THIS note is the one that must carry the items.",
      needs: "an encounter→HOPE-timepoint correspondence (M8 carries no timepoint column today)",
    },
  },
  late_entry_ceiling: {
    ordinal: 5,
    spec: "late-entry tier within the ceiling permitted for the caller's role (significant → supervisor, administrative → director)",
    state: {
      kind: "elsewhere",
      where:
        "the §2.5 D4 override routes (15/16) — the tier's override is attested on the row before sign, and `deriveBillability` keys the claim line off the same fact. The gate would be asking the question a second time in a place that cannot see the caller's role.",
    },
  },
  care_plan_review: {
    ordinal: 6,
    spec: "the patient's M7 care plan is not past its CoP 418.56 review gate (5-day initial / 15-day review)",
    state: { kind: "evaluated" },
  },
  layer2_decisions: {
    ordinal: 7,
    spec: "every Layer-2 modification carries a per-passage clinician decision (no 'pending' at sign)",
    state: {
      kind: "deferred",
      blocker:
        "Layer 2 is unbuilt: `hearthnote_llm_modification` is written by nothing and the enhance route returns the encounter's own id (#123). The check is vacuous rather than absent — there is no modification that could lack a decision — but it is registered rather than assumed, because the day Layer 2 writes a row this must stop being vacuous.",
      needs: "#123 — a real Layer-2 write path",
    },
  },
  step_up_fresh: {
    ordinal: 8,
    spec: "the signing clinician's step-up auth is ≤ 5 minutes old (D13)",
    state: {
      kind: "elsewhere",
      where:
        "`transitionEncounter`'s own `require_(event.stepUpFresh, 'STEP_UP_AUTH_REQUIRED')`, resolved from M2's SessionContextResolver. It is checked BEFORE the gate verdict on purpose (see the sign case) so a stale session is a 412, not a documentation complaint.",
    },
  },
  attestation_confirmed: {
    ordinal: 9,
    spec: "the clinician confirmed the attestation language (one of two texts, depending on Layer-2 involvement)",
    state: {
      kind: "deferred",
      blocker:
        "nothing carries the clinician's confirmation. `encounter_signature.attestation_text` records WHICH text was stamped — the service writes it — and no field anywhere records that the human read it. A gate reading the text the server itself just wrote would confirm its own work.",
      needs:
        "an attestation-acknowledged input on the sign route body, distinct from the text the server stamps (M9's CosignatureSchema.attestationConfirmed is the shape, fixed under #117)",
    },
  },
  eligible_cosigner: {
    ordinal: 10,
    spec: "for LPN/CHHA, a cosignature-eligible RN exists on the patient's caseload (M5 CaseloadProvider)",
    state: {
      kind: "elsewhere",
      where:
        "`transitionEncounter`'s own `require_(event.eligibleCosignerExists, 'NO_ELIGIBLE_COSIGNER')`, resolved from M5's `CareTeamProvider.primaryRnMembershipId` — the patient's RN case manager as an active membership, which §2.4 D3 also names as the routed cosigner, so the existence question and the routing question have ONE answer (#124). It used to be a literal `true`, and the request routed to the LPN who signed it.",
    },
  },
  f2f_attested: {
    ordinal: 11,
    spec: "for F2F, M6's face_to_face_encounter row exists (or is written in the same dual-write tx, D1)",
    state: {
      kind: "elsewhere",
      where:
        "`planF2fDualWrite`, which derives `f2fDualWriteSatisfied` from the M6 id being non-null and lets `transitionEncounter` raise F2F_DUAL_WRITE_REQUIRED. That one is genuinely derived, not hard-coded.",
    },
  },
  vocab_version_pin: {
    ordinal: 12,
    spec: "the vocabulary version pin is recorded and still the active corpus version (D11)",
    state: {
      kind: "elsewhere",
      where:
        "BOTH halves are enforced, and neither belongs here (#128). *Recorded*: the DB CHECK " +
        "`encounter_vocab_pinned_when_finalized` makes `vocab_version_id` NOT NULL for every non-draft " +
        "row, so presence is a database invariant rather than something a gate could be talked out of " +
        "— and the gate runs as a PREVIEW at finalize, before the pin for that very transition is " +
        "written, so evaluating presence here would refuse every first finalize. *Still active*: " +
        "`checkVocabVersion` in the finalize path, which compares the corpus recorded on the draft's " +
        "`hearthnote_selection.template_version` against the running build's release and raises §2.7's " +
        "409 VOCAB_VERSION_MISMATCH. That function had existed since M8-T04 and was called by nothing. " +
        "The pin itself is no longer a sentinel: `@wardenx/narrative-vocab`'s release registry resolves " +
        "a real, decodable uuid per corpus version (see `releases.ts` for why the pin is the CORPUS " +
        "release and not an M38 `code_system_version` row — architecture §10.5.2 over spec §2.7).",
    },
  },
} as const;

/** The checks {@link runEncounterComplianceGate} is expected to decide — the register's evaluated half. */
export const EVALUATED_CHECKS: ReadonlyArray<GateCheckId> = (
  Object.keys(GATE_CHECKS) as GateCheckId[]
).filter((id) => GATE_CHECKS[id].state.kind === "evaluated");
