// apps/backend/src/modules/19-oncall/clinical/encounter-link.ts — M19-T05 (D8, §7.1, §2.6, §2.7 D-B).
//
// THE M8 WRITEBACK. D8 is unambiguous about the boundary: "M19 NEVER writes to M8 schema directly" — the
// triage call documents the INTERACTION (caller, protocol answers, disposition, escalations) and the M8
// encounter documents the CLINICAL NARRATIVE, linked one-to-one by `triage_call.linked_encounter_id`. This
// file is the whole of that binding: a pure planner that turns a call + its actor into M8's
// `CreateEncounterInput`, and the IO wrapper that calls the seam and persists the back-reference.
//
// THREE CONTRACT FACTS THE SPEC GETS WRONG, each resolved toward the OWNER's published contract:
//
//   1. §2.6 says "the `EncounterCreator` seam call is idempotent on `triage_call_id` — multiple calls
//      return the same encounter row (M8 §4 contract)". It is not, and cannot be: `CreateEncounterInput`
//      (@wardenx/types) carries no triage-call id, so M8 has nothing to dedupe on and
//      `createDraftEncounter` inserts a fresh draft every time. The §4.8 `m19.encounter-creator.consumer`
//      retries FIVE times with exponential backoff, so "call the seam twice" is the expected path on any
//      slow-but-successful M8 write. M19 owns the guard: `linkEncounter` is a CONDITIONAL write
//      (`WHERE linked_encounter_id IS NULL`) and `already_linked` is a first-class outcome.
//   2. D8 names `EncounterCreator.createTriageTelephonicContact({...})`. M8 published one method,
//      `createDraftEncounter`. M19 calls the real one (the M19-T01 note in @wardenx/types records this).
//   3. D1/D8 name `encounter_type='triage_telephonic_contact'`. `EncounterType` has no such member; the
//      value is `telephonic` (`M19_ENCOUNTER_TYPE`). M19's own `triage_call` row is what makes the
//      telephonic contact a triage one — a new M8 enum member would have been a cross-module schema change
//      to satisfy a spelling.
//
// THE FAILURE DIRECTIONS ARE NOT THE SAME, and that is deliberate. An M8 outage is `deferred` (§2.7's
// degraded class D-B: the call sits in `documented_pending_encounter`, the RN is free for the next call,
// the worker retries). A call with no identified patient is `blocked` — retrying forever cannot conjure the
// admission M8 requires, so it surfaces as the documentation gap it is and the D6 doc-gate watchdog / Clin
// Supv path picks it up. Collapsing the two would either spin a dead job for 24h or strand a recoverable
// outage in a DLQ nobody reads at 2 a.m.
import type {
  AdmissionId,
  CreateEncounterInput,
  EncounterDiscipline,
  EncounterId,
  IsoInstant,
  LocalDate,
  MembershipId,
  OrgId,
  PatientId,
  TriageCallId,
} from "@wardenx/types";
import { M19_ENCOUNTER_TYPE } from "@wardenx/types";
import type { TriageSideEffect } from "../lifecycle/effects";
import { require_ } from "../lifecycle/errors";
import type { TriageActorDiscipline } from "../lifecycle/protocol";
import { getEncounterCreator } from "../seams/consumed";

/** The `triage_call` columns the encounter planner reads (§3.3). All four cross-module ids are the LOGICAL
 *  uuids the row carries; none is dereferenced here — M8 resolves its own. */
export interface TriageEncounterCallFacts {
  readonly triageCallId: TriageCallId;
  readonly organizationId: OrgId;
  /** NULL until route #4 `identify-patient` matched the caller (§3.3). */
  readonly patientId: PatientId | null;
  /** NULL for the same reason; M8 requires it NOT NULL. */
  readonly admissionId: AdmissionId | null;
  /** Already linked ⇒ the plan is a no-op; see the header on why this is M19's guard and not M8's. */
  readonly linkedEncounterId: EncounterId | null;
  /** §2.7: for a paper-origin re-entry this is the ORIGINAL call time, which is also the service date the
   *  encounter must carry — a re-entered outage call is not an encounter that happened today. */
  readonly openedAt: IsoInstant;
}

