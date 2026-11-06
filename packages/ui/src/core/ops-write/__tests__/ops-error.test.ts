// What an operator is told when a platform write is refused. Each refusal the console meets has one meaning and one next step:
// re-verify, re-read, fix a field, finish an earlier step, or try again. Nothing is retried for the operator.
import { describe, expect, it } from "vitest";
import { describeOpsError } from "../ops-error";

const envelope = (
  code: string,
  message: string,
  details?: Array<{ field: string; code: string; message: string }>,
  correlationId = "corr-1",
) => ({ error: { code, message, correlationId, ...(details ? { details } : {}) } });

describe("describeOpsError", () => {
  it("a stale step-up is its own kind: the screen offers Re-verify", () => {
    const failure = describeOpsError(envelope("STEP_UP_REQUIRED", "policy text"), { status: 403 });
    expect(failure.kind).toBe("step-up");
    // the server's policy text is withheld
    expect(failure.message).not.toContain("policy text");
  });

  it("a 428 names the missing precondition and carries the current record when the server gives it", () => {
    const failure = describeOpsError(
      envelope("IF_MATCH_REQUIRED", "an If-Match header is required", [
        {
          field: "currentRecordedAt",
          code: "IF_MATCH_REQUIRED",
          message: "2026-11-11T09:00:00.000Z",
        },
      ]),
      { status: 428 },
    );
    expect(failure.kind).toBe("precondition");
    expect(failure.current).toEqual({ recordedAt: "2026-11-11T09:00:00.000Z" });
  });

  it("a record that changed (409) carries the current recordedAt so the operator can review it", () => {
    const failure = describeOpsError(
      envelope("NOTICE_FILING_RECORD_CHANGED", "the record changed", [
        { field: "currentRecordedAt", code: "X", message: "2026-11-12T10:30:00.000Z" },
      ]),
      { status: 409 },
    );
    expect(failure.kind).toBe("conflict");
    expect(failure.current?.recordedAt).toBe("2026-11-12T10:30:00.000Z");
  });

  it("a 409 without details is a plain conflict that keeps the server's own sentence", () => {
    const failure = describeOpsError(
      envelope("CLEARINGHOUSE_BAA_CHANGED", "the BAA record changed since it was read"),
      { status: 409 },
    );
    expect(failure.kind).toBe("conflict");
    expect(failure.current).toBeNull();
    expect(failure.message).toBe("the BAA record changed since it was read");
  });

  it("a version conflict (412) is a conflict too", () => {
    expect(
      describeOpsError(envelope("VERSION_CONFLICT", "stale version"), { status: 412 }).kind,
    ).toBe("conflict");
  });

  it("an out-of-order step is 'locked' and names the step to finish first", () => {
    const failure = describeOpsError(
      envelope("ONBOARDING_STEP_OUT_OF_ORDER", "an earlier onboarding step is not finished yet", [
        {
          field: "templateKey",
          code: "baa_executed",
          message: "BAA must be done or skipped first",
        },
      ]),
      { status: 409 },
    );
    expect(failure.kind).toBe("locked");
    expect(failure.blockedBy).toBe("baa_executed");
  });

  it("a validation refusal maps each detail to its field", () => {
    const failure = describeOpsError(
      envelope("VALIDATION_FAILED", "request validation failed", [
        { field: "reason", code: "INVALID", message: "reason must be 8-500 characters" },
        { field: "npi", code: "INVALID", message: "check digit" },
      ]),
      { status: 422 },
    );
    expect(failure.kind).toBe("validation");
    expect(failure.fieldErrors).toEqual({
      reason: "reason must be 8-500 characters",
      npi: "check digit",
    });
  });

  it("a 422 with a typed wizard code (PHI screen) is a validation failure carrying its field", () => {
    const failure = describeOpsError(
      envelope(
        "EVIDENCE_LOOKS_LIKE_PHI",
        "evidenceNote looks like it contains a patient identifier",
        [
          {
            field: "evidenceNote",
            code: "EVIDENCE_LOOKS_LIKE_PHI",
            message: "no patient identifiers",
          },
        ],
      ),
      { status: 422 },
    );
    expect(failure.kind).toBe("validation");
    expect(failure.fieldErrors.evidenceNote).toBe("no patient identifiers");
  });

  it("uses the caller's copy for a code before the server's sentence", () => {
    const failure = describeOpsError(
      envelope("GO_LIVE_SAME_PERSON", "server sentence"),
      { status: 409 },
      { GO_LIVE_SAME_PERSON: "A different operator must approve." },
    );
    expect(failure.message).toBe("A different operator must approve.");
    expect(failure.code).toBe("GO_LIVE_SAME_PERSON");
  });

  it("classifies the rest by status and carries the correlation id for support", () => {
    expect(describeOpsError(envelope("NOT_FOUND", "x"), { status: 404 }).kind).toBe("not-found");
    expect(describeOpsError(envelope("FORBIDDEN", "x"), { status: 403 }).kind).toBe("forbidden");
    expect(describeOpsError(envelope("UNAUTHORIZED", "x"), { status: 401 }).kind).toBe("forbidden");
    const down = describeOpsError(envelope("PLATFORM_CONTEXT_UNAVAILABLE", "x"), { status: 503 });
    expect(down.kind).toBe("unavailable");
    expect(down.correlationId).toBe("corr-1");
  });

  it("a failure with no usable body still answers (a network error, an HTML gateway page)", () => {
    expect(describeOpsError(undefined, null).kind).toBe("network");
    expect(describeOpsError("<html>bad gateway</html>", { status: 502 }).kind).toBe("unavailable");
    expect(describeOpsError({}, { status: 500 }).message).toMatch(/try again/i);
  });
});
