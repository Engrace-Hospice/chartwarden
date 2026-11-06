import { CH } from "@chartwarden/x12-837-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake `withOrgContext` whose transaction answers `select(...).from(...).where(...)` with the rows the test sets. It lets the unbound
// tick be asserted for real (what it counts, what it refuses, what it never calls) without a database; the SQL itself is proven by
// m41-commercial-submission.live.test.ts.
let waiting = 0;
let transactions = 0;
const orgsOpened: string[] = [];
vi.mock("@chartwarden/tenancy", async () => {
  const actual = await vi.importActual<object>("@chartwarden/tenancy");
  return {
    ...actual,
    withOrgContext: async (
      _db: unknown,
      ctx: { organizationId: string },
      fn: (tx: unknown) => Promise<unknown>,
    ) => {
      transactions += 1;
      orgsOpened.push(ctx.organizationId);
      // `where(...)` is awaited by the count and continues into `orderBy().limit()` for the due list (nothing is ever due here).
      const where = () =>
        Object.assign(Promise.resolve([{ n: waiting }]), {
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
        });
      return fn({ select: () => ({ from: () => ({ where }) }) });
    },
  };
});

import { configureClaimsBillingGate } from "../../../bootstrap/claims-billing-gate";
import { __resetSeamsForTest, registerSeam } from "../../../bootstrap/seams/registry";
import {
  classifyTransportRefusal,
  drainOrg,
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
      ambiguous: false,
    });
  });

  it("never retries an ambiguous send", () => {
    expect(classifyTransportRefusal(CH.IN_DOUBT)).toEqual({ kind: "in_doubt", code: CH.IN_DOUBT });
  });

  it("a CH_UNAVAILABLE the transport flags ambiguous (timeout, 5xx, sent-but-unrecorded) retries but marks the row ambiguous", () => {
    expect(classifyTransportRefusal(CH.UNAVAILABLE, true)).toEqual({
      kind: "retry",
      code: CH.UNAVAILABLE,
      ambiguous: true,
    });
  });

  it("a clean CH_UNAVAILABLE (refused before the request left) stays definite", () => {
    expect(classifyTransportRefusal(CH.UNAVAILABLE)).toEqual({
      kind: "retry",
      code: CH.UNAVAILABLE,
      ambiguous: false,
    });
  });

  it("any OTHER code flagged ambiguous is in_doubt, never failed", () => {
    expect(classifyTransportRefusal(CH.INVALID_REQUEST, true)).toEqual({
      kind: "in_doubt",
      code: CH.INVALID_REQUEST,
    });
  });

  it("an idempotency conflict means the transport already holds an earlier attempt: in_doubt, never failed", () => {
    expect(classifyTransportRefusal(CH.IDEMPOTENCY_CONFLICT)).toEqual({
      kind: "in_doubt",
      code: CH.IDEMPOTENCY_CONFLICT,
    });
  });

  it.each([
    CH.NOT_WIRED,
    CH.NOT_PROVISIONED,
    CH.NOT_ENROLLED,
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

describe("runSubmissionDrain with a clearinghouse per organization (ADR-0053 amendment 2026-11-06)", () => {
  const submitted: string[] = [];
  const transportOf = (vendor: string) => ({
    submitClaim: async () => {
      submitted.push(vendor);
      throw new Error("no row is due, so nothing may be sent");
    },
  });
  const perOrgDeps = (bound: Record<string, string>) => ({
    db: {} as never,
    // The platform pair is the unbound default; only forOrg says anything about an organization.
    binding: {
      vendor: null,
      transport: transportOf("platform"),
      forOrg: async (organizationId: string) => ({
        vendor: bound[organizationId] ?? null,
        transport: transportOf(bound[organizationId] ?? "unbound"),
      }),
    },
    contexts: { contextFor: async () => null },
    renderer: { render: async () => ({ ok: false as const, gaps: [] }) },
    outbox: { publish: async () => undefined },
    activeOrgs: {
      listActiveOrgs: async () => [{ organizationId: "org-1" }, { organizationId: "org-2" }],
    },
  });

  beforeEach(() => {
    waiting = 0;
    transactions = 0;
    submitted.length = 0;
    orgsOpened.length = 0;
  });

  it("drains the org that has a clearinghouse and fails only the one without, whichever comes first", async () => {
    waiting = 2;

    await expect(runSubmissionDrain(perOrgDeps({ "org-1": "stedi" }))).rejects.toThrow(
      /^commercial submission drain failed: org org-2: CH_NOT_WIRED \(2 submission\(s\) waiting\)$/,
    );
    // org-1 got its due-list read (the drain ran for it); org-2 only the count (nothing leased).
    expect(orgsOpened).toEqual(["org-1", "org-2"]);
    expect(submitted).toEqual([]);
  });

  it("drains both organizations when each has its own clearinghouse", async () => {
    await expect(
      runSubmissionDrain(perOrgDeps({ "org-1": "stedi", "org-2": "claimmd" })),
    ).resolves.toEqual({ sent: 0, failures: [] });
    expect(orgsOpened).toEqual(["org-1", "org-2"]);
  });

  it("is quiet for an organization with none while nothing is waiting for it", async () => {
    waiting = 0;
    await expect(runSubmissionDrain(perOrgDeps({}))).resolves.toEqual({ sent: 0, failures: [] });
  });

  it("fails an org whose binding cannot be resolved and still drains the other", async () => {
    const deps = perOrgDeps({ "org-2": "stedi" });
    const broken = {
      ...deps,
      binding: {
        ...deps.binding,
        forOrg: async (organizationId: string) => {
          if (organizationId === "org-1") throw new Error("config unreadable");
          return deps.binding.forOrg(organizationId);
        },
      },
    };

    await expect(runSubmissionDrain(broken)).rejects.toThrow(
      /^commercial submission drain failed: org org-1: Error$/,
    );
    expect(orgsOpened).toEqual(["org-2"]);
  });
});

describe("ADR-0108 — drainOrg holds an org without the claims-billing add-on", () => {
  it("leases nothing in enforce mode (rows stay queued), and drains as before in shadow", async () => {
    registerSeam("ClaimsBillingEntitlementReader", {
      entitlementForOrg: async () => ({ entitled: false, reason: "lapsed" }),
    });
    const deps = { db: {} as never } as never;
    try {
      configureClaimsBillingGate({ mode: "enforce", log: () => {} });
      transactions = 0;
      await expect(drainOrg(deps, "org-1")).resolves.toEqual({ sent: 0, failures: [] });
      expect(transactions).toBe(0); // not even the due-list read
      configureClaimsBillingGate({ mode: "shadow" });
      waiting = 0;
      await drainOrg(deps, "org-1").catch(() => undefined);
      expect(transactions).toBeGreaterThan(0); // shadow: the drain proceeds to list its due rows
    } finally {
      configureClaimsBillingGate({ mode: "shadow" });
      __resetSeamsForTest();
    }
  });
});
