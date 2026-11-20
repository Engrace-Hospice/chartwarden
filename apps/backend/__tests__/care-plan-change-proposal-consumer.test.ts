// apps/backend/__tests__/care-plan-change-proposal-consumer.test.ts — WF09: the two M8 lifecycle bindings M7 owns for change proposals (no DB).
// What the live suite cannot cheaply say: which events each binding names (the catalog and the composition root must agree), and that a
// malformed payload is refused BEFORE any database work, so it retries into the DLQ instead of silently stranding a visit's drafts.
import type { EncounterDraftFacts, EncounterDraftReader } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  M7_ENCOUNTER_FINALIZED_EVENT,
  M7_ENCOUNTER_VOIDED_EVENT,
  buildM7EncounterFinalizedConsumer,
  buildM7EncounterVoidedConsumer,
  parseEncounterEvent,
} from "../src/modules/07-care-plan/outbox-consumers/m8-encounter-lifecycle";

const ENCOUNTER = "55555555-5555-4555-8555-555555555555";
const PATIENT = "11111111-1111-4111-8111-111111111111";

/** A database that fails the test if anything touches it. */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be reached");
    },
  },
) as never;

const event = (eventType: string, payload: unknown) => ({
  id: "66666666-6666-4666-8666-666666666666",
  organizationId: "77777777-7777-4777-8777-777777777777",
  eventType,
  aggregateKind: "encounter",
  aggregateId: ENCOUNTER,
  attemptCount: 0,
  createdAt: new Date(),
  payload,
});

describe("the bindings", () => {
  it("release on finalized and withdraw on voided, each as an m7 consumer of exactly that event", () => {
    const finalized = buildM7EncounterFinalizedConsumer({ db: untouchableDb });
    const voided = buildM7EncounterVoidedConsumer({ db: untouchableDb });
    expect(finalized).toMatchObject({
      consumerModule: "m7",
      consumerName: "m7.m8-encounter-finalized",
      eventTypes: ["m8.encounter.finalized"],
    });
    expect(voided).toMatchObject({
      consumerModule: "m7",
      consumerName: "m7.m8-encounter-voided",
      eventTypes: ["m8.encounter.voided"],
    });
    expect(M7_ENCOUNTER_FINALIZED_EVENT).toBe("m8.encounter.finalized");
    expect(M7_ENCOUNTER_VOIDED_EVENT).toBe("m8.encounter.voided");
  });

  it("have distinct dedup identities (the dispatcher keys receipts on event + consumer name)", () => {
    const names = [
      buildM7EncounterFinalizedConsumer({ db: untouchableDb }).consumerName,
      buildM7EncounterVoidedConsumer({ db: untouchableDb }).consumerName,
    ];
    expect(new Set(names).size).toBe(2);
  });
});

