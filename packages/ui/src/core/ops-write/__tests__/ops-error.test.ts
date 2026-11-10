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

  it("a 409 STALE_VERSION (the route kit's stale If-Match, e.g. the MAC credential save) is a conflict, not a refusal", () => {
    const failure = describeOpsError(envelope("STALE_VERSION", "the record changed"), {
      status: 409,
    });
    expect(failure.kind).toBe("conflict");
  });

  it.each([
    "ONBOARDING_TASK_CHANGED",
    "PRICING_PLAN_CHANGED",
    "NOTICE_FILING_RECORD_CHANGED",
    "NOTICE_NOT_FILED_EXTERNALLY",
    "CLEARINGHOUSE_BAA_CHANGED",
    "CLEARINGHOUSE_CHANGED_DURING_VERIFY",
    "TENANT_STATUS_CHANGED",
  ])(
    "a 409 %s says the record moved under the operator: a conflict (re-read, ask again)",
    (code) => {
      expect(describeOpsError(envelope(code, "changed"), { status: 409 }).kind).toBe("conflict");
    },
  );

  it("a 409 with no envelope cannot be told from a stale pin, so it stays a conflict", () => {
    expect(describeOpsError(undefined, { status: 409 }).kind).toBe("conflict");
    expect(describeOpsError("<html>conflict</html>", { status: 409 }).kind).toBe("conflict");
  });

  // The clearinghouse PUT answers 409 for business refusals too. The operator's typed form and credential must survive them: only a
  // stale pin is worth throwing the form away for.
  it.each([
    "CLEARINGHOUSE_ACCOUNT_IN_USE",
    "CLEARINGHOUSE_VENDOR_LOCKED",
    "CLEARINGHOUSE_WORK_WAITING",
    "CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR",
    "GO_LIVE_SAME_PERSON",
  ])(
    "a coded 409 refusal (%s) is `refused`, not a conflict, and keeps the server's sentence",
    (code) => {
      const failure = describeOpsError(envelope(code, "the server's own sentence"), {
        status: 409,
      });
      expect(failure.kind).toBe("refused");
      expect(failure.code).toBe(code);
      expect(failure.message).toBe("the server's own sentence");
    },
  );

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

  it("a 413 with no envelope (a proxy's HTML page) reads as PAYLOAD_TOO_LARGE so the caller's copy can explain it", () => {
    const failure = describeOpsError(
      "<html>413 Request Entity Too Large</html>",
      { status: 413 },
      {
        PAYLOAD_TOO_LARGE: "too big",
      },
    );
    expect(failure.code).toBe("PAYLOAD_TOO_LARGE");
    expect(failure.message).toBe("too big");
    // the server's own 413 code wins when there is an envelope
    expect(describeOpsError(envelope("BAA_UPLOAD_TOO_LARGE", "x"), { status: 413 }).code).toBe(
      "BAA_UPLOAD_TOO_LARGE",
    );
  });
});

describe("describeOpsError and the stuck-key 409", () => {
  it("tells the operator to check the record, in its own words, not the server's header jargon", () => {
    const failure = describeOpsError(
      envelope(
        "IDEMPOTENCY_KEY_STUCK",
        "The first request with this Idempotency-Key did not finish and its outcome is unknown. Do not retry with this key: read the resource to see whether the change was applied, and use a new key only if it was not.",
      ),
      { status: 409 },
    );

    expect(failure.kind).toBe("refused"); // keep the form: nothing was stale
    expect(failure.message).toBe(
      "We could not confirm whether that change was saved. Check the record before trying again.",
    );
    expect(failure.message).not.toContain("Idempotency-Key");
  });

  it("lets a screen's own sentence for the code win", () => {
    const failure = describeOpsError(
      envelope("IDEMPOTENCY_KEY_STUCK", "m"),
      { status: 409 },
      { IDEMPOTENCY_KEY_STUCK: "Open the plan to see whether it saved." },
    );

    expect(failure.message).toBe("Open the plan to see whether it saved.");
  });
});

describe("describeOpsError and the in-flight duplicate 409", () => {
  const IN_FLIGHT_SENTENCE = "Idempotency-Key request is still being processed";

  it.each([
    ["the IDEMPOTENCY_IN_FLIGHT code", envelope("IDEMPOTENCY_IN_FLIGHT", IN_FLIGHT_SENTENCE)],
    ["the plain CONFLICT an older server sends", envelope("CONFLICT", IN_FLIGHT_SENTENCE)],
  ])("says it in the operator's words, not the server's header jargon (%s)", (_label, body) => {
    const failure = describeOpsError(body, { status: 409 });

    expect(failure.kind).toBe("refused"); // keep the form: nothing was stale
    expect(failure.message).not.toContain("Idempotency-Key");
    expect(failure.message).toMatch(/still being saved/);
  });

  it("leaves an ordinary 409 CONFLICT sentence alone", () => {
    const failure = describeOpsError(envelope("CONFLICT", "That plan is already published"), {
      status: 409,
    });

    expect(failure.message).toBe("That plan is already published");
  });

  it("lets a screen's own sentence for the code win", () => {
    const failure = describeOpsError(
      envelope("IDEMPOTENCY_IN_FLIGHT", IN_FLIGHT_SENTENCE),
      { status: 409 },
      { IDEMPOTENCY_IN_FLIGHT: "Saving this plan. Give it a moment." },
    );

    expect(failure.message).toBe("Saving this plan. Give it a moment.");
  });
});
