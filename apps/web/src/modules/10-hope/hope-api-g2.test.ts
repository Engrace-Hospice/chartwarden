import { describe, expect, it } from "vitest";
import {
  SPEC_NOT_IN_FORCE_MESSAGE,
  failedWriteMessage,
  isStaleVersionRefusal,
  refusalWordsOf,
  writeOutcomeUnknown,
} from "./hope-api";

// Group g2: a refusal is classified by status and code, never by the wording of its message; a server text that addresses an
// integrator is not shown to a clinician; and a failed write is "unconfirmed" exactly when it may still have been applied.

const UNCONFIRMED = "Not confirmed (the caller's words).";
const FALLBACK = "The caller's fallback.";
/** The real 422 text of M10_SPEC_NOT_IN_FORCE (hope-spec-registry.ts): it contains "version" and an Idempotency-Key instruction. */
const REAL_SPEC_NOT_IN_FORCE_TEXT =
  "No HOPE spec version is in force for this record's target date. An administrator needs to load the spec version that covers it. The idempotency layer replays this 422 for 24 h on the same Idempotency-Key, so after the spec is loaded use a NEW Idempotency-Key.";

const refusal = (status: number, code: string, message: string) => ({
  data: undefined,
  error: { error: { code, message } },
  response: { ok: false, status },
});

describe("isStaleVersionRefusal", () => {
  it("is not fooled by a 422 whose message happens to contain the word version", () => {
    const reply = refusal(422, "M10_SPEC_NOT_IN_FORCE", REAL_SPEC_NOT_IN_FORCE_TEXT);

    expect(isStaleVersionRefusal(reply)).toBe(false);
  });

  it.each([
    ["a 400 that says conflict", refusal(400, "VALIDATION_FAILED", "Version conflict in the body")],
    ["a 500 that says stale", refusal(500, "INTERNAL", "stale cache")],
    ["an unanswered request", {}],
  ])("is false for %s", (_name, reply) => {
    expect(isStaleVersionRefusal(reply)).toBe(false);
  });

  it("is true for a 409 stale version, whatever its words", () => {
    expect(isStaleVersionRefusal(refusal(409, "M10_VERSION_CONFLICT", "Changed."))).toBe(true);
    expect(isStaleVersionRefusal(refusal(409, "CONFLICT", "Try again."))).toBe(true);
  });

  it("is false for a busy record: the step was not applied and the page is not stale", () => {
    expect(isStaleVersionRefusal(refusal(409, "M10_RECORD_BUSY", "The record is busy."))).toBe(
      false,
    );
  });
});

describe("the words for M10_SPEC_NOT_IN_FORCE", () => {
  const reply = refusal(422, "M10_SPEC_NOT_IN_FORCE", REAL_SPEC_NOT_IN_FORCE_TEXT);

  it("tell a clinician what to do, and keep the code for support", () => {
    const words = failedWriteMessage(reply, UNCONFIRMED, FALLBACK);

    expect(words).toBe(SPEC_NOT_IN_FORCE_MESSAGE);
    expect(words).toContain("Contact your administrator");
    expect(words).toContain("M10_SPEC_NOT_IN_FORCE");
    expect(words).not.toMatch(/idempotency/i);
  });

  it("are the same wherever a refusal is worded", () => {
    expect(refusalWordsOf(reply.error)).toBe(SPEC_NOT_IN_FORCE_MESSAGE);
  });

  it("leave every other refusal in the server's own words", () => {
    const other = refusal(409, "M10_TIMEPOINT_EXPIRED", "The window closed on 2026-09-01.");

    expect(refusalWordsOf(other.error)).toBe("The window closed on 2026-09-01.");
    expect(refusalWordsOf({ error: { code: "constructor", message: "Own words." } })).toBe(
      "Own words.",
    );
    expect(refusalWordsOf({ error: {} })).toBeNull();
    expect(refusalWordsOf(undefined)).toBeNull();
  });
});

describe("writeOutcomeUnknown", () => {
  it.each([
    ["a rejected request", {}],
    ["an empty 502", { error: undefined, response: { ok: false, status: 502 } }],
    ["an empty 200 with no data", { error: undefined, response: { ok: true, status: 200 } }],
    ["a 5xx with an error body", refusal(500, "INTERNAL", "boom")],
  ])("is true for %s: the write may have been applied", (_name, reply) => {
    expect(writeOutcomeUnknown(reply)).toBe(true);
  });

  it.each([
    ["a 4xx refusal with a reason", refusal(422, "VALIDATION_FAILED", "Bad value.")],
    ["a 409 conflict", refusal(409, "M10_VERSION_CONFLICT", "Changed.")],
    ["a busy record", refusal(409, "M10_RECORD_BUSY", "The record is busy.")],
    ["an empty 4xx", { error: undefined, response: { ok: false, status: 403 } }],
    ["a degraded dependency (worded as 'try again')", refusal(503, "DEGRADED", "seam down")],
  ])("is false for %s: it was answered", (_name, reply) => {
    expect(writeOutcomeUnknown(reply)).toBe(false);
  });

  it("agrees with the words failedWriteMessage chooses", () => {
    const replies = [
      {},
      { error: undefined, response: { ok: false, status: 502 } },
      refusal(500, "INTERNAL", "boom"),
      refusal(422, "VALIDATION_FAILED", "Bad value."),
      refusal(503, "DEGRADED", "seam down"),
    ];
    for (const reply of replies) {
      const saysUnconfirmed = failedWriteMessage(reply, UNCONFIRMED, FALLBACK) === UNCONFIRMED;
      // An unconfirmed write is worded by the caller's own sentence or by the server-fault one, never as a plain refusal.
      if (saysUnconfirmed) expect(writeOutcomeUnknown(reply)).toBe(true);
    }
  });
});
