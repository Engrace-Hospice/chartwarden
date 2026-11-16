import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it } from "vitest";
import {
  RECORD_NOT_AVAILABLE_MESSAGE,
  failedWriteMessage,
  refusalWordsOf,
  skipSchedule,
  validationDetailOf,
  validationFieldOf,
} from "./hope-api";

// A refusal's field detail is shown only when it adds something to the server's own message.

const UNCONFIRMED = "Not confirmed (the caller's words).";
const FALLBACK = "The caller's fallback.";
const SAME_SENTENCE = "targetDate must be a real calendar date and time with an explicit offset";

const validation = (message: string, detail: { field?: string; message: string }) => ({
  error: { code: "VALIDATION_FAILED", message, details: [detail] },
});

const refusal = (error: unknown) => ({
  data: undefined,
  error,
  response: { ok: false, status: 400 },
});

describe("the field detail of a validation refusal", () => {
  it("is not repeated when the envelope message already says it", () => {
    const body = validation(SAME_SENTENCE, { field: "targetDate", message: SAME_SENTENCE });

    expect(validationDetailOf(body)).toBeNull();
    expect(failedWriteMessage(refusal(body), UNCONFIRMED, FALLBACK)).toBe(SAME_SENTENCE);
  });

  it("is not repeated when the envelope message contains it", () => {
    const body = validation(`Rejected: ${SAME_SENTENCE}.`, { message: SAME_SENTENCE });

    expect(failedWriteMessage(refusal(body), UNCONFIRMED, FALLBACK)).toBe(
      `Rejected: ${SAME_SENTENCE}.`,
    );
  });

  it("is still appended when it names something the message does not", () => {
    const body = validation("request validation failed", {
      field: "reason",
      message: "Expected string length less or equal to 100",
    });

    expect(failedWriteMessage(refusal(body), UNCONFIRMED, FALLBACK)).toBe(
      "request validation failed (reason: Expected string length less or equal to 100)",
    );
  });

  it("is appended to the fallback when the envelope carries no message of its own", () => {
    const body = {
      error: { code: "VALIDATION_FAILED", details: [{ field: "a", message: "bad" }] },
    };

    expect(failedWriteMessage(refusal(body), UNCONFIRMED, FALLBACK)).toBe(`${FALLBACK} (a: bad)`);
  });
});

// A NOT_FOUND is the record being gone, and its server text carries the record's id: every HOPE refusal says it in one sentence.
describe("a NOT_FOUND refusal", () => {
  const notFound = {
    error: {
      code: "NOT_FOUND",
      message: "HOPE schedule cccccccc-3333-4333-8333-cccccccccccc not found not found",
    },
  };

  it("is worded for the clinician, never with the server's text or the id in it", () => {
    expect(refusalWordsOf(notFound)).toBe(RECORD_NOT_AVAILABLE_MESSAGE);
    expect(failedWriteMessage(refusal(notFound), UNCONFIRMED, FALLBACK)).toBe(
      "That HOPE record is no longer available to you.",
    );
  });

  it("leaves a different code on a 404 as the server's own words", () => {
    const other = { error: { code: "M10_SPEC_NOT_FOUND", message: "No spec for 2026-01-01." } };

    expect(refusalWordsOf(other)).toBe("No spec for 2026-01-01.");
  });
});

// A VALIDATION_FAILED refusal names the field it objected to, so a screen can answer on that field instead of in an alert.
describe("the field a validation refusal names", () => {
  it("is the first detail's field and code", () => {
    const body = {
      error: {
        code: "VALIDATION_FAILED",
        message: "request validation failed",
        details: [{ field: "reportReference", code: "INVALID", message: "Expected union value" }],
      },
    };

    expect(validationFieldOf(body)).toEqual({ field: "reportReference", code: "INVALID" });
  });

  it("rides on a failed write, so a dialog can answer on the field", async () => {
    const body = {
      error: {
        code: "VALIDATION_FAILED",
        message: "request validation failed",
        details: [{ field: "reason", code: "INVALID", message: "Expected union value" }],
      },
    };
    const client = {
      POST: async () => ({ data: undefined, error: body, response: { ok: false, status: 422 } }),
    } as unknown as ApiClient;

    const result = await skipSchedule(client, "s-1", { reasonCode: "other" });

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      invalidField: { field: "reason", code: "INVALID" },
    });
  });

  it("is absent from a failed write that named no field", async () => {
    const client = {
      POST: async () => ({
        data: undefined,
        error: { error: { code: "CONFLICT", message: "changed" } },
        response: { ok: false, status: 409 },
      }),
    } as unknown as ApiClient;

    const result = await skipSchedule(client, "s-1", { reasonCode: "other" });

    expect(result).not.toHaveProperty("invalidField");
  });

  it.each([
    ["a refusal of another code", { error: { code: "CONFLICT", details: [{ field: "a" }] } }],
    [
      "a detail with no field",
      { error: { code: "VALIDATION_FAILED", details: [{ message: "x" }] } },
    ],
    ["a detail that is not an object", { error: { code: "VALIDATION_FAILED", details: ["x"] } }],
    ["no details", { error: { code: "VALIDATION_FAILED" } }],
    ["no body", undefined],
  ])("is none for %s", (_name, body) => {
    expect(validationFieldOf(body)).toBeNull();
  });

  it("has no code when the detail carries none", () => {
    const body = {
      error: { code: "VALIDATION_FAILED", details: [{ field: "a", message: "bad" }] },
    };

    expect(validationFieldOf(body)).toEqual({ field: "a", code: null });
  });
});
