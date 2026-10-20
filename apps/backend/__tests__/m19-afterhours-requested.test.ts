// ADR-0082 decision 4 / slice S2 — the pure decider behind M19's `m36.afterhours_triage.requested` consumer.
import { Value } from "@sinclair/typebox/value";
import type { OrgId, PatientId, ProviderEntityId, TriageCallId } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import type { CoveringShiftCandidate } from "../src/modules/19-oncall/consumers/inbound-trigger";
import {
  AFTERHOURS_CALL_CHANNEL,
  AFTERHOURS_CALL_SOURCE,
  AFTERHOURS_CHIEF_COMPLAINT,
  type AfterHoursFacts,
  type AfterHoursReads,
  decideAfterHoursRequested,
  parseAfterHoursRequested,
  resolveAfterHoursFacts,
} from "../src/modules/19-oncall/consumers/m36-afterhours-requested";
import type { InboundTriggerPorts } from "../src/modules/19-oncall/consumers/trigger-context";
import { M19_OUTBOX_EVENTS } from "../src/modules/19-oncall/index";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/index";

const ORG = "0a000000-0000-4000-8000-000000000001" as OrgId;
const PE = "0b000000-0000-4000-8000-000000000002" as ProviderEntityId;
const PATIENT = "0d000000-0000-4000-8000-000000000004" as PatientId;
const EVENT = "12000000-0000-4000-8000-00000000000a";
const SHIFT = "10000000-0000-4000-8000-000000000007";
const EXISTING = "13000000-0000-4000-8000-00000000000c" as TriageCallId;
const OPEN = "13000000-0000-4000-8000-00000000000d" as TriageCallId;
const AT = "2026-08-01T15:00:00.000Z";

const payload = {
  messageId: "20000000-0000-4000-8000-000000000001",
  requestId: "20000000-0000-4000-8000-000000000002",
  patientId: PATIENT,
  occurredAt: AT,
};

const shift = (over: Partial<CoveringShiftCandidate> = {}): CoveringShiftCandidate =>
  ({
    shiftId: SHIFT,
    providerEntityId: PE,
    status: "active",
    version: 1,
    shiftStartsAt: "2026-08-01T08:00:00.000Z",
    shiftEndsAt: "2026-08-01T20:00:00.000Z",
    discipline: "clinical_rn",
    primaryOnCallMembershipId: "11000000-0000-4000-8000-000000000009",
    externalActorId: null,
    openedAt: "2026-08-01T08:00:00.000Z",
    closedAt: null,
    ...over,
  }) as CoveringShiftCandidate;

const facts = (over: Partial<AfterHoursFacts> = {}): AfterHoursFacts => ({
  existingCallForEventId: null,
  outcomeAlreadyPublished: false,
  patient: { providerEntityId: PE },
  openMachineCallForPatientId: null,
  candidateShifts: [shift()],
  ...over,
});

const decide = (f: AfterHoursFacts) =>
  decideAfterHoursRequested({
    organizationId: ORG,
    sourceOutboxEventId: EVENT,
    payload: parseAfterHoursRequested(payload),
    facts: f,
    at: AT as never,
  });

describe("the frozen contracts agree with the catalog", () => {
  const entry = (list: typeof M36_OUTBOX_EVENTS, name: string) =>
    list.find((e) => e.eventName === name);

  it("M36's request payload (S1) is exactly what the parser reads", () => {
    const requested = entry(M36_OUTBOX_EVENTS, "m36.afterhours_triage.requested");
    expect(requested?.declaredConsumers).toContain("m19");
    expect(Value.Check(requested?.payloadSchema as never, payload)).toBe(true);
    expect(() => parseAfterHoursRequested(payload)).not.toThrow();
  });

  it("M19's outcome payload validates for all three outcomes and refuses extras", () => {
    const outcome = entry(M19_OUTBOX_EVENTS, "m19.afterhours_triage.outcome");
    expect(outcome?.declaredConsumers).toEqual(["m36"]);
    const schema = outcome?.payloadSchema as never;
    const base = { sourceOutboxEventId: EVENT, triageCallId: OPEN };
    expect(Value.Check(schema, { ...base, outcome: "opened" })).toBe(true);
    expect(Value.Check(schema, { ...base, outcome: "coalesced" })).toBe(true);
    expect(Value.Check(schema, { ...base, triageCallId: null, outcome: "no_coverage" })).toBe(true);
    expect(Value.Check(schema, { ...base, outcome: "refused" })).toBe(false);
    expect(Value.Check(schema, { ...base, outcome: "opened", body: "text" })).toBe(false);
    expect(Value.Check(schema, { ...base, triageCallId: "not-a-uuid", outcome: "opened" })).toBe(
      false,
    );
  });
});

