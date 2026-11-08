// ADR-0108 repurposed (ADR-0053 amendment 2026-11-06) — the claims-billing gate decides from the tenant's clearinghouse
// choice: the REAL entitlement reader over a stub choice reader, through every gate entry point (route preHandler,
// isClaimsBillingEntitled, worker hold), in each enforcement mode, with the carve-outs that must stay open.
import type { SubscriptionWorkBlockReader, TenantClearinghouseChoice } from "@chartwarden/types";
import { DelayedError } from "bullmq";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimsBillingPreHandler,
  configureClaimsBillingGate,
  holdUnlessClaimsBillingEntitled,
  isClaimsBillingEntitled,
  withClaimsBillingGate,
} from "../src/bootstrap/claims-billing-gate";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { createClaimsBillingEntitlementReader } from "../src/modules/23-billing-medicare/tenant-clearinghouse/choice";

const ORG = "a1000000-0000-4000-8000-000000000001";
const choice = (over: Partial<TenantClearinghouseChoice>): TenantClearinghouseChoice => ({
  vendor: null,
  status: null,
  mode: null,
  source: "none",
  ...over,
});
const ACTIVE_STEDI = choice({
  vendor: "stedi",
  status: "active",
  mode: "production",
  source: "tenant",
});
const ACTIVE_CLAIMMD = choice({
  vendor: "claimmd",
  status: "active",
  mode: "test",
  source: "tenant",
});

/** The cases the owner named: stedi / claimmd with a complete config allow; outside, unconfigured and incomplete refuse. */
const REFUSED: readonly [string, TenantClearinghouseChoice, string][] = [
  [
    "outside",
    choice({ vendor: "outside", status: "active", source: "tenant" }),
    "clearinghouse_outside",
  ],
  ["nothing chosen", choice({}), "clearinghouse_not_chosen"],
  [
    "a draft config",
    choice({ vendor: "stedi", status: "draft", mode: "test", source: "tenant" }),
    "clearinghouse_not_active",
  ],
  [
    "a verified, not yet active, config",
    choice({ vendor: "claimmd", status: "verified", mode: "test", source: "tenant" }),
    "clearinghouse_not_active",
  ],
];
const ALLOWED: readonly [string, TenantClearinghouseChoice][] = [
  ["an active stedi config", ACTIVE_STEDI],
  ["an active claimmd config", ACTIVE_CLAIMMD],
  [
    "an organization served by the platform env vendor",
    choice({ vendor: "claimmd", status: "active", mode: "test", source: "platform_env" }),
  ],
];

const NOT_BLOCKED: SubscriptionWorkBlockReader = {
  blockForOrg: async () => ({ blocked: false }),
};

