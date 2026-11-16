import { describe, expect, it } from "vitest";
import { failedWriteMessage, validationDetailOf } from "./hope-api";

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