describe("parseAfterHoursRequested", () => {
  it("keeps only the three id fields, whatever else the payload carries", () => {
    const parsed = parseAfterHoursRequested({ ...payload, body: "patient is in pain" });
    expect(Object.keys(parsed).sort()).toEqual(["messageId", "patientId", "requestId"]);
  });

  it.each(["messageId", "requestId", "patientId"])("rejects a missing or non-uuid %s", (key) => {
    expect(() => parseAfterHoursRequested({ ...payload, [key]: undefined })).toThrow();
    expect(() => parseAfterHoursRequested({ ...payload, [key]: "not-a-uuid" })).toThrow();
  });
});

describe("decideAfterHoursRequested", () => {
  it("skips a redelivery of an event that already opened a call", () => {
    expect(decide(facts({ existingCallForEventId: EXISTING }))).toEqual({
      kind: "idempotent_skip",
      triageCallId: EXISTING,
    });
  });

  it("skips a redelivery whose outcome was already published (coalesced / no_coverage arms)", () => {
    expect(
      decide(facts({ outcomeAlreadyPublished: true, openMachineCallForPatientId: OPEN })),
    ).toEqual({
      kind: "idempotent_skip",
      triageCallId: null,
    });
    expect(decide(facts({ outcomeAlreadyPublished: true, candidateShifts: [] })).kind).toBe(
      "idempotent_skip",
    );
  });

  it("skips before it even looks at the patient (a redelivery never re-checks tenancy)", () => {
    expect(decide(facts({ existingCallForEventId: EXISTING, patient: null })).kind).toBe(
      "idempotent_skip",
    );
  });

  it("coalesces onto an open machine-opened call for the patient", () => {
    expect(decide(facts({ openMachineCallForPatientId: OPEN }))).toEqual({
      kind: "coalesced",
      intoTriageCallId: OPEN,
    });
  });

  it("opens a patient-attached system_inbound call with platform words only", () => {
    const action = decide(facts());
    expect(action.kind).toBe("open_call");
    if (action.kind !== "open_call") return;
    expect(action.draft).toEqual({
      organizationId: ORG,
      providerEntityId: PE,
      locationId: null,
      onCallShiftId: SHIFT,
      patientId: PATIENT,
      admissionId: null,
      callerKind: "system_inbound",
      inboundChannel: AFTERHOURS_CALL_CHANNEL,
      source: AFTERHOURS_CALL_SOURCE,
      sourceOutboxEventId: EVENT,
      chiefComplaintText: AFTERHOURS_CHIEF_COMPLAINT,
      openedAt: AT,
    });
  });

  it("never carries message text, whatever the payload held", () => {
    const parsed = parseAfterHoursRequested({
      ...payload,
      body: "SECRET-CLINICAL-TEXT",
      text: "SECRET-CLINICAL-TEXT",
    });
    const action = decideAfterHoursRequested({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: parsed,
      facts: facts(),
      at: AT as never,
    });
    expect(JSON.stringify(action)).not.toContain("SECRET-CLINICAL-TEXT");
  });

  it("reports no coverage (and a gap window) when no shift covers the instant", () => {
    const action = decide(facts({ candidateShifts: [] }));
    expect(action.kind).toBe("no_coverage");
    if (action.kind !== "no_coverage") return;
    expect(action.gap).toMatchObject({
      organizationId: ORG,
      providerEntityId: PE,
      gapStartsAt: AT,
      discipline: "clinical_rn",
    });
  });

  it("treats a shift that has ended as no coverage", () => {
    expect(
      decide(facts({ candidateShifts: [shift({ shiftEndsAt: "2026-08-01T14:00:00.000Z" })] })).kind,
    ).toBe("no_coverage");
  });

  it("refuses a patient that does not resolve in the organization (cross-org or unknown)", () => {
    expect(() => decide(facts({ patient: null }))).toThrow(
      expect.objectContaining({ code: "AFTERHOURS_PATIENT_NOT_IN_ORG" }),
    );
  });

  it("answers no_coverage with NO gap event for a patient with no resolvable provider entity", () => {
    expect(decide(facts({ patient: { providerEntityId: null } }))).toEqual({
      kind: "no_coverage",
      gap: null,
    });
  });
});

