// M20 Field Safety — `errorMessage` against the REAL wire envelope.
//
// Why this file exists: the first version of `errorMessage` matched a problem+json shape
// (`{ title, detail, status }`) that the platform has never emitted. The real envelope is
// `{ error: { code, message } }` (packages/types/src/errors.ts), so every branch fell through and all
// 14 M20 screens rendered their generic fallback for every failure — a 403 naming the denying
// predicate looked exactly like a 500. `tsc` could not see it (the input is cast from `unknown`) and
// no test asserted a rendered sentence, so 15 green gates and 5,543 tests said nothing.
//
// These fixtures are therefore copied from an ACTUAL response observed against the running backend,
// not hand-written to match the implementation.
import { describe, expect, it } from "vitest";
import { errorMessage } from "../safety-api";

const FALLBACK = "Your consent settings could not be read.";

/** Verbatim from GET /api/v1/safety/consent as an administrator (Ada) on 2026-08-01. */
const REAL_403 = {
  error: {
    code: "FORBIDDEN",
    correlationId: "88099631-3b63-4fe4-8c48-b0f92c92ffe5",
    documentationUrl: "https://docs.chartwarden.app/errors/FORBIDDEN",
    message: "abac predicate 'clinician_self' denied for 'safety.consent.read_self'",
  },
};

describe("M20 errorMessage — the wire envelope, not problem+json", () => {
  it("renders the authorization sentence for a real 403, NOT the fallback", () => {
    const msg = errorMessage(REAL_403, FALLBACK);
    expect(msg).toBe("You do not hold the authority this action requires for this record.");
    expect(msg).not.toBe(FALLBACK);
  });

  it("never puts the predicate name on screen — a clinician cannot act on it", () => {
    const msg = errorMessage(REAL_403, FALLBACK);
    expect(msg).not.toContain("clinician_self");
    expect(msg).not.toContain("abac");
  });

  it("surfaces the server's own message for DOMAIN codes, which are written for humans", () => {
    expect(
      errorMessage(
        {
          error: {
            code: "IF_MATCH_REQUIRED",
            message:
              "this route requires an If-Match header carrying the row version you read (§2.5)",
            correlationId: "c",
          },
        },
        FALLBACK,
      ),
    ).toContain("If-Match");
  });

  it("distinguishes the concurrency classes from each other", () => {
    const stale = errorMessage(
      { error: { code: "STALE_LIFECYCLE_STATE", message: "", correlationId: "c" } },
      FALLBACK,
    );
    expect(stale).toContain("changed while you were working on it");
    expect(stale).not.toBe(FALLBACK);
  });

  it("keeps 404 deliberately ambiguous — absent OR out of reach", () => {
    const msg = errorMessage(
      { error: { code: "NOT_FOUND", message: "", correlationId: "c" } },
      FALLBACK,
    );
    expect(msg).toContain("does not distinguish");
  });

  it("falls back only when there is genuinely no code to read", () => {
    expect(errorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(errorMessage({}, FALLBACK)).toBe(FALLBACK);
    // The shape the old implementation believed in: it must NOT be mistaken for a real envelope.
    expect(errorMessage({ title: "x", detail: "y", status: 403 }, FALLBACK)).toBe(FALLBACK);
  });
});
