// apps/backend/src/modules/29-external-interfaces/__tests__ — M29-T04 inbound ADT flow: segment projection,
// cascade-outcome routing, propose-then-review builder, decision core, and the review FSM (§4.6/§4.1.2/§2.2,
// W-XI-01..04).
import { describe, expect, it } from "vitest";
import { extractSsnLast4, hl7DateToIso, projectAdt } from "../inbound/hl7-adt-projection";
import type { MatchOutcome } from "../inbound/match-cascade";
import {
  type CascadeMessageContext,
  projectCascadeForMessage,
  routeCascadeOutcome,
} from "../inbound/outcome-router";
import {
  ProposalAlreadyDecidedError,
  ProposalRejectRationaleRequiredError,
  type ProposalSnapshot,
  decideProposal,
  expireProposal,
} from "../proposals/decision";
import {
  canDecideProposal,
  canHl7InboundProposalTransition,
  hl7InboundProposalTransition,
  hl7ProposalReviewPosture,
} from "../proposals/lifecycle";
import { MESSAGE_TYPE_ROUTING, isSupportedAdt } from "../proposals/message-type-routing";
import { planProposal } from "../proposals/proposal-builder";

const CR = "\r";
function frame(segments: string[]): string {
  return segments.join(CR);
}
/** Build a non-MSH segment from an explicit field array ([0] is the segment name). */
function seg(fields: string[]): string {
  return fields.join("|");
}

const MSH_A08 =
  "MSH|^~\\&|SENDAPP|ST_ANTHONY|RECVAPP|ENGRACE|20260801120000||ADT^A08|MCID-W01|P|2.5.1";
const EVN_A08 = "EVN|A08|20260801130000";
// PID: -3 has two reps (internal ENGRACE_INTERNAL + external ST_ANTHONY), -5 DOE^JANE^Q, -7 dob, -8 F,
// -11 address, -13 phone, -19 SSN.
const PID_FIELDS: string[] = (() => {
  const f: string[] = new Array(20).fill("");
  f[0] = "PID";
  f[1] = "1";
  f[3] = "MRN-001234^^^ENGRACE_INTERNAL^MR~ST_ANTH_999^^^ST_ANTHONY^MR";
  f[5] = "DOE^JANE^Q";
  f[7] = "19480322";
  f[8] = "F";
  f[11] = "123 MAIN ST^APT 4^PORTLAND^OR^97801";
  f[13] = "555-1212";
  f[19] = "987654321";
  return f;
})();
const PV1_I = "PV1|1|I|||||||||||||||||||||||||||||||||||||||||20260801125500";