describe("resolveAfterHoursFacts", () => {
  const calls: string[] = [];
  const ports = (over: Partial<InboundTriggerPorts> = {}): InboundTriggerPorts => ({
    findCallBySourceEvent: async () => {
      calls.push("findCallBySourceEvent");
      return null;
    },
    findOpenMachineCallForPatient: async () => {
      calls.push("findOpenMachineCallForPatient");
      return null;
    },
    candidateShiftsForProviderEntity: async () => {
      calls.push("candidateShifts");
      return [shift()];
    },
    ...over,
  });
  const reads = (over: Partial<AfterHoursReads> = {}): AfterHoursReads => ({
    patientProviderEntity: async () => {
      calls.push("patientProviderEntity");
      return { providerEntityId: PE };
    },
    providerEntityIdsOfOrg: async () => [],
    ...over,
  });
  const run = (p: InboundTriggerPorts, r: AfterHoursReads) => {
    calls.length = 0;
    return resolveAfterHoursFacts({
      organizationId: ORG,
      sourceOutboxEventId: EVENT,
      payload: parseAfterHoursRequested(payload),
      at: AT as never,
      ports: p,
      reads: r,
      outcomeAlreadyPublished: async () => {
        calls.push("outcomeAlreadyPublished");
        return answered;
      },
    });
  };
  let answered = false;

  it("an already-answered event stops after the dedupe and outcome reads", async () => {
    answered = true;
    const f = await run(ports(), reads());
    answered = false;
    expect(f.outcomeAlreadyPublished).toBe(true);
    expect(calls).toEqual(["findCallBySourceEvent", "outcomeAlreadyPublished"]);
  });

  it("a redelivery costs only the dedupe read", async () => {
    const f = await run(ports({ findCallBySourceEvent: async () => EXISTING }), reads());
    expect(f.existingCallForEventId).toBe(EXISTING);
    expect(calls).toEqual([]);
  });

  it("a patient that is not in the org stops before the coalesce and shift reads", async () => {
    const f = await run(ports(), reads({ patientProviderEntity: async () => null }));
    expect(f.patient).toBeNull();
    expect(calls).toEqual(["findCallBySourceEvent", "outcomeAlreadyPublished"]);
  });

  it("falls back to the org's only provider entity when the patient has none", async () => {
    const f = await run(
      ports(),
      reads({
        patientProviderEntity: async () => ({ providerEntityId: null }),
        providerEntityIdsOfOrg: async () => [PE],
      }),
    );
    expect(f.patient).toEqual({ providerEntityId: PE });
  });

  it("does not guess among several provider entities", async () => {
    const f = await run(
      ports(),
      reads({
        patientProviderEntity: async () => ({ providerEntityId: null }),
        providerEntityIdsOfOrg: async () => [PE, "0b000000-0000-4000-8000-0000000000aa"],
      }),
    );
    expect(f.patient).toEqual({ providerEntityId: null });
  });

  it("a coalesce short-circuits the shift read", async () => {
    const f = await run(ports({ findOpenMachineCallForPatient: async () => OPEN }), reads());
    expect(f.openMachineCallForPatientId).toBe(OPEN);
    expect(calls).not.toContain("candidateShifts");
  });
});
