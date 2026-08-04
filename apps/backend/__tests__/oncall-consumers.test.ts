// apps/backend/__tests__/oncall-consumers.test.ts — M19-T04 (D10 inbound triggers, §7.6, §4.8, §2.6, §4.5).
//
// The pure M19 cross-module boundary — no DB, no clock: every fact is injected. The seam-touching half
// (`trigger-context`) is exercised through the M1 registry only where the read's SHAPE is the finding
// (an M18 payload that carries no patient must still produce a fully anchored row).
import type { M19SubscribedEventName, VisitDto, VisitReader } from "@wardenx/types";
import { M19_SUBSCRIBED_EVENT_NAMES } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  type CoveringShiftCandidate,
  type InboundTriggerFacts,
  LATE_CHECKOUT_CHIEF_COMPLAINT,
  type M17VisitNoShowDetectedPayload,
  M17_NO_SHOW_DETECTED_EVENT,
  type M18LateCheckOutDetectedPayload,
  M18_LATE_CHECK_OUT_DETECTED_EVENT,
  NO_SHOW_CHIEF_COMPLAINT,
  type TriggerVisitContext,
  decideLateCheckoutTrigger,
  decideNoShowTrigger,
  readTriggerVisit,
  resolveCoveringShift,
  resolveGapWindow,
  resolveInboundTriggerFacts,
} from "../src/modules/19-oncall/consumers/index";
import { decideRosterSyncTrigger } from "../src/modules/19-oncall/roster/index";

const ORG = "0a000000-0000-4000-8000-000000000001";
const ORG_OTHER = "0a000000-0000-4000-8000-0000000000ff";
const PE = "0b000000-0000-4000-8000-000000000002";
const LOCATION = "0c000000-0000-4000-8000-000000000003";
const PATIENT = "0d000000-0000-4000-8000-000000000004";
const ADMISSION = "0e000000-0000-4000-8000-000000000005";
const VISIT = "0f000000-0000-4000-8000-000000000006";
const SHIFT = "10000000-0000-4000-8000-000000000007";
const SHIFT_2 = "10000000-0000-4000-8000-000000000008";
const NURSE = "11000000-0000-4000-8000-000000000009";
const EVENT = "12000000-0000-4000-8000-00000000000a";
const EVENT_2 = "12000000-0000-4000-8000-00000000000b";
const EXISTING_CALL = "13000000-0000-4000-8000-00000000000c";

/** §7.6's clock: the 14:00 visit, no-show detected at 15:00. */
const AT = "2026-08-01T15:00:00.000Z";

const visit: TriggerVisitContext = {
  visitId: VISIT,
  organizationId: ORG,
  providerEntityId: PE,
  locationId: LOCATION,
  patientId: PATIENT,
  admissionId: ADMISSION,
  scheduledStartedAt: "2026-08-01T14:00:00.000Z",
  scheduledEndedAt: "2026-08-01T15:00:00.000Z",
};

function coveringShift(over: Partial<CoveringShiftCandidate> = {}): CoveringShiftCandidate {
  return {
    shiftId: SHIFT,
    providerEntityId: PE,
    status: "active",
    version: 1,
    shiftStartsAt: "2026-08-01T08:00:00.000Z",
    shiftEndsAt: "2026-08-01T20:00:00.000Z",
    discipline: "clinical_rn",
    primaryOnCallMembershipId: NURSE,
    externalActorId: null,
    openedAt: "2026-08-01T08:00:00.000Z",
    closedAt: null,
    ...over,
  };
}

function facts(over: Partial<InboundTriggerFacts> = {}): InboundTriggerFacts {
  return {
    existingCallForEventId: null,
    openMachineCallForPatientId: null,
    visit,
    candidateShifts: [coveringShift()],
    ...over,
  };
}

const noShow: M17VisitNoShowDetectedPayload = {
  visitId: VISIT,
  patientId: PATIENT,
  clinicianMembershipId: NURSE,
  scheduledStartedAt: "2026-08-01T14:00:00.000Z",
  reason: "clinician reported vehicle breakdown",
};

const lateCheckout: M18LateCheckOutDetectedPayload = {
  visitId: VISIT,
  missingResolutionId: "14000000-0000-4000-8000-00000000000d",
  hoursPastGrace: 2.5,
  hasCheckIn: true,
};

