import { ChartWardenError, ValidationError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  OVERRIDE_JUSTIFICATION_MIN_LENGTH,
  requireOverrideJustification,
  signatureRequestFacts,
} from "../src/modules/10-hope/routes/hope-route-guards";
import { RecordSfvSchema, RecordTimepointSchema } from "../src/modules/10-hope/routes/hope-typebox";

const SESSION_USER = "33333333-3333-4333-8333-333333333333";

const requestWith = (context: Record<string, unknown>): FastifyRequest =>
  ({ id: "req-7", context }) as unknown as FastifyRequest;

describe("signatureRequestFacts", () => {
  it("carries the request id, correlation id, address, user agent and the session user", () => {
    const facts = signatureRequestFacts(
      requestWith({
        userId: SESSION_USER,
        correlationId: "corr-1",
        ip: "203.0.113.7",
        userAgent: "agent/1.0",
      }),
    );

    expect(facts).toEqual({
      requestId: "req-7",
      correlationId: "corr-1",
      actorUserId: SESSION_USER,
      sourceIp: "203.0.113.7",
      userAgent: "agent/1.0",
    });
  });

  it.each([
    ["the system principal's literal id", "system"],
    ["an empty id", ""],
    ["a string that merely looks like a uuid", "33333333-3333-4333-8333-33333333333"],
    ["a non-string id", 42],
  ])("passes no actorUserId for %s (the audit column is a uuid)", (_label, userId) => {
    const facts = signatureRequestFacts(requestWith({ userId, ip: "203.0.113.7" }));

    expect(facts).not.toHaveProperty("actorUserId");
    expect(facts.requestId).toBe("req-7");
  });

  it("omits what the context does not have, rather than recording empty strings", () => {
    const facts = signatureRequestFacts(requestWith({ userId: SESSION_USER, userAgent: "" }));

    expect(facts).toEqual({ requestId: "req-7", actorUserId: SESSION_USER });
  });
});

// The late-deadline override's justification is stored in the immutable critical audit event, so the guard must refuse
// a non-reason and a patient identifier, and hand the service the trimmed text.
describe("requireOverrideJustification", () => {
  const REASON = "EHR outage during the window; approved by the compliance lead";
  // Synthetic identifiers only: an SSN with area 900 is never issued, the MBI is on compliance/synthetic-identifiers.json.
  const SYNTHETIC_SSN = "900-12-3456";
  const SYNTHETIC_MBI = "1EG4TE5MK73";
  const capture = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it("returns the justification, trimmed, for an override", () => {
    const text = requireOverrideJustification({
      adminOverride: true,
      adminOverrideJustification: `  ${REASON}\n`,
    });

    expect(text).toBe(REASON);
  });

  it("keeps no text that was sent without the override flag", () => {
    expect(requireOverrideJustification({ adminOverrideJustification: REASON })).toBeUndefined();
    expect(
      requireOverrideJustification({ adminOverride: false, adminOverrideJustification: REASON }),
    ).toBeUndefined();
  });

  it.each([
    ["no text", undefined, "REQUIRED"],
    ["an empty string", "", "REQUIRED"],
    ["whitespace only", " ".repeat(OVERRIDE_JUSTIFICATION_MIN_LENGTH + 5), "REQUIRED"],
    [
      "a reason that is long only because of its padding",
      `   short reason${" ".repeat(20)}`,
      "TOO_SHORT",
    ],
  ])("refuses %s with a 422 naming the field", (_label, text, code) => {
    const err = capture(() =>
      requireOverrideJustification({ adminOverride: true, adminOverrideJustification: text }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).statusCode).toBe(422);
    expect((err as ValidationError).details).toEqual([
      expect.objectContaining({ field: "adminOverrideJustification", code }),
    ]);
  });

  it.each([
    ["an SSN", `Patient ${SYNTHETIC_SSN} was readmitted after the outage ended`, SYNTHETIC_SSN],
    ["an MBI", `Medicare number ${SYNTHETIC_MBI} was keyed late after the outage`, SYNTHETIC_MBI],
    [
      "a space-padded SSN",
      "Outage ended, then 9 0 0 1 2 3 4 5 6 was keyed in by the on-call nurse",
      "9 0 0 1 2 3 4 5 6",
    ],
  ])("refuses %s with a 422 that does not echo the text", (_label, text, secret) => {
    const err = capture(() =>
      requireOverrideJustification({ adminOverride: true, adminOverrideJustification: text }),
    );

    expect(err).toBeInstanceOf(ChartWardenError);
    expect((err as ChartWardenError).statusCode).toBe(422);
    expect((err as ChartWardenError).code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect((err as ChartWardenError).details).toEqual([
      expect.objectContaining({ field: "adminOverrideJustification" }),
    ]);
    const everything = JSON.stringify({
      message: (err as Error).message,
      details: (err as ChartWardenError).details,
    });
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(text);
  });

  it("the minimum length matches both request schemas", () => {
    for (const schema of [RecordTimepointSchema, RecordSfvSchema]) {
      expect(schema.properties.adminOverrideJustification.minLength).toBe(
        OVERRIDE_JUSTIFICATION_MIN_LENGTH,
      );
    }
  });
});