/**
 * D8 — the M8 authoring discipline for a triage actor, or `null` when the actor cannot author at all.
 *
 * `supervisor` maps to `rn`: §6's supervisor band is the Clin Supv / DON / TN group, all RN-licensed, and
 * `encounter_discipline` has no supervisory member — the encounter records the LICENSE that authored it,
 * not the org chart position.
 *
 * `external` maps to NOTHING, and that is the point. §7.5's vendor operator authenticates through ADR-0026's
 * `external_triage_vendor` session class, holds no WardenX membership, and appears in no
 * `encounter_discipline`. There is no id M8 could set as `authorMembershipId`. Returning a plausible
 * discipline here would have produced an encounter attributed to whichever membership the worker happened
 * to be running as — a false clinical signature in a survey record.
 */
export function encounterDisciplineFor(
  discipline: TriageActorDiscipline,
): EncounterDiscipline | null {
  switch (discipline) {
    case "clinical_rn":
    case "supervisor":
      return "rn";
    case "clinical_lpn":
      return "lpn";
    case "msw":
      return "msw";
    case "chaplain":
      return "chaplain";
    case "medical_director":
      return "md";
    case "external":
      return null;
  }
}

/** The plan for one call's M8 encounter (§2.4's `create_encounter` effect, resolved). */
export type TriageEncounterPlan =
  /** The call already carries a link — the §2.6 idempotency outcome and, on the retry path, the common one. */
  | { readonly kind: "already_linked"; readonly encounterId: EncounterId }
  /** Hand `input` to `EncounterCreator.createDraftEncounter`. */
  | { readonly kind: "create"; readonly input: CreateEncounterInput };

/**
 * D8 — plan the M8 draft encounter for a call. PURE: no seam, no clock, no DB.
 *
 * `serviceDate` is accepted rather than always derived because the derivation is genuinely ambiguous.
 * `triage_call` carries no timezone, so slicing the ISO instant yields the UTC date — and a 22:30 call in
 * US/Eastern is already tomorrow in UTC, which would date the encounter a day after the night it documents.
 * The route layer (T07), which holds the tenant's timezone, passes the local date; the UTC slice is the
 * fallback for the worker path, and it is the same fallback the rest of the corpus uses.
 *
 * Refuses in two directions rather than inventing a value (see the file header for why they differ):
 *   • no author discipline ⇒ `ENCOUNTER_ACTOR_CANNOT_AUTHOR` (§7.5's vendor operator);
 *   • no patient or no admission ⇒ `ENCOUNTER_PATIENT_NOT_IDENTIFIED` (route #4 was skipped).
 */
export function planTriageEncounter(input: {
  readonly call: TriageEncounterCallFacts;
  readonly actorDiscipline: TriageActorDiscipline;
  readonly authorMembershipId: MembershipId;
  readonly serviceDate?: LocalDate;
}): TriageEncounterPlan {
  if (input.call.linkedEncounterId !== null) {
    return { kind: "already_linked", encounterId: input.call.linkedEncounterId };
  }

  const discipline = encounterDisciplineFor(input.actorDiscipline);
  require_(
    discipline !== null,
    "ENCOUNTER_ACTOR_CANNOT_AUTHOR",
    `a '${input.actorDiscipline}' actor holds no WardenX clinical identity to author the M8 encounter; the in-agency clinician who took the handoff documents the call (§7.5)`,
  );
  require_(
    input.call.patientId !== null && input.call.admissionId !== null,
    "ENCOUNTER_PATIENT_NOT_IDENTIFIED",
    "the call has no identified patient/admission; M8 requires both, so route #4 identify-patient must run before the encounter can open",
  );

  return {
    kind: "create",
    input: {
      patientId: input.call.patientId,
      admissionId: input.call.admissionId,
      // D1/D8 — the existing `telephonic` member, not a bespoke triage one (header note 3).
      encounterType: M19_ENCOUNTER_TYPE,
      discipline,
      serviceDate: input.serviceDate ?? input.call.openedAt.slice(0, 10),
      authorMembershipId: input.authorMembershipId,
      // D1 — a triage call is an ad-hoc contact; the visit an M17 dispatch disposition creates gets its
      // OWN encounter when the clinician arrives (§7.9 says so explicitly). Bracketing this encounter to
      // that visit would make the phone call and the home visit the same documented event.
      visitId: null,
    },
  };
}