describe("projectAdt (§4.6 segment projection)", () => {
  const projected = projectAdt(frame([MSH_A08, EVN_A08, seg(PID_FIELDS), PV1_I]))!;

  it("recombines the message type + trigger event", () => {
    expect(projected.messageType).toBe("ADT^A08");
    expect(projected.triggerEvent).toBe("A08");
  });

  it("projects the PID-3 identifier repetitions with assigning authorities and type codes", () => {
    expect(projected.patientCandidate.identifiers).toEqual([
      { value: "MRN-001234", assigningAuthority: "ENGRACE_INTERNAL", typeCode: "MR" },
      { value: "ST_ANTH_999", assigningAuthority: "ST_ANTHONY", typeCode: "MR" },
    ]);
  });

  it("projects name, DOB (ISO), sex, ssn-last4, address, phone", () => {
    const c = projected.patientCandidate;
    expect(c.lastName).toBe("DOE");
    expect(c.firstName).toBe("JANE");
    expect(c.middleName).toBe("Q");
    expect(c.dateOfBirth).toBe("1948-03-22");
    expect(c.administrativeSex).toBe("F");
    expect(c.ssnLast4).toBe("4321");
    expect(c.address).toEqual({
      line1: "123 MAIN ST",
      line2: "APT 4",
      city: "PORTLAND",
      state: "OR",
      postalCode: "97801",
    });
    expect(c.phoneHome).toBe("555-1212");
  });

  it("projects PV1 visit class and EVN recorded time", () => {
    expect(projected.visit?.patientClass).toBe("I");
    expect(projected.eventRecordedAtRaw).toBe("20260801130000");
  });

  it("returns null when the frame has no PID", () => {
    expect(projectAdt(frame([MSH_A08, EVN_A08]))).toBeNull();
  });

  it("returns null when the frame has no MSH", () => {
    expect(projectAdt(frame([seg(PID_FIELDS)]))).toBeNull();
  });

  it("falls back to a PID-3 SS-typed identifier when PID-19 is absent", () => {
    const f = [...PID_FIELDS];
    f[19] = "";
    f[3] = "MRN-001234^^^ENGRACE_INTERNAL^MR~111-22-3333^^^SSA^SS";
    const p = projectAdt(frame([MSH_A08, seg(f)]))!;
    expect(p.patientCandidate.ssnLast4).toBe("3333");
  });

  it("date + ssn helpers handle degenerate input", () => {
    expect(hl7DateToIso("2026")).toBe("");
    expect(hl7DateToIso(undefined)).toBe("");
    expect(hl7DateToIso("20260801120000")).toBe("2026-08-01");
    expect(extractSsnLast4("12")).toBeUndefined();
    expect(extractSsnLast4(undefined)).toBeUndefined();
    expect(extractSsnLast4("000-12-6789")).toBe("6789");
  });
});

const CTX: CascadeMessageContext = {
  messageId: "msg_1",
  feedId: "feed_1",
  organizationId: "org_engrace",
  messageControlId: "MCID-W01",
  messageType: "ADT^A08",
};

