// apps/backend/src/modules/29-external-interfaces/__tests__/m29-unmatched-lab-review.test.ts — the §4.2
// unmatched-lab review decisions (GAP-044). PURE: the two planners, their refusals, and the derivation of
// the deferred `lab_observation` parent from the OBX rows ingest persisted under the reserved id.
import { describe, expect, it } from "vitest";

import {
  DISCARD_REASON_MIN_CHARS,
  type UnmatchedLabQueueItem,
  type UnmatchedLabValueFacts,
  planUnmatchedBind,
  planUnmatchedDiscard,
} from "../inbound/unmatched-lab-review";

const ORG = "org-1";
const OBS = "obs-reserved-1";
const MSG = "msg-1";
const REVIEWER = "membership-reviewer";
const PATIENT = "patient-1";
const AGENCY = "pe-1";
const NOW = new Date("2026-08-14T10:00:00.000Z");
const INGESTED = new Date("2026-08-01T06:30:00.000Z");

const value = (o: Partial<UnmatchedLabValueFacts> = {}): UnmatchedLabValueFacts => ({
  obxSetId: o.obxSetId ?? 1,
  loincCode: o.loincCode ?? "718-7",
  loincDisplayText: o.loincDisplayText ?? "Hemoglobin",
  terminologyValidation: o.terminologyValidation ?? "valid",
  abnormalFlag: o.abnormalFlag ?? null,
  receivedAt: o.receivedAt ?? INGESTED,
});

const item = (o: Partial<UnmatchedLabQueueItem> = {}): UnmatchedLabQueueItem => ({
  linkId: o.linkId ?? "link-1",
  organizationId: o.organizationId ?? ORG,
  observationId: o.observationId ?? OBS,
  sourceMessageId: o.sourceMessageId ?? MSG,
  matchMethod: o.matchMethod ?? "unmatched",
  candidatePatientId: o.candidatePatientId ?? null,
  resolvedAt: o.resolvedAt ?? null,
  createdAt: o.createdAt ?? INGESTED,
  values: o.values ?? [value()],
});

const bindCmd = {
  patient: { patientId: PATIENT, providerEntityId: AGENCY },
  decidedByMembershipId: REVIEWER,
  now: NOW,
};
const discardCmd = {
  reason: "sending lab typo'd the MRN; belongs to another agency",
  decidedByMembershipId: REVIEWER,
  now: NOW,
};

