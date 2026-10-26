import { CH } from "@chartwarden/x12-837-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake `withOrgContext` whose transaction answers `select(...).from(...).where(...)` with the rows the test sets. It lets the unbound
// tick be asserted for real (what it counts, what it refuses, what it never calls) without a database; the SQL itself is proven by
// m41-commercial-submission.live.test.ts.
let waiting = 0;
let transactions = 0;
vi.mock("@chartwarden/tenancy", async () => {
  const actual = await vi.importActual<object>("@chartwarden/tenancy");
  return {
    ...actual,
    withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      const chain = { from: () => ({ where: () => Promise.resolve([{ n: waiting }]) }) };
      return fn({ select: () => chain });
    },
  };
});

import {
  classifyTransportRefusal,
  endingFor,
  retryDelayMs,
  runSubmissionDrain,
  transportKeyFor,
} from "./submission-worker";

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

describe("endingFor", () => {
  it("an ambiguous submission never ends failed", () => {
    expect(endingFor(true)).toBe("in_doubt");
    expect(endingFor(false)).toBe("failed");
  });
});

describe("transportKeyFor", () => {
  it("is one key per claim, so every submission row of a claim replays the same receipt", () => {
    expect(transportKeyFor("c1")).toBe("m41.claim.c1");
    expect(transportKeyFor("c1")).toBe(transportKeyFor("c1"));
    expect(transportKeyFor("c1")).not.toBe(transportKeyFor("c2"));
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
  let submitCalls = 0;
  let renderCalls = 0;
  const deps = () => ({
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
    renderer: {
      render: async () => {
        renderCalls += 1;
        return { ok: false as const, gaps: [] };
      },
    },
    outbox: { publish: async () => undefined },
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: "org-1" }] },
  });

  beforeEach(() => {
    waiting = 0;
    transactions = 0;
    submitCalls = 0;
    renderCalls = 0;
  });

  it("fails the tick with CH_NOT_WIRED when a submission is waiting, and renders and sends nothing", async () => {
    waiting = 2;
    await expect(runSubmissionDrain(deps())).rejects.toThrow(/CH_NOT_WIRED \(2 submission/);
    expect(submitCalls).toBe(0);
    expect(renderCalls).toBe(0);
    expect(transactions).toBe(1); // only the count; nothing was leased
  });

  it("is quiet when nothing is waiting", async () => {
    waiting = 0;
    await expect(runSubmissionDrain(deps())).resolves.toEqual({ sent: 0, failures: [] });
    expect(submitCalls).toBe(0);
  });
});