function bindChoice(
  answer: TenantClearinghouseChoice | Error,
  subscription: SubscriptionWorkBlockReader = NOT_BLOCKED,
): void {
  registerSeam(
    "ClaimsBillingEntitlementReader",
    createClaimsBillingEntitlementReader(
      {
        async choiceForOrg() {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
      subscription,
    ),
  );
}

async function app(exempt?: () => Promise<boolean>) {
  const server = Fastify();
  server.decorateRequest("context", null as never);
  server.addHook("onRequest", async (request) => {
    (request as unknown as { context: unknown }).context = {
      organizationId: ORG,
      userId: "u",
      roles: [],
      attributes: {},
    };
  });
  withClaimsBillingGate(
    server,
    [
      {
        cls: "new_work",
        method: "POST",
        path: "/claims/:id/submit",
        ...(exempt ? { exempt: async () => exempt() } : {}),
      },
      { cls: "open", method: "POST", path: "/notices/noe" },
    ],
    () => {
      server.post("/claims/:id/submit", { preHandler: [claimsBillingPreHandler] }, async () => ({
        ok: true,
      }));
      server.post("/notices/noe", async () => ({ ok: true }));
    },
  );
  await server.ready();
  return server;
}

afterEach(() => {
  __resetSeamsForTest();
  configureClaimsBillingGate({ mode: "shadow", log: () => {} });
});

describe("the claims-billing gate follows the clearinghouse choice", () => {
  for (const [label, answer] of ALLOWED) {
    it(`enforce: allows new claims work for ${label}`, async () => {
      configureClaimsBillingGate({ mode: "enforce", log: () => {} });
      bindChoice(answer);
      const server = await app();
      expect((await server.inject({ method: "POST", url: "/claims/c1/submit" })).statusCode).toBe(
        200,
      );
      expect(await isClaimsBillingEntitled(ORG)).toBe(true);
      await server.close();
    });
  }

  for (const [label, answer, reason] of REFUSED) {
    it(`enforce: refuses new claims work for ${label} with 402 and the reason as the detail code`, async () => {
      configureClaimsBillingGate({ mode: "enforce", log: () => {} });
      bindChoice(answer);
      const server = await app();
      const res = await server.inject({ method: "POST", url: "/claims/c1/submit" });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ code: "CLAIMS_BILLING_ADDON_REQUIRED" });
      // the plain test server has no envelope handler, so read the reason off the typed error the gate throws
      const refusal = await claimsBillingPreHandler({
        context: { organizationId: ORG },
        method: "POST",
        url: "/claims/c1/submit",
        routeOptions: { url: "/claims/:id/submit" },
      } as never).catch((e: unknown) => e as { details?: { code: string }[] });
      expect(refusal).toMatchObject({ details: [expect.objectContaining({ code: reason })] });
      expect(await isClaimsBillingEntitled(ORG)).toBe(false);
      await server.close();
    });

    it(`shadow: logs the would-deny for ${label} and lets the work through; off never asks`, async () => {
      const logged: string[] = [];
      configureClaimsBillingGate({
        mode: "shadow",
        log: (m, d) => logged.push(`${m} ${JSON.stringify(d)}`),
      });
      bindChoice(answer);
      const server = await app();
      expect((await server.inject({ method: "POST", url: "/claims/c1/submit" })).statusCode).toBe(
        200,
      );
      expect(logged.join("\n")).toContain(reason);
      expect(logged.join("\n")).not.toContain("secret");
      configureClaimsBillingGate({ mode: "off", log: () => {} });
      bindChoice(new Error("must not be read in off"));
      expect((await server.inject({ method: "POST", url: "/claims/c1/submit" })).statusCode).toBe(
        200,
      );
      expect(await isClaimsBillingEntitled(ORG)).toBe(true);
      await server.close();
    });
  }

  it("the carve-outs stay open for an outside tenant: NOE/NOTR (open routes), a void claim (exempt), in-flight work (a worker for a void)", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindChoice(choice({ vendor: "outside", status: "active", source: "tenant" }));
    let isVoid = true;
    const server = await app(async () => isVoid);
    expect((await server.inject({ method: "POST", url: "/notices/noe" })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: "/claims/void-1/submit" })).statusCode).toBe(
      200,
    );
    isVoid = false;
    expect((await server.inject({ method: "POST", url: "/claims/new-1/submit" })).statusCode).toBe(
      402,
    );
    const moves: number[] = [];
    const job = { moveToDelayed: async (ts: number) => void moves.push(ts) };
    await holdUnlessClaimsBillingEntitled(job, "tok", ORG, "claim.submit", {
      exempt: async () => true,
    });
    expect(moves).toEqual([]);
    await server.close();
  });

  it("enforce: workers HOLD (never fail) an org with no live clearinghouse, and run for one that has", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    const moves: number[] = [];
    const job = { moveToDelayed: async (ts: number) => void moves.push(ts) };
    bindChoice(choice({ vendor: "outside", status: "active", source: "tenant" }));
    await expect(
      holdUnlessClaimsBillingEntitled(job, "t", ORG, "claim.submit"),
    ).rejects.toBeInstanceOf(DelayedError);
    bindChoice(ACTIVE_STEDI);
    await holdUnlessClaimsBillingEntitled(job, "t", ORG, "claim.submit");
    expect(moves).toHaveLength(1);
  });

  it("enforce: an unreadable choice fails CLOSED (503 on a route, a hold on a worker); shadow lets it through", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindChoice(new Error("db down"));
    const server = await app();
    const res = await server.inject({ method: "POST", url: "/claims/c1/submit" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "BILLING_ENTITLEMENT_UNAVAILABLE" });
    await expect(
      holdUnlessClaimsBillingEntitled({ moveToDelayed: async () => {} }, "t", ORG, "claim.submit"),
    ).rejects.toBeInstanceOf(DelayedError);
    configureClaimsBillingGate({ mode: "shadow", log: () => {} });
    expect((await server.inject({ method: "POST", url: "/claims/c1/submit" })).statusCode).toBe(
      200,
    );
    await server.close();
  });
});

// Owner decision D1: the subscription still blocks new claims and eligibility work, regardless of the clearinghouse.
describe("a suspended, paused or canceled subscription blocks new claims work even with an active clearinghouse", () => {
  for (const reason of [
    "subscription_suspended",
    "subscription_paused",
    "subscription_canceled",
  ] as const) {
    it(`enforce: 402 with ${reason}, in every gate entry point; NOE/NOTR stay open`, async () => {
      configureClaimsBillingGate({ mode: "enforce", log: () => {} });
      bindChoice(ACTIVE_STEDI, { blockForOrg: async () => ({ blocked: true, reason }) });
      const server = await app();
      const res = await server.inject({ method: "POST", url: "/claims/c1/submit" });
      expect(res.statusCode).toBe(402);
      const refusal = await claimsBillingPreHandler({
        context: { organizationId: ORG },
        method: "POST",
        url: "/claims/c1/submit",
        routeOptions: { url: "/claims/:id/submit" },
      } as never).catch((e: unknown) => e as { details?: { code: string }[] });
      expect(refusal).toMatchObject({ details: [expect.objectContaining({ code: reason })] });
      expect(await isClaimsBillingEntitled(ORG)).toBe(false);
      // the notices and in-flight work keep running: an open route is not gated
      expect((await server.inject({ method: "POST", url: "/notices/noe" })).statusCode).toBe(200);
      await server.close();
    });
  }

  it("a worker for new claims work is HELD while the subscription is blocked, and runs when it is restored", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    let blocked = true;
    bindChoice(ACTIVE_STEDI, {
      blockForOrg: async () =>
        blocked ? { blocked: true, reason: "subscription_suspended" } : { blocked: false },
    });
    const moved: number[] = [];
    const job = { moveToDelayed: async (at: number) => void moved.push(at) };
    await expect(
      holdUnlessClaimsBillingEntitled(job, "t", ORG, "claim.submit"),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(moved).toHaveLength(1);
    blocked = false;
    await expect(
      holdUnlessClaimsBillingEntitled(job, "t", ORG, "claim.submit"),
    ).resolves.toBeUndefined();
  });
});