/**
 * The M19-owned write behind the link. Not a seam: `triage_call` is M19's own row.
 *
 * `linkEncounter` MUST be the conditional form (`SET linked_encounter_id = $3 WHERE id = $2 AND
 * linked_encounter_id IS NULL`) and report which branch it took — that conditional is the entire idempotency
 * guarantee §2.6 wrongly attributes to M8. The Drizzle implementation lands with the T07 service layer; the
 * §9 tests implement it in memory.
 */
export interface TriageEncounterLinkPort {
  linkEncounter(
    organizationId: OrgId,
    triageCallId: TriageCallId,
    encounterId: EncounterId,
  ): Promise<"linked" | "already_linked">;
}

/** The outcome of one `create_encounter` effect execution (§2.4 / §4.8). */
export type TriageEncounterLinkOutcome =
  /** The link now exists and this attempt made it. */
  | { readonly kind: "linked"; readonly encounterId: EncounterId }
  /** The call was already linked — either before the seam call (the cheap path) or by a concurrent
   *  attempt. `orphanedEncounterId` is set in the second case: M8 minted a draft nobody will ever sign,
   *  and saying so is the only way the ops path can find it. There is no way to prevent it from here —
   *  M8's creator has no dedupe key (header note 1) — so it is REPORTED rather than swallowed. */
  | {
      readonly kind: "already_linked";
      readonly encounterId: EncounterId | null;
      readonly orphanedEncounterId: EncounterId | null;
    }
  /** §2.7 degraded class D-B — M8 was unreachable. The call stays in `documented_pending_encounter`, the
   *  RN is not blocked, and the §4.8 queue retries. NOT a throw: a thrown error here would fail the
   *  disposition transaction that already committed. */
  | { readonly kind: "deferred"; readonly reason: string };

/**
 * D8 / §2.4 — execute the `create_encounter` effect: mint the M8 draft and persist the back-reference.
 *
 * Ordering is create-then-link because the reverse is impossible (there is no id to write before M8 returns
 * one). The cost is the orphan window described on `already_linked`; the benefit is that the link is never
 * written for an encounter that does not exist, which would strand the call permanently — `markDocumented`
 * compares the signed encounter id against the link, so a phantom link can never be satisfied.
 *
 * Called OUTSIDE the disposition transaction (M21-T05's finding: a cross-module seam probe inside your own
 * transaction self-deadlocks the pool), which is also what §2.7 D-B requires — the transition commits, then
 * the effect runs, then the worker retries it if M8 was down.
 */
export async function linkTriageEncounter(input: {
  readonly call: TriageEncounterCallFacts;
  readonly actorDiscipline: TriageActorDiscipline;
  readonly authorMembershipId: MembershipId;
  readonly serviceDate?: LocalDate;
  readonly port: TriageEncounterLinkPort;
}): Promise<TriageEncounterLinkOutcome> {
  const plan = planTriageEncounter(input);
  if (plan.kind === "already_linked") {
    return { kind: "already_linked", encounterId: plan.encounterId, orphanedEncounterId: null };
  }

  let encounterId: EncounterId;
  try {
    const created = await getEncounterCreator().createDraftEncounter(plan.input);
    encounterId = created.encounterId;
  } catch (error) {
    return {
      kind: "deferred",
      reason: error instanceof Error ? error.message : "EncounterCreator unreachable",
    };
  }

  const written = await input.port.linkEncounter(
    input.call.organizationId,
    input.call.triageCallId,
    encounterId,
  );
  if (written === "already_linked") {
    return { kind: "already_linked", encounterId: null, orphanedEncounterId: encounterId };
  }
  return { kind: "linked", encounterId };
}

/** §2.4 — the declarative effect the disposition path emits; re-exported here so the effect and its
 *  executor are found together. The runner (T07) resolves it through {@link linkTriageEncounter}. */
export const CREATE_ENCOUNTER_EFFECT: Extract<TriageSideEffect, { kind: "create_encounter" }> = {
  kind: "create_encounter",
};
