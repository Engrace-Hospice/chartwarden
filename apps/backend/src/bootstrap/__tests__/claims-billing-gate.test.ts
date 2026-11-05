// ADR-0108 D4/D6 — the claims-billing gate's mode semantics: off ignores, shadow logs and allows, enforce refuses with
// 402 + the reason, and a failed entitlement read fails CLOSED (503) in enforce only. Boot refuses a non-off mode on
// the deny-stub.
import type { ClaimsBillingEntitlement } from "@chartwarden/types";
import { DelayedError } from "bullmq";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIMS_BILLING_HOLD_MS,
  assertClaimsBillingSeamBound,
  claimsBillingPreHandler,
  configureClaimsBillingGate,
  holdUnlessClaimsBillingEntitled,
  isClaimsBillingEntitled,
  parseClaimsBillingEnforcement,
  withClaimsBillingGate,
} from "../claims-billing-gate";
import { claimsBillingEntitlementReaderDenyStub } from "../seams/providers";
import { __resetSeamsForTest, registerSeam } from "../seams/registry";

const ORG = "a1000000-0000-4000-8000-000000000001";
let calls = 0;
function bindReader(answer: ClaimsBillingEntitlement | Error): void {
  calls = 0;
  registerSeam("ClaimsBillingEntitlementReader", {
    async entitlementForOrg() {
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
}

async function gatedApp() {
  const app = Fastify();
  app.decorateRequest("context", null as never);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { context: unknown }).context = {
      organizationId: ORG,
      userId: "u",
      roles: [],
      attributes: {},
    };
  });
  withClaimsBillingGate(app, [{ cls: "new_work", method: "POST", path: "/claims/submit" }], () => {
    app.post("/claims/submit", { preHandler: [claimsBillingPreHandler] }, async () => ({
      ok: true,
    }));
    app.post("/claims/void", async () => ({ ok: true }));
  });
  await app.ready();
  return app;
}

afterEach(() => {
  __resetSeamsForTest();
  configureClaimsBillingGate({ mode: "shadow", log: () => {} });
});

describe("parseClaimsBillingEnforcement", () => {
  it("defaults to shadow and accepts the three modes", () => {
    expect(parseClaimsBillingEnforcement({})).toBe("shadow");
    expect(parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: " Enforce " })).toBe(
      "enforce",
    );
    expect(parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: "off" })).toBe("off");
  });
  it("refuses anything else", () => {
    expect(() => parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: "on" })).toThrow(
      /CLAIMS_BILLING_ENFORCEMENT/,
    );
  });
});

describe("assertClaimsBillingSeamBound", () => {
  it("refuses shadow/enforce on the deny-stub, allows off", () => {
    registerSeam("ClaimsBillingEntitlementReader", claimsBillingEntitlementReaderDenyStub);
    expect(() => assertClaimsBillingSeamBound("shadow")).toThrow(/seam bound/);
    expect(() => assertClaimsBillingSeamBound("enforce")).toThrow(/seam bound/);
    expect(() => assertClaimsBillingSeamBound("off")).not.toThrow();
    bindReader({ entitled: true });
    expect(() => assertClaimsBillingSeamBound("enforce")).not.toThrow();
  });
});

describe("the route gate", () => {
  it("enforce: 402 CLAIMS_BILLING_ADDON_REQUIRED with the reason; open routes and entitled orgs pass", async () => {
    configureClaimsBillingGate({ mode: "enforce" });
    bindReader({ entitled: false, reason: "lapsed" });
    const app = await gatedApp();
    const denied = await app.inject({ method: "POST", url: "/claims/submit" });
    expect(denied.statusCode).toBe(402);
    expect(denied.json()).toMatchObject({ code: "CLAIMS_BILLING_ADDON_REQUIRED" });
    // two gate entries on the route (explicit + appended) still read the entitlement once per request
    expect(calls).toBe(1);
    expect((await app.inject({ method: "POST", url: "/claims/void" })).statusCode).toBe(200);
    bindReader({ entitled: true });
    expect((await app.inject({ method: "POST", url: "/claims/submit" })).statusCode).toBe(200);
    await app.close();
  });

  it("enforce: a failed read fails closed with 503", async () => {
    configureClaimsBillingGate({ mode: "enforce" });
    bindReader(new Error("db down"));
    const app = await gatedApp();
    const res = await app.inject({ method: "POST", url: "/claims/submit" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "BILLING_ENTITLEMENT_UNAVAILABLE" });
    await app.close();
  });

  it("shadow: logs the would-deny (org + route only) and lets the work through", async () => {
    const logs: Array<Record<string, unknown>> = [];
    configureClaimsBillingGate({ mode: "shadow", log: (_m, d) => logs.push(d) });
    bindReader({ entitled: false, reason: "never_purchased" });
    const app = await gatedApp();
    expect((await app.inject({ method: "POST", url: "/claims/submit" })).statusCode).toBe(200);
    expect(logs).toEqual([
      { organizationId: ORG, route: "POST /claims/submit", reason: "never_purchased" },
    ]);
    await app.close();
  });

  it("off: never reads the entitlement", async () => {
    configureClaimsBillingGate({ mode: "off" });
    bindReader(new Error("must not be called"));
    const app = await gatedApp();
    expect((await app.inject({ method: "POST", url: "/claims/submit" })).statusCode).toBe(200);
    expect(calls).toBe(0);
    await app.close();
  });
});

describe("isClaimsBillingEntitled", () => {
  it("is true in off/shadow, the real answer in enforce, and throws 503 on a failed read in enforce", async () => {
    bindReader({ entitled: false, reason: "subscription_paused" });
    configureClaimsBillingGate({ mode: "off" });
    expect(await isClaimsBillingEntitled(ORG)).toBe(true);
    configureClaimsBillingGate({ mode: "shadow" });
    expect(await isClaimsBillingEntitled(ORG)).toBe(true);
    configureClaimsBillingGate({ mode: "enforce" });
    expect(await isClaimsBillingEntitled(ORG)).toBe(false);
    bindReader(new Error("db down"));
    await expect(isClaimsBillingEntitled(ORG)).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("holdUnlessClaimsBillingEntitled (workers: hold, don't fail)", () => {
  const job = () => {
    const moves: Array<[number, string | undefined]> = [];
    return {
      moves,
      moveToDelayed: async (ts: number, token?: string) => {
        moves.push([ts, token]);
      },
    };
  };

  it("enforce + not entitled: moves the job back to delayed and throws DelayedError (no attempt spent)", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindReader({ entitled: false, reason: "never_purchased" });
    const j = job();
    await expect(
      holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit", () => 1_000),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(j.moves).toEqual([[1_000 + CLAIMS_BILLING_HOLD_MS, "tok"]]);
  });

  it("enforce + failed read: holds too (fail closed, never a DLQ)", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindReader(new Error("db down"));
    const j = job();
    await expect(
      holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit"),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(j.moves).toHaveLength(1);
  });

  it("entitled, or shadow: runs the job", async () => {
    configureClaimsBillingGate({ mode: "enforce" });
    bindReader({ entitled: true });
    const j = job();
    await holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit");
    configureClaimsBillingGate({ mode: "shadow" });
    bindReader({ entitled: false, reason: "lapsed" });
    await holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit");
    expect(j.moves).toEqual([]);
  });
});