describe("M19 §4.8 — the subscribed event names are read off the frozen list", () => {
  it("both trigger names are members of M19_SUBSCRIBED_EVENT_NAMES", () => {
    const names: readonly M19SubscribedEventName[] = M19_SUBSCRIBED_EVENT_NAMES;
    expect(names).toContain(M17_NO_SHOW_DETECTED_EVENT);
    expect(names).toContain(M18_LATE_CHECK_OUT_DETECTED_EVENT);
    expect(M17_NO_SHOW_DETECTED_EVENT).toBe("m17.visit.no_show_detected");
    expect(M18_LATE_CHECK_OUT_DETECTED_EVENT).toBe("m18.evv.late_check_out_detected");
  });
});

describe("M19 §7.6 — the m17.visit.no_show_detected consumer", () => {
  it("opens a fully anchored machine call in the covering shift", () => {
    const action = decideNoShowTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: noShow,
      facts: facts(),
      at: AT,
    });
    expect(action.kind).toBe("open_call");
    if (action.kind !== "open_call") return;
    expect(action.draft).toEqual({
      organizationId: ORG,
      providerEntityId: PE,
      locationId: LOCATION,
      onCallShiftId: SHIFT,
      patientId: PATIENT,
      admissionId: ADMISSION,
      callerKind: "system_inbound",
      inboundChannel: "inbound_visit_failure",
      source: "no_show",
      sourceOutboxEventId: EVENT,
      chiefComplaintText: NO_SHOW_CHIEF_COMPLAINT,
      openedAt: AT,
    });
  });

  it("uses the VISIT's patient, not the payload's — a disagreement must not open a call about the wrong person", () => {
    const action = decideNoShowTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: { ...noShow, patientId: "99999999-0000-4000-8000-000000000000" },
      facts: facts(),
      at: AT,
    });
    expect(action.kind === "open_call" && action.draft.patientId).toBe(PATIENT);
  });

  it("never copies M17's `reason` into the §3.6-denylisted chief-complaint column", () => {
    const action = decideNoShowTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: noShow,
      facts: facts(),
      at: AT,
    });
    expect(action.kind === "open_call" && action.draft.chiefComplaintText).toBe(
      "Visit missed; check on patient.",
    );
    expect(action.kind === "open_call" && action.draft.chiefComplaintText).not.toContain("vehicle");
  });

  it("§2.6 / D10 — a redelivery of the same outbox event skips without a second write or page", () => {
    const action = decideNoShowTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: noShow,
      facts: facts({
        existingCallForEventId: EXISTING_CALL,
        openMachineCallForPatientId: EXISTING_CALL,
      }),
      at: AT,
    });
    // The event-id check runs FIRST: a redelivery of the very call that is open reports as the redelivery
    // it is, not as a coalesce into itself.
    expect(action).toEqual({ kind: "idempotent_skip", triageCallId: EXISTING_CALL });
  });

  it("dead-letters when the visit will not resolve — no row anchored to a guessed tenancy", () => {
    try {
      decideNoShowTrigger({
        organizationId: ORG,
        sourceOutboxEventId: EVENT,
        payload: noShow,
        facts: facts({ visit: null }),
        at: AT,
      });
      expect.unreachable("opened a call with no tenancy anchor");
    } catch (error) {
      expect((error as { code: string }).code).toBe("TRIGGER_VISIT_UNRESOLVED");
    }
  });

  it("refuses a visit belonging to another organization", () => {
    try {
      decideNoShowTrigger({
        organizationId: ORG_OTHER,
        sourceOutboxEventId: EVENT,
        payload: noShow,
        facts: facts(),
        at: AT,
      });
      expect.unreachable("opened a cross-tenant call");
    } catch (error) {
      expect((error as { code: string }).code).toBe("TRIGGER_ORG_MISMATCH");
    }
  });
});

