import { describe, expect, it } from "vitest";
import { failedResultOutcomeUnknown } from "./hope-api";

// `failedResultOutcomeUnknown` is `writeOutcomeUnknown` for the `{ ok: false }` result a write helper returns (it kept the reply's
// status and code only): a screen re-reads what it tells the clinician to check exactly when the write may have been applied.

const failed = (status: number | null, code: string | null) => ({
  ok: false as const,
  status,
  code,
  message: "words",
});

describe("failedResultOutcomeUnknown", () => {
  it.each([
    ["an empty 502", failed(502, null)],
    ["a 500 with an error body", failed(500, "INTERNAL")],
    ["a reply with no status", failed(null, null)],
    ["an empty 200 with no data", failed(200, null)],
  ])("is true for %s: the write may have been applied", (_name, result) => {
    expect(failedResultOutcomeUnknown(result)).toBe(true);
  });

  it.each([
    ["a 422 refusal", failed(422, "M10_SPEC_NOT_IN_FORCE")],
    ["a 409 conflict", failed(409, "M10_VERSION_CONFLICT")],
    ["a busy record", failed(409, "M10_RECORD_BUSY")],
    ["an empty 4xx", failed(403, null)],
    ["a degraded dependency (worded as 'try again')", failed(503, "DEGRADED")],
  ])("is false for %s: it was answered", (_name, result) => {
    expect(failedResultOutcomeUnknown(result)).toBe(false);
  });
});