describe("outcome router (§5/§6)", () => {
  it("projects the message columns per outcome kind", () => {
    expect(
      projectCascadeForMessage({
        kind: "confident_match",
        patientId: "p1",
        level: "L1_MRN_EXACT",
        mergeRedirectHops: 0,
      }),
    ).toEqual({
      matchedPatientId: "p1",
      matchLevel: "L1_MRN_EXACT",
      matchOutcome: "matched_single",
      matchConfidence: null,
    });
    expect(
      projectCascadeForMessage({
        kind: "candidate_match",
        patientId: "p1",
        level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
        confidence: 0.92,
        mergeRedirectHops: 0,
      }),
    ).toMatchObject({
      matchOutcome: "matched_single",
      matchConfidence: "0.920",
    });
    expect(
      projectCascadeForMessage({
        kind: "ambiguous",
        candidateIds: ["a", "b"],
        level: "L3_SSN_DOB",
      }),
    ).toMatchObject({ matchOutcome: "matched_ambiguous", matchedPatientId: null });
    expect(projectCascadeForMessage({ kind: "no_match" })).toEqual({
      matchedPatientId: null,
      matchLevel: "NO_MATCH",
      matchOutcome: "no_match",
      matchConfidence: null,
    });
  });

  it("routes confident/candidate/ambiguous/no_match to the resolved events", () => {
    expect(
      routeCascadeOutcome(
        { kind: "confident_match", patientId: "p1", level: "L1_MRN_EXACT", mergeRedirectHops: 2 },
        CTX,
      ),
    ).toMatchObject({
      name: "m29.hl7_message.cascade_resolved_confident",
      payload: { matchedPatientId: "p1", matchLevel: "L1_MRN_EXACT", mergeRedirectHops: 2 },
    });
    expect(
      routeCascadeOutcome(
        {
          kind: "candidate_match",
          patientId: "p1",
          level: "L5_LOOSE_NAME_DOB_CANDIDATE",
          confidence: 0.78,
          mergeRedirectHops: 0,
        },
        CTX,
      ),
    ).toMatchObject({
      name: "m29.hl7_message.cascade_resolved_candidate",
      payload: { candidatePatientId: "p1", candidateIds: ["p1"], matchConfidence: 0.78 },
    });
    expect(
      routeCascadeOutcome(
        { kind: "ambiguous", candidateIds: ["a", "b"], level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE" },
        CTX,
      ),
    ).toMatchObject({
      name: "m29.hl7_message.cascade_resolved_candidate",
      payload: { candidatePatientId: null, candidateIds: ["a", "b"], matchConfidence: null },
    });
    expect(routeCascadeOutcome({ kind: "no_match" }, CTX)).toMatchObject({
      name: "m29.hl7_message.cascade_resolved_no_match",
    });
  });
});

describe("message-type routing (§3)", () => {
  it("maps each supported ADT trigger", () => {
    expect(MESSAGE_TYPE_ROUTING["ADT^A08"]).toEqual({
      resourceKind: "patient_demographic_update",
      ownerModule: "m5",
      noMatchBehavior: "propose_new_patient",
    });
    expect(MESSAGE_TYPE_ROUTING["ADT^A01"].ownerModule).toBe("m6");
    expect(MESSAGE_TYPE_ROUTING["ADT^A03"].noMatchBehavior).toBe("drop_with_audit");
    expect(isSupportedAdt("ADT^A99")).toBe(false);
    expect(isSupportedAdt("ADT^A08")).toBe(true);
  });
});

describe("proposal builder (§2.1/§4)", () => {
  const proposedAt = new Date("2026-08-01T12:00:00.000Z");
  const expiresAt = new Date("2026-08-04T12:00:00.000Z");
  const base = {
    context: CTX,
    proposedPatientCandidate: { any: "candidate" },
    proposalId: "prop_1",
    proposedAt,
    expiresAt,
  };

  it("W-XI-01: an A08 confident match plans an M5 patient_demographic_update proposal, unmutated", () => {
    const plan = planProposal({
      ...base,
      outcome: {
        kind: "confident_match",
        patientId: "pt_jane",
        level: "L1_MRN_EXACT",
        mergeRedirectHops: 0,
      },
    });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") throw new Error("unreachable");
    expect(plan.proposal).toMatchObject({
      id: "prop_1",
      ownerModule: "m5",
      resourceKind: "patient_demographic_update",
      matchedPatientId: "pt_jane",
      matchOutcome: "matched_single",
      proposalStatus: "pending",
      matchCandidateIds: ["pt_jane"],
    });
    expect(plan.event).toMatchObject({
      name: "m29.hl7_inbound_proposal.created",
      payload: {
        ownerModule: "m5",
        matchLevel: "L1_MRN_EXACT",
        matchConfidence: null,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  it("W-XI-02: an A08 L4 candidate carries confidence 0.92", () => {
    const plan = planProposal({
      ...base,
      outcome: {
        kind: "candidate_match",
        patientId: "pt_jane",
        level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
        confidence: 0.92,
        mergeRedirectHops: 0,
      },
    });
    if (plan.kind !== "create") throw new Error("expected create");
    expect(plan.proposal.matchConfidence).toBe("0.920");
    expect(plan.event.payload.matchConfidence).toBe(0.92);
  });

  it("an ambiguous outcome plans a matched_ambiguous proposal with the candidate list", () => {
    const plan = planProposal({
      ...base,
      outcome: { kind: "ambiguous", candidateIds: ["a", "b"], level: "L3_SSN_DOB" },
    });
    if (plan.kind !== "create") throw new Error("expected create");
    expect(plan.proposal.matchOutcome).toBe("matched_ambiguous");
    expect(plan.proposal.matchedPatientId).toBeNull();
    expect(plan.proposal.matchCandidateIds).toEqual(["a", "b"]);
  });

  it("an A08 no_match plans an M5 new_patient proposal", () => {
    const plan = planProposal({ ...base, outcome: { kind: "no_match" } });
    if (plan.kind !== "create") throw new Error("expected create");
    expect(plan.proposal.resourceKind).toBe("new_patient");
    expect(plan.proposal.ownerModule).toBe("m5");
    expect(plan.proposal.matchOutcome).toBe("no_match");
  });

  it("an A01 admit routes to M6 admission_event", () => {
    const plan = planProposal({
      ...base,
      context: { ...CTX, messageType: "ADT^A01" },
      outcome: {
        kind: "confident_match",
        patientId: "pt_x",
        level: "L2_EXTERNAL_MRN_EXACT",
        mergeRedirectHops: 0,
      },
    });
    if (plan.kind !== "create") throw new Error("expected create");
    expect(plan.proposal.ownerModule).toBe("m6");
    expect(plan.proposal.resourceKind).toBe("admission_event");
  });

  it("an A03 discharge no_match drops with audit (cannot act on an unknown patient)", () => {
    const plan = planProposal({
      ...base,
      context: { ...CTX, messageType: "ADT^A03" },
      outcome: { kind: "no_match" },
    });
    expect(plan).toEqual({
      kind: "drop",
      event: {
        name: "m29.hl7_message.routing_dropped",
        payload: { ...CTX, messageType: "ADT^A03", reason: "cannot_act_on_unknown_patient" },
      },
    });
  });

  it("skips an unsupported message type", () => {
    const plan = planProposal({
      ...base,
      context: { ...CTX, messageType: "ORU^R01" },
      outcome: {
        kind: "confident_match",
        patientId: "p",
        level: "L1_MRN_EXACT",
        mergeRedirectHops: 0,
      },
    });
    expect(plan).toEqual({ kind: "skip", reason: "unsupported_message_type" });
  });
});

describe("proposal decision core (§4.1.2, W-XI-03/04)", () => {
  const snapshot: ProposalSnapshot = {
    id: "prop_1",
    organizationId: "org_engrace",
    sourceMessageId: "msg_1",
    resourceKind: "patient_demographic_update",
    ownerModule: "m5",
    matchedPatientId: "pt_jane",
    proposalStatus: "pending",
    proposedPatientCandidate: { any: "candidate" },
  };
  const decidedAt = new Date("2026-08-02T09:00:00.000Z");

  it("W-XI-03: a partial accept emits accepted with the applied-field list + candidate", () => {
    const result = decideProposal(snapshot, {
      kind: "accept",
      decidedByMembershipId: "mem_1",
      decidedAt,
      appliedFields: ["address_line1", "address_city"],
      decisionRationale: "Address verified by phone call to patient",
    });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.update).toMatchObject({
      proposalStatus: "accepted",
      decidedByMembershipId: "mem_1",
    });
    expect(result.event.payload).toMatchObject({
      ownerModule: "m5",
      matchedPatientId: "pt_jane",
      appliedFields: ["address_line1", "address_city"],
      proposedPatientCandidate: { any: "candidate" },
      decidedAt: decidedAt.toISOString(),
    });
  });

  it("an ambiguous accept binds the picked candidate as matchedPatientId + acceptedAggregateId", () => {
    const ambiguous: ProposalSnapshot = { ...snapshot, matchedPatientId: null };
    const result = decideProposal(ambiguous, {
      kind: "accept",
      decidedByMembershipId: "mem_1",
      decidedAt,
      acceptedAggregateId: "pt_picked",
    });
    if (result.kind !== "accepted") throw new Error("unreachable");
    expect(result.event.payload.matchedPatientId).toBe("pt_picked");
    expect(result.event.payload.acceptedAggregateId).toBe("pt_picked");
    expect(result.event.payload.appliedFields).toBeNull();
  });

  it("W-XI-04: a reject with an empty/short rationale throws (decision_note_required)", () => {
    expect(() =>
      decideProposal(snapshot, {
        kind: "reject",
        decidedByMembershipId: "mem_1",
        decidedAt,
        decisionRationale: "",
      }),
    ).toThrow(ProposalRejectRationaleRequiredError);
    expect(() =>
      decideProposal(snapshot, {
        kind: "reject",
        decidedByMembershipId: "mem_1",
        decidedAt,
        decisionRationale: "too short",
      }),
    ).toThrow(ProposalRejectRationaleRequiredError);
  });

  it("W-XI-04: a reject with a ≥40-char rationale emits rejected", () => {
    const rationale = "L4 demographic match is not Jane Doe — confirmed by RN visit on 06/03";
    const result = decideProposal(snapshot, {
      kind: "reject",
      decidedByMembershipId: "mem_1",
      decidedAt,
      decisionRationale: rationale,
    });
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.update.proposalStatus).toBe("rejected");
    expect(result.event.payload.decisionRationale).toBe(rationale);
  });

  it("defer leaves the proposal pending with no event", () => {
    expect(
      decideProposal(snapshot, {
        kind: "defer",
        decidedByMembershipId: "mem_1",
        deferredAt: decidedAt,
      }),
    ).toEqual({ kind: "deferred" });
  });

  it("decided-is-decided: any decision on a non-pending proposal throws", () => {
    const decided: ProposalSnapshot = { ...snapshot, proposalStatus: "accepted" };
    expect(() =>
      decideProposal(decided, { kind: "accept", decidedByMembershipId: "mem_1", decidedAt }),
    ).toThrow(ProposalAlreadyDecidedError);
    expect(() =>
      decideProposal(decided, {
        kind: "reject",
        decidedByMembershipId: "mem_1",
        decidedAt,
        decisionRationale: "x".repeat(50),
      }),
    ).toThrow(ProposalAlreadyDecidedError);
  });

  it("expireProposal flips a pending row and leaves terminal rows untouched", () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const result = expireProposal(
      { id: "prop_1", organizationId: "org_engrace", proposalStatus: "pending" },
      now,
    );
    expect(result?.update).toMatchObject({
      proposalStatus: "expired",
      decidedByMembershipId: null,
    });
    expect(result?.event).toMatchObject({
      name: "m29.hl7_inbound_proposal.expired",
      payload: { proposalId: "prop_1", expiredAt: now.toISOString() },
    });
    expect(
      expireProposal(
        { id: "prop_1", organizationId: "org_engrace", proposalStatus: "rejected" },
        now,
      ),
    ).toBeNull();
  });
});

describe("proposal review FSM (§2.2)", () => {
  it("permits creation + the three pending → terminal edges only", () => {
    expect(hl7InboundProposalTransition(null, "pending")?.auditAction).toBe(
      "m29.hl7_inbound_proposal.created",
    );
    expect(canHl7InboundProposalTransition("pending", "accepted")).toBe(true);
    expect(canHl7InboundProposalTransition("pending", "rejected")).toBe(true);
    expect(canHl7InboundProposalTransition("pending", "expired")).toBe(true);
    expect(canHl7InboundProposalTransition("accepted", "rejected")).toBe(false);
    expect(canHl7InboundProposalTransition("rejected", "pending")).toBe(false);
  });

  it("only pending is adjudicable", () => {
    expect(canDecideProposal("pending")).toBe(true);
    expect(canDecideProposal("accepted")).toBe(false);
    expect(canDecideProposal("expired")).toBe(false);
  });

  it("surfaces the review posture, flagging ambiguous pending proposals", () => {
    expect(hl7ProposalReviewPosture("pending", "matched_single")).toEqual({
      kind: "reviewable",
      ambiguous: false,
    });
    expect(hl7ProposalReviewPosture("pending", "matched_ambiguous")).toEqual({
      kind: "reviewable",
      ambiguous: true,
    });
    expect(hl7ProposalReviewPosture("accepted", "matched_single")).toEqual({
      kind: "decided",
      terminalStatus: "accepted",
    });
    expect(hl7ProposalReviewPosture("rejected", "no_match")).toEqual({
      kind: "decided",
      terminalStatus: "rejected",
    });
    expect(hl7ProposalReviewPosture("expired", "no_match")).toEqual({ kind: "expired" });
  });
});