describe("M19 D10 — no covering shift is reported as a coverage gap, not dropped into a DLQ", () => {
  it("§7.6's own scenario: a 15:00 no-show at an agency that only staffs nights", () => {
    const nightShift = coveringShift({
      status: "scheduled",
      shiftStartsAt: "2026-08-01T23:00:00.000Z",
      shiftEndsAt: "2026-08-02T07:00:00.000Z",
      openedAt: null,
    });
    const action = decideNoShowTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: noShow,
      facts: facts({ candidateShifts: [nightShift] }),
      at: AT,
    });
    expect(action).toEqual({
      kind: "no_coverage",
      gap: {
        organizationId: ORG,
        providerEntityId: PE,
        gapStartsAt: AT,
        // Runs to the next scheduled shift rather than being zero-length.
        gapEndsAt: "2026-08-01T23:00:00.000Z",
        discipline: "clinical_rn",
      },
    });
  });

  it("with nothing scheduled at all the gap runs to the end of §4.8's 24-hour lookahead", () => {
    expect(resolveGapWindow([], AT)).toEqual({
      gapStartsAt: AT,
      gapEndsAt: "2026-08-02T15:00:00.000Z",
    });
  });

  it("prefers an `active` shift over a `scheduled` one, then the earliest start", () => {
    const scheduled = coveringShift({ shiftId: SHIFT_2, status: "scheduled", openedAt: null });
    const active = coveringShift({ shiftId: SHIFT, status: "active" });
    expect(resolveCoveringShift([scheduled, active], AT)?.shiftId).toBe(SHIFT);
    expect(resolveCoveringShift([], AT)).toBeNull();
  });
});

describe("M19 §4.8 — the m18.evv.late_check_out_detected consumer", () => {
  it("opens a welfare-check call anchored entirely by the visit read-back", () => {
    // The payload carries no organization, no provider entity and no patient at all.
    const action = decideLateCheckoutTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: lateCheckout,
      facts: facts(),
      at: AT,
    });
    expect(action.kind).toBe("open_call");
    if (action.kind !== "open_call") return;
    expect(action.draft.source).toBe("late_checkout");
    expect(action.draft.inboundChannel).toBe("inbound_evv_anomaly");
    expect(action.draft.patientId).toBe(PATIENT);
    expect(action.draft.providerEntityId).toBe(PE);
    expect(action.draft.chiefComplaintText).toBe(LATE_CHECKOUT_CHIEF_COMPLAINT);
  });

  it("does not interpolate hoursPastGrace — a complaint line that ages is wrong within the hour", () => {
    const action = decideLateCheckoutTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: { ...lateCheckout, hoursPastGrace: 9.75 },
      facts: facts(),
      at: AT,
    });
    expect(action.kind === "open_call" && action.draft.chiefComplaintText).not.toContain("9.75");
  });

  it("`hasCheckIn: false` takes the SAME path — the coalesce, not a branch, handles the M17 overlap", () => {
    const withCheckIn = decideLateCheckoutTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: { ...lateCheckout, hasCheckIn: true },
      facts: facts(),
      at: AT,
    });
    const without = decideLateCheckoutTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: { ...lateCheckout, hasCheckIn: false },
      facts: facts(),
      at: AT,
    });
    expect(without).toEqual(withCheckIn);
  });
});

describe("M19 D10 — two different events about one patient coalesce into one call", () => {
  it("the second trigger reports where it went instead of opening a second call", () => {
    // M17's no-show and M18's late-checkout can both fire for one visit; the `source_outbox_event_id`
    // dedupe cannot see it (two distinct event ids), so the grain is the patient.
    const action = decideLateCheckoutTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT_2,
      payload: lateCheckout,
      facts: facts({ openMachineCallForPatientId: EXISTING_CALL }),
      at: AT,
    });
    expect(action).toEqual({ kind: "coalesced", intoTriageCallId: EXISTING_CALL });
  });

  it("coalescing is symmetric — whichever module noticed first owns the call", () => {
    const fromNoShow = decideNoShowTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT_2,
      payload: noShow,
      facts: facts({ openMachineCallForPatientId: EXISTING_CALL }),
      at: AT,
    });
    expect(fromNoShow).toEqual({ kind: "coalesced", intoTriageCallId: EXISTING_CALL });
  });
});

describe("M19 §4.5 — the m17.visit.assigned debounce trigger", () => {
  it("keys the debounce on the ORG, so an assignment burst collapses to one reconciliation", () => {
    const a = decideRosterSyncTrigger(
      ORG,
      {
        visitId: VISIT,
        assignedMembershipId: NURSE,
        patientId: PATIENT,
        scheduledStartedAt: "2026-08-01T14:00:00.000Z",
        scheduledEndedAt: "2026-08-01T15:00:00.000Z",
      },
      AT,
    );
    const b = decideRosterSyncTrigger(
      ORG,
      {
        visitId: "99999999-0000-4000-8000-000000000000",
        assignedMembershipId: "88888888-0000-4000-8000-000000000000",
        patientId: PATIENT,
        scheduledStartedAt: "2026-08-01T16:00:00.000Z",
        scheduledEndedAt: "2026-08-01T17:00:00.000Z",
      },
      AT,
    );
    expect(a.debounceKey).toBe(b.debounceKey);
    expect(a.debounceKey).toContain(ORG);
    expect(
      decideRosterSyncTrigger(
        ORG_OTHER,
        {
          visitId: VISIT,
          assignedMembershipId: NURSE,
          patientId: PATIENT,
          scheduledStartedAt: "2026-08-01T14:00:00.000Z",
          scheduledEndedAt: "2026-08-01T15:00:00.000Z",
        },
        AT,
      ).debounceKey,
    ).not.toBe(a.debounceKey);
  });
});

