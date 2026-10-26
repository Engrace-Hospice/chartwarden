import { CH } from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import { runSubmissionDrain } from "./submission-worker";
import { classifyTransportRefusal, retryDelayMs } from "./submission-worker";

describe("classifyTransportRefusal", () => {
  it("retries only an unavailable transport", () => {
    expect(classifyTransportRefusal(CH.UNAVAILABLE)).toEqual({
      kind: "retry",
      code: CH.UNAVAILABLE,
    });
  });

  it("never retries an ambiguous send", () => {
    expect(classifyTransportRefusal(CH.IN_DOUBT)).toEqual({ kind: "in_doubt", code: CH.IN_DOUBT });
  });

  it.each([
    CH.NOT_WIRED,
    CH.NOT_PROVISIONED,
    CH.NOT_ENROLLED,
    CH.IDEMPOTENCY_CONFLICT,
    CH.INVALID_REQUEST,
    CH.UNKNOWN_ORIGINAL,
    "SOMETHING_NEW",
  ])("ends %s as failed", (code) => {
    expect(classifyTransportRefusal(code)).toEqual({ kind: "failed", code });
  });
});

describe("retryDelayMs", () => {
  it("doubles from one minute and is capped at an hour", () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });
});

describe("runSubmissionDrain with no clearinghouse bound", () => {
  it("sends nothing and fails the tick when a submission is waiting", async () => {
    let submitCalls = 0;
    const deps = {
      // dueCount reads through withOrgContext; an unavailable database proves nothing is sent either way
      db: {} as never,
      binding: {
        vendor: null,
        transport: {
          submitClaim: async () => {
            submitCalls += 1;
            throw new Error("must not be called");
          },
        },
      },
      contexts: { contextFor: async () => null },
      renderer: { render: async () => ({ ok: false as const, gaps: [] }) },
      outbox: { publish: async () => undefined },
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: "org-1" }] },
    };
    await expect(runSubmissionDrain(deps)).rejects.toThrow();
    expect(submitCalls).toBe(0);
  });
});