describe("planUnmatchedBind (§4.2 manual bind)", () => {
  it("materializes the deferred lab_observation parent under the RESERVED id", () => {
    const plan = planUnmatchedBind(item(), bindCmd);
    if (plan.kind !== "bind") throw new Error(`expected bind, got ${plan.kind}`);
    // The id is the one the link row already reserved — the bind creates the parent, it does not update
    // an existing row (there has never been one).
    expect(plan.observation.id).toBe(OBS);
    expect(plan.observation.patientId).toBe(PATIENT);
    expect(plan.observation.providerEntityId).toBe(AGENCY);
    expect(plan.observation.sourceMessageId).toBe(MSG);
    expect(plan.observation.orderId).toBeNull();
  });

  it("co-partitions the parent with its already-persisted children (receivedAt from the values, not now)", () => {
    // `lab_observation` and `lab_observation_value` are monthly-partitioned on `received_at`. Stamping the
    // BIND instant would drop the parent in 2026-08 while its values sit in 2026-08 — or, for a result
    // reviewed across a month boundary, in a different partition entirely, and the composite-PK join
    // silently stops resolving.
    const plan = planUnmatchedBind(item({ values: [value({ receivedAt: INGESTED })] }), bindCmd);
    if (plan.kind !== "bind") throw new Error("expected bind");
    expect(plan.observation.receivedAt).toEqual(INGESTED);
    expect(plan.observation.receivedAt).not.toEqual(NOW);
  });

  it("takes the EARLIEST value receivedAt when a panel's rows straggle", () => {
    const later = new Date("2026-08-01T06:45:00.000Z");
    const plan = planUnmatchedBind(
      item({
        values: [
          value({ obxSetId: 2, receivedAt: later }),
          value({ obxSetId: 1, receivedAt: INGESTED }),
        ],
      }),
      bindCmd,
    );
    if (plan.kind !== "bind") throw new Error("expected bind");
    expect(plan.observation.receivedAt).toEqual(INGESTED);
  });

  it("derives the panel LOINC from the LOWEST OBX set id, not array order", () => {
    const plan = planUnmatchedBind(
      item({
        values: [
          value({ obxSetId: 3, loincCode: "2345-7", loincDisplayText: "Glucose" }),
          value({ obxSetId: 1, loincCode: "718-7", loincDisplayText: "Hemoglobin" }),
        ],
      }),
      bindCmd,
    );
    if (plan.kind !== "bind") throw new Error("expected bind");
    expect(plan.observation.loincCode).toBe("718-7");
  });

  it("computes the panel abnormal summary across every value", () => {
    const plan = planUnmatchedBind(
      item({
        values: [
          value({ obxSetId: 1, abnormalFlag: "N" }),
          value({ obxSetId: 2, abnormalFlag: "LL" }),
        ],
      }),
      bindCmd,
    );
    if (plan.kind !== "bind") throw new Error("expected bind");
    expect(plan.observation.abnormalSummary).toBe("any_critical");
    expect(plan.event.payload.abnormalSummary).toBe("any_critical");
  });

  it("inherits the WEAKEST terminology validation across the panel", () => {
    // A panel is only safe for the FHIR projection / HQRP filters if EVERY value mapped — one unmapped
    // OBX makes the whole observation `unknown_code`.
    const unknown = planUnmatchedBind(
      item({
        values: [
          value({ obxSetId: 1, terminologyValidation: "valid" }),
          value({ obxSetId: 2, terminologyValidation: "unknown_code" }),
        ],
      }),
      bindCmd,
    );
    if (unknown.kind !== "bind") throw new Error("expected bind");
    expect(unknown.observation.terminologyValidation).toBe("unknown_code");

    const deprecated = planUnmatchedBind(
      item({
        values: [
          value({ obxSetId: 1, terminologyValidation: "valid" }),
          value({ obxSetId: 2, terminologyValidation: "deprecated" }),
        ],
      }),
      bindCmd,
    );
    if (deprecated.kind !== "bind") throw new Error("expected bind");
    expect(deprecated.observation.terminologyValidation).toBe("deprecated");
  });

  it("flips the link to `manual` and stamps the reviewer + optional note", () => {
    const plan = planUnmatchedBind(item(), {
      ...bindCmd,
      note: "  confirmed with the sending lab  ",
    });
    if (plan.kind !== "bind") throw new Error("expected bind");
    expect(plan.linkPatch).toMatchObject({
      matchMethod: "manual",
      candidatePatientId: PATIENT,
      resolution: "manually_matched",
      resolvedByMembershipId: REVIEWER,
      resolutionReason: "confirmed with the sending lab",
    });
    expect(plan.linkPatch.resolvedAt).toEqual(NOW);
  });

  it("normalizes a whitespace-only note to null rather than storing blanks", () => {
    const plan = planUnmatchedBind(item(), { ...bindCmd, note: "   " });
    if (plan.kind !== "bind") throw new Error("expected bind");
    expect(plan.linkPatch.resolutionReason).toBeNull();
  });

  it("refuses a patient with no provider entity — ARCH-011 cannot be satisfied", () => {
    const plan = planUnmatchedBind(item(), {
      ...bindCmd,
      patient: { patientId: PATIENT, providerEntityId: null },
    });
    expect(plan).toMatchObject({ kind: "refused", reason: "patient_has_no_provider_entity" });
  });

  it("refuses an already-resolved item — decided is decided", () => {
    const plan = planUnmatchedBind(item({ resolvedAt: NOW }), bindCmd);
    expect(plan).toMatchObject({ kind: "refused", reason: "already_resolved" });
  });

  it("refuses a link row that records an AUTO-attached lab, not a queue item", () => {
    const plan = planUnmatchedBind(item({ matchMethod: "obr_placer_id" }), bindCmd);
    expect(plan).toMatchObject({ kind: "refused", reason: "not_an_unmatched_result" });
  });

  it("refuses an item with no OBX rows — there is no result to file on a chart", () => {
    const plan = planUnmatchedBind(item({ values: [] }), bindCmd);
    expect(plan).toMatchObject({ kind: "refused", reason: "no_result_values" });
  });

  it("emits `manually_matched` naming the observation, patient and decider", () => {
    const plan = planUnmatchedBind(item(), bindCmd);
    if (plan.kind !== "bind") throw new Error("expected bind");
    expect(plan.event.name).toBe("m29.lab_observation.manually_matched");
    expect(plan.event.payload).toMatchObject({
      observationId: OBS,
      organizationId: ORG,
      patientId: PATIENT,
      sourceMessageId: MSG,
      decidedByMembershipId: REVIEWER,
      decidedAt: NOW.toISOString(),
    });
  });
});

describe("planUnmatchedDiscard (§4.2 / §5.2.4 discard)", () => {
  it("tombstones the link with the reviewer's reason — and creates NO observation", () => {
    const plan = planUnmatchedDiscard(item(), discardCmd);
    if (plan.kind !== "discard") throw new Error(`expected discard, got ${plan.kind}`);
    expect(plan.linkPatch).toMatchObject({
      resolution: "discarded",
      resolvedByMembershipId: REVIEWER,
      resolutionReason: discardCmd.reason,
    });
    expect(plan.linkPatch.resolvedAt).toEqual(NOW);
    expect("observation" in plan).toBe(false);
  });

  it(`refuses a reason under ${DISCARD_REASON_MIN_CHARS} characters (§5.2.4)`, () => {
    expect(planUnmatchedDiscard(item(), { ...discardCmd, reason: "dupe" })).toMatchObject({
      kind: "refused",
      reason: "reason_too_short",
    });
  });

  it("counts the TRIMMED reason — padding is not an explanation", () => {
    expect(
      planUnmatchedDiscard(item(), { ...discardCmd, reason: `  dupe${" ".repeat(20)}` }),
    ).toMatchObject({ kind: "refused", reason: "reason_too_short" });
    const ok = planUnmatchedDiscard(item(), { ...discardCmd, reason: "  duplicate result  " });
    if (ok.kind !== "discard") throw new Error("expected discard");
    expect(ok.linkPatch.resolutionReason).toBe("duplicate result");
  });

  it("refuses an already-resolved item", () => {
    expect(planUnmatchedDiscard(item({ resolvedAt: NOW }), discardCmd)).toMatchObject({
      kind: "refused",
      reason: "already_resolved",
    });
  });

  it("emits `discarded` carrying the reason — the §164.528 record of why a result was ignored", () => {
    const plan = planUnmatchedDiscard(item(), discardCmd);
    if (plan.kind !== "discard") throw new Error("expected discard");
    expect(plan.event.name).toBe("m29.lab_observation.discarded");
    expect(plan.event.payload).toMatchObject({
      observationId: OBS,
      sourceMessageId: MSG,
      decidedByMembershipId: REVIEWER,
      reason: discardCmd.reason,
    });
  });
});