describe("M19 §4.4 — the M17 VisitReader read-back", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  const dto: VisitDto = {
    id: VISIT,
    organizationId: ORG,
    providerEntityId: PE,
    locationId: LOCATION,
    patientId: PATIENT,
    admissionId: ADMISSION,
    patientAddressId: null,
    externalFacilityId: null,
    assignedMembershipId: NURSE,
    assignedDisciplineAtAssignment: "rn",
    visitPurpose: "routine_visit",
    visitSetting: "patient_home",
    scheduledStartedAt: "2026-08-01T14:00:00.000Z",
    scheduledEndedAt: "2026-08-01T15:00:00.000Z",
    serviceDate: "2026-08-01",
    actualStartedAt: null,
    actualEndedAt: null,
    status: "no_show",
    evvBracketState: null,
    encounterId: null,
  };

  function bindVisitReader(impl: Partial<VisitReader> = {}): void {
    registerSeam("VisitReader", {
      visitForEncounter: async () => dto,
      visitsScheduledForMembershipOnDate: async () => [],
      completedVisitsForPatientSince: async () => [],
      ...impl,
    } satisfies VisitReader);
  }

  it("narrows the VisitDto to exactly the columns a triage_call needs", async () => {
    bindVisitReader();
    expect(await readTriggerVisit(ORG, VISIT)).toEqual(visit);
  });

  it("an erroring seam and a missing visit are indistinguishable — both resolve to null", async () => {
    // Telling a consumer which one it was would leak the existence of another tenant's visit.
    bindVisitReader({
      visitForEncounter: async () => {
        throw new Error("VisitReader is not implemented");
      },
    });
    expect(await readTriggerVisit(ORG, VISIT)).toBeNull();
    bindVisitReader({ visitForEncounter: async () => null });
    expect(await readTriggerVisit(ORG, VISIT)).toBeNull();
  });

  it("a redelivery costs no seam read at all (§2.6)", async () => {
    let reads = 0;
    bindVisitReader({
      visitForEncounter: async () => {
        reads += 1;
        return dto;
      },
    });
    const resolved = await resolveInboundTriggerFacts({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      visitId: VISIT,
      at: AT,
      ports: {
        findCallBySourceEvent: async () => EXISTING_CALL,
        findOpenMachineCallForPatient: async () => null,
        candidateShiftsForProviderEntity: async () => [coveringShift()],
      },
    });
    expect(resolved.existingCallForEventId).toBe(EXISTING_CALL);
    expect(reads).toBe(0);
  });

  it("a coalesce costs no shift read — no row is written, so no shift is needed", async () => {
    let shiftReads = 0;
    bindVisitReader();
    const resolved = await resolveInboundTriggerFacts({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      visitId: VISIT,
      at: AT,
      ports: {
        findCallBySourceEvent: async () => null,
        findOpenMachineCallForPatient: async () => EXISTING_CALL,
        candidateShiftsForProviderEntity: async () => {
          shiftReads += 1;
          return [];
        },
      },
    });
    expect(resolved.openMachineCallForPatientId).toBe(EXISTING_CALL);
    expect(shiftReads).toBe(0);
  });

  it("end to end: an M18 payload with no patient produces a fully anchored open_call", async () => {
    bindVisitReader();
    const resolved = await resolveInboundTriggerFacts({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      visitId: lateCheckout.visitId,
      at: AT,
      ports: {
        findCallBySourceEvent: async () => null,
        findOpenMachineCallForPatient: async () => null,
        candidateShiftsForProviderEntity: async () => [coveringShift()],
      },
    });
    const action = decideLateCheckoutTrigger({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: lateCheckout,
      facts: resolved,
      at: AT,
    });
    expect(action.kind === "open_call" && action.draft.patientId).toBe(PATIENT);
    expect(action.kind === "open_call" && action.draft.onCallShiftId).toBe(SHIFT);
  });
});
