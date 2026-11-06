import { ChartWardenError } from "@chartwarden/types";
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
import { M41_UNBOUND_WITH_WORK_ALERT, __resetUnboundAlertMemoryForTest } from "./unbound-alert";

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

  it("reports (one alert, no failed tick) a submission waiting with no vendor bound, and renders and sends nothing", async () => {
    waiting = 2;
    const alerts: unknown[] = [];
    await expect(
      runSubmissionDrain({
        ...deps(),
        alerts: { dispatch: async (a: unknown) => void alerts.push(a) },
      }),
    ).resolves.toEqual({ sent: 0, failures: [] });
    expect(alerts).toHaveLength(1);
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
    __resetUnboundAlertMemoryForTest(); // the once-per-window alert memory is per process: each case starts with none
  });

  // The shared cron must not fail for every tenant because ONE tenant has not finished setup: it is reported per org (one
  // alert) and the tick carries on. Which transport an org's drain uses is proven end to end in
  // submission-worker.org-isolation.test.ts, with a row that really goes out.
  it("drains the org that has a clearinghouse and REPORTS (alert, no failure) the one without, whichever comes first", async () => {
    waiting = 2;
    const alerts: { alertCode: string; organizationId: string; payload: unknown }[] = [];
    const deps = {
      ...perOrgDeps({ "org-1": "stedi" }),
      alerts: { dispatch: async (a: never) => void alerts.push(a) },
    };

    await expect(runSubmissionDrain(deps)).resolves.toEqual({ sent: 0, failures: [] });
    // org-1 got its due-list read (the drain ran for it); org-2 only the count (nothing leased).
    expect(orgsOpened).toEqual(["org-1", "org-2"]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      alertCode: M41_UNBOUND_WITH_WORK_ALERT,
      organizationId: "org-2",
      payload: { waiting: 2 },
    });
  });

  it("raises ONE alert per org per window however many ticks find the rows still waiting, and a dead alert router fails nothing", async () => {
    waiting = 3;
    const alerts: unknown[] = [];
    const deps = {
      ...perOrgDeps({}),
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: "org-quiet" }] },
      alerts: { dispatch: async (a: unknown) => void alerts.push(a) },
    };
    await runSubmissionDrain(deps);
    await runSubmissionDrain(deps);
    await runSubmissionDrain(deps);
    expect(alerts).toHaveLength(1);
    const broken = {
      ...perOrgDeps({}),
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: "org-broken" }] },
      alerts: {
        dispatch: async () => {
          throw new Error("alert router down");
        },
      },
    };
    await expect(runSubmissionDrain(broken)).resolves.toEqual({ sent: 0, failures: [] });
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

  // Re-review M4: a tenant whose credential cannot be opened, or whose config could not be read, is THAT tenant's problem. It is
  // reported per org (the same alert as an unbound org, carrying the code) and the shared tick carries on; failing the tick would
  // retry the whole job into the DLQ for every tenant, forever.
  const brokenFor = (orgId: string, fail: () => Error) => {
    const deps = perOrgDeps({ "org-2": "stedi" });
    return {
      ...deps,
      binding: {
        ...deps.binding,
        forOrg: async (organizationId: string) => {
          if (organizationId === orgId) throw fail();
          return deps.binding.forOrg(organizationId);
        },
      },
    };
  };
  const unreadable = () =>
    new ChartWardenError(
      "CLEARINGHOUSE_CREDENTIAL_UNREADABLE",
      "this organization's clearinghouse credential could not be opened; it must be entered again",
      503,
    );

  it.each([
    [
      "a stored credential that cannot be opened",
      unreadable,
      "CLEARINGHOUSE_CREDENTIAL_UNREADABLE",
    ],
    [
      "a config read that failed (a database fault)",
      () => new Error("connection reset while reading tenant_clearinghouse_config"),
      "CLEARINGHOUSE_UNAVAILABLE",
    ],
  ])(
    "REPORTS an org whose binding cannot be resolved (%s) and still drains the other: no failed tick",
    async (_label, fail, code) => {
      waiting = 2;
      const alerts: { alertCode: string; organizationId: string; payload: unknown }[] = [];
      const logs: unknown[] = [];
      const deps = {
        ...brokenFor("org-1", fail),
        alerts: { dispatch: async (a: never) => void alerts.push(a) },
        log: (e: unknown) => void logs.push(e),
      };

      await expect(runSubmissionDrain(deps)).resolves.toEqual({ sent: 0, failures: [] });

      expect(orgsOpened).toEqual(["org-1", "org-2"]); // org-1 only counted; org-2 drained
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        alertCode: M41_UNBOUND_WITH_WORK_ALERT,
        organizationId: "org-1",
        payload: { waiting: 2, code },
      });
      // nothing of the cause leaks into the log: a class and a code only
      expect(JSON.stringify(logs)).not.toContain("tenant_clearinghouse_config");
    },
  );

  it("logs the error CLASS (never the cause text) when the per-org resolver throws something untyped", async () => {
    waiting = 1;
    const logs: unknown[] = [];
    const deps = {
      ...brokenFor(
        "org-1",
        () => new TypeError("password authentication failed for chartwarden_app"),
      ),
      log: (e: unknown) => void logs.push(e),
    };
    await runSubmissionDrain(deps);
    expect(logs).toContainEqual({ event: "clearinghouse.resolve_failed", errorClass: "TypeError" });
    expect(JSON.stringify(logs)).not.toContain("password");
  });

  it("labels a failed org with its error CODE, so a tick failure says what failed", async () => {
    const deps = brokenFor(
      "org-1",
      () => new ChartWardenError("CLEARINGHOUSE_SOMETHING_NEW", "another typed refusal", 503),
    );
    await expect(runSubmissionDrain(deps)).rejects.toThrow(
      /^commercial submission drain failed: org org-1: CLEARINGHOUSE_SOMETHING_NEW$/,
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