describe("a finalized event without a patient (emitted before the catalog required one)", () => {
  const PATIENT_OF_VISIT = "11111111-1111-4111-8111-aaaaaaaaaaaa";
  const asked: unknown[] = [];
  const visits = (facts: EncounterDraftFacts | null): EncounterDraftReader => ({
    draftOf: async (input) => {
      asked.push(input);
      return facts;
    },
  });
  const known: EncounterDraftFacts = {
    patientId: PATIENT_OF_VISIT,
    status: "finalized",
    authoredByMembershipId: "b0000000-0000-4000-8000-000000000001",
    templateStatesWounds: true,
  };
  const noPatient = event("m8.encounter.finalized", {
    encounterId: ENCOUNTER,
    vocabVersionId: "v1",
  });

  it("resolves the visit's patient through M8's seam, with the organisation of the event, and releases narrowed to it", async () => {
    asked.length = 0;
    const finalized = buildM7EncounterFinalizedConsumer({
      db: untouchableDb,
      visits: visits(known),
    });
    // It reaches the database (the release itself is proven live), having asked M8 about exactly this visit in this organisation.
    await expect(finalized.handle(noPatient)).rejects.toThrow("the database must not be reached");
    expect(asked).toEqual([{ organizationId: noPatient.organizationId, encounterId: ENCOUNTER }]);
  });

  it("does not ask M8 when the event names the patient", async () => {
    asked.length = 0;
    const finalized = buildM7EncounterFinalizedConsumer({
      db: untouchableDb,
      visits: visits(known),
    });
    await expect(
      finalized.handle(
        event("m8.encounter.finalized", { encounterId: ENCOUNTER, patientId: PATIENT }),
      ),
    ).rejects.toThrow("the database must not be reached");
    expect(asked).toEqual([]);
  });

  it("throws, releasing nothing, when M8 does not know the visit", async () => {
    const finalized = buildM7EncounterFinalizedConsumer({
      db: untouchableDb,
      visits: visits(null),
    });
    await expect(finalized.handle(noPatient)).rejects.toThrow(
      /^m7\.m8-encounter-finalized: the event names no patient and M8 does not know visit/,
    );
  });

  it("throws when M8 answers a malformed patient id, or cannot answer at all", async () => {
    const malformed = buildM7EncounterFinalizedConsumer({
      db: untouchableDb,
      visits: visits({ ...known, patientId: "pat_1" }),
    });
    await expect(malformed.handle(noPatient)).rejects.toThrow(/malformed patient id/);
    const unreadable = buildM7EncounterFinalizedConsumer({
      db: untouchableDb,
      visits: {
        draftOf: async () => {
          throw new Error("M8 unreachable");
        },
      },
    });
    await expect(unreadable.handle(noPatient)).rejects.toThrow("M8 unreachable");
  });

  it.each([
    ["a non-uuid patient", { encounterId: ENCOUNTER, patientId: "pat_1" }],
    ["a null patient", { encounterId: ENCOUNTER, patientId: null }],
  ])("still refuses %s before asking M8 anything", async (_name, payload) => {
    asked.length = 0;
    const finalized = buildM7EncounterFinalizedConsumer({
      db: untouchableDb,
      visits: visits(known),
    });
    await expect(finalized.handle(event("m8.encounter.finalized", payload))).rejects.toThrow(
      /^m7\.m8-encounter-finalized: 'patientId' must be a uuid when present/,
    );
    expect(asked).toEqual([]);
  });

  it("does not bind the voided event, which only withdraws drafts", async () => {
    const voided = buildM7EncounterVoidedConsumer({ db: untouchableDb });
    await expect(
      voided.handle(event("m8.encounter.voided", { encounterId: ENCOUNTER })),
    ).rejects.toThrow("the database must not be reached");
  });
});

describe("parseEncounterEvent", () => {
  it("reads the visit from a payload that names no patient (the voided shape, and an unnarrowed release)", () => {
    expect(
      parseEncounterEvent(
        {
          encounterId: ENCOUNTER,
          vocabVersionId: "v1",
          layer2Involved: false,
          lateEntryTier: "none",
        },
        "t",
      ),
    ).toEqual({ encounterId: ENCOUNTER });
  });

  it("narrows to the patient when the payload names one", () => {
    expect(parseEncounterEvent({ encounterId: ENCOUNTER, patientId: PATIENT }, "t")).toEqual({
      encounterId: ENCOUNTER,
      patientId: PATIENT,
    });
  });

  it.each([
    ["a non-object", "enc"],
    ["an array", []],
    ["no encounter id", { vocabVersionId: "v1" }],
    ["a non-uuid encounter id", { encounterId: "enc_1" }],
    ["a non-uuid patient id", { encounterId: ENCOUNTER, patientId: "pat_1" }],
  ])("throws on %s", (_name, payload) => {
    expect(() => parseEncounterEvent(payload, "t")).toThrow(/^t:/);
  });
});

describe("a malformed event", () => {
  it.each([
    buildM7EncounterFinalizedConsumer({ db: untouchableDb }),
    buildM7EncounterVoidedConsumer({ db: untouchableDb }),
  ])("is refused by $consumerName before any database work", async (binding) => {
    await expect(
      binding.handle(event(binding.eventTypes[0] as string, { encounterId: 7 })),
    ).rejects.toThrow(/encounterId/);
  });
});
