// apps/backend/__tests__/scheduling-consumers.test.ts — M17-T06 (§4.4 the seams M17 CONSUMES). Covers the M8
// BIDIRECTIONAL read side: the pure `planVisitCompletionFromEncounter` mapping of a consumed `m8.encounter.signed`
// to the visit's terminal `complete` transition (and its three skip reasons), the subscription binding, and the
// boot wiring of the consumed-seam accessors — M8's MileagePayrollReader/BillableEncounterReader (Wave E) plus
// the two NEW M15 deny-stubbed entries (VolunteerComplianceProvider/SupervisoryCadenceReader, M17-F06/ADR-0009):
// validateSeams() still passes (the deny-stub is the fail-closed default) and every consumed accessor denies LOUDLY
// until its producer registers a real impl.
import { describe, expect, it } from "vitest";
import { __resetSeamsForTest, validateSeams } from "../src/bootstrap/index";
import {
  type EncounterSignedConsumed,
  M17_OUTBOX_EVENTS,
  M17_OUTBOX_SUBSCRIPTIONS,
  getBillableEncounterReader,
  getMileagePayrollReader,
  getSupervisoryCadenceReader,
  getVolunteerComplianceProvider,
  planVisitCompletionFromEncounter,
} from "../src/modules/17-scheduling/index";

const SIGNED: EncounterSignedConsumed = {
  encounterId: "enc-1",
  patientId: "pat-1",
  visitId: "vis-1",
  signedAt: "2026-03-05T15:05:00.000Z",
};

describe("planVisitCompletionFromEncounter (§4.4 M8 bidirectional)", () => {
  it("completes the linked visit when it is in_visit (system-actor complete)", () => {
    const plan = planVisitCompletionFromEncounter(SIGNED, { state: "in_visit" });
    expect(plan).toEqual({
      kind: "complete",
      visitId: "vis-1",
      event: { type: "complete", isSystemActor: true },
    });
  });

  it("skips no_visit_link for an ad-hoc/retroactive encounter (NULL visit_id; M8 D2 reconciliation)", () => {
    const plan = planVisitCompletionFromEncounter(
      { ...SIGNED, visitId: undefined },
      { state: "in_visit" },
    );
    expect(plan).toEqual({ kind: "skip", reason: "no_visit_link" });
  });

  it("skips visit_not_found when the linked visit is absent under RLS", () => {
    expect(planVisitCompletionFromEncounter(SIGNED, null)).toEqual({
      kind: "skip",
      reason: "visit_not_found",
    });
  });

  it("skips not_completable from a non-in_visit state (published) — left to the reconciliation sweep", () => {
    expect(planVisitCompletionFromEncounter(SIGNED, { state: "published" })).toEqual({
      kind: "skip",
      reason: "not_completable",
    });
  });

  it("skips not_completable on re-delivery (already completed) — idempotent no-op", () => {
    expect(planVisitCompletionFromEncounter(SIGNED, { state: "completed" })).toEqual({
      kind: "skip",
      reason: "not_completable",
    });
  });

  it("binds m8.encounter.signed to the M17 consumer", () => {
    expect(M17_OUTBOX_SUBSCRIPTIONS).toContainEqual({
      eventName: "m8.encounter.signed",
      consumerName: "m17.m8-encounter-signed",
    });
  });

  it("declares M8 as a live cleanup consumer for cancelled, no-show, and rescheduled visits", () => {
    for (const eventName of [
      "m17.visit.cancelled",
      "m17.visit.no_show_detected",
      "m17.visit.rescheduled",
    ]) {
      const event = M17_OUTBOX_EVENTS.find((candidate) => candidate.eventName === eventName);
      expect(event?.declaredConsumers).toContain("m8");
    }
  });
});

describe("consumed-seam accessors (§4.4) fail closed until their producer registers", () => {
  it("validateSeams passes with the M15 entries deny-stubbed, and every consumed seam denies on call", () => {
    __resetSeamsForTest();
    // No module registers M8/M15 here → validateSeams applies each seam's fail-closed deny-stub default.
    expect(() => validateSeams()).not.toThrow();
    expect(() => getMileagePayrollReader().mileageForPayrollPeriod("mem-rn", {} as never)).toThrow(
      /not implemented/,
    );
    expect(() => getBillableEncounterReader().billability([])).toThrow(/not implemented/);
    expect(() => getVolunteerComplianceProvider().effectiveStatusFor("org-1", "mem-vol")).toThrow(
      /not implemented/,
    );
    expect(() => getSupervisoryCadenceReader().nextSupervisoryDueAt("org-1", "adm-1")).toThrow(
      /not implemented/,
    );
    __resetSeamsForTest();
  });
});
