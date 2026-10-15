// WP 3.10 - the one medication-question outbox event: catalogued, outbox-only, PHI-free, and the payload the publisher helper
// builds validates against the catalog schema (so the real catalog-validating publisher accepts it).
import { Value } from "@sinclair/typebox/value";
import { MEDICATION_QUESTION_UNROUTED_REASONS } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import {
  M36_MEDICATION_QUESTION_UNROUTED,
  medicationQuestionUnroutedPayload,
} from "../src/modules/36-messaging/medication-questions/medication-question-events";

const U = "11111111-1111-4111-8111-111111111111";
const AT = new Date("2026-10-14T12:00:00.000Z");
const facts = { orgId: U, channelId: U, messageId: U, askedByUserId: U, at: AT };
const entry = M36_OUTBOX_EVENTS.find((e) => e.eventName === M36_MEDICATION_QUESTION_UNROUTED);

describe("m36.medication_question.unrouted outbox catalog entry", () => {
  it("is owned by m36, outbox-only and declares only the m36 consumer", () => {
    expect(entry).toMatchObject({
      moduleOwner: "m36",
      isOutboxOnly: true,
      declaredConsumers: ["m36"],
    });
  });

  it.each(MEDICATION_QUESTION_UNROUTED_REASONS)(
    "the payload built for reason %s validates against the catalog schema",
    (reason) => {
      const payload = medicationQuestionUnroutedPayload({ ...facts, reason });
      expect(Value.Check(entry?.payloadSchema as never, payload)).toBe(true);
    },
  );

  it("carries no patient id and no text key, and rejects extra keys at the schema boundary", () => {
    const keys = Object.keys(
      (entry?.payloadSchema as unknown as { properties: object }).properties,
    );
    for (const forbidden of ["patientId", "patient_id", "text", "body", "medicationId"]) {
      expect(keys).not.toContain(forbidden);
    }
    const payload = { ...medicationQuestionUnroutedPayload({ ...facts, reason: "no_nurse" }) };
    expect(Value.Check(entry?.payloadSchema as never, { ...payload, patientId: U })).toBe(false);
  });

  it("rejects a reason outside the closed set", () => {
    const payload = {
      ...medicationQuestionUnroutedPayload({ ...facts, reason: "no_nurse" }),
      reason: "other",
    };
    expect(Value.Check(entry?.payloadSchema as never, payload)).toBe(false);
  });
});
