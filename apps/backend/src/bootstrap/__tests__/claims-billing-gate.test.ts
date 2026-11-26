// ADR-0110 D4/D6 (CW-AC-24) — the claims-billing gate's mode semantics: enforce (the default) refuses with 402 + the
// reason, holds a queued job, and fails CLOSED (503) on a failed entitlement read; shadow (log-only) logs, records a
// finding and allows; off ignores. Boot refuses a non-off mode on the deny-stub, and a production deployment below
// `enforce` needs a written reason.
import type { ClaimsBillingEntitlement } from "@chartwarden/types";
import { DelayedError } from "bullmq";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAIMS_BILLING_HOLD_MS,
  DEFAULT_CLAIMS_BILLING_ENFORCEMENT,
  ENTITLEMENT_UNAVAILABLE_REASON,
  FINDING_DEDUPE_MS,
  FINDING_RETRY_MS,
  type GateFinding,
  MAX_FINDING_KEYS,
  assertClaimsBillingSeamBound,
  claimsBillingAddonRequired,
  claimsBillingAllowsWork,
  claimsBillingEnforcementBootWarning,
  claimsBillingEnforcementMode,
  claimsBillingPreHandler,
  claimsBillingVerdict,
  configureClaimsBillingGate,
  holdUnlessClaimsBillingEntitled,
  isClaimsBillingEntitled,
  parseClaimsBillingEnforcement,
  withClaimsBillingGate,
} from "../claims-billing-gate";
import {
  CLAIMS_BILLING_LOG_ONLY_REASON_ENV,
  claimsBillingLogOnlyReasonProblem,
  parseClaimsBillingLogOnlyReason,
} from "../env";
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

async function gatedApp(organizationId: string | null = ORG) {
  const app = Fastify();
  app.decorateRequest("context", null as never);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { context: unknown }).context = {
      organizationId,
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
  configureClaimsBillingGate({ mode: DEFAULT_CLAIMS_BILLING_ENFORCEMENT, log: () => {} });
  vi.useRealTimers();
});

describe("parseClaimsBillingEnforcement", () => {
  it("defaults to enforce (CW-AC-24) and accepts the three modes", () => {
    expect(DEFAULT_CLAIMS_BILLING_ENFORCEMENT).toBe("enforce");
    expect(parseClaimsBillingEnforcement({})).toBe("enforce");
    expect(parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: "  " })).toBe("enforce");
    expect(parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: " Enforce " })).toBe(
      "enforce",
    );
    expect(parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: "shadow" })).toBe("shadow");
    expect(parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: "off" })).toBe("off");
  });
  it("refuses anything else", () => {
    expect(() => parseClaimsBillingEnforcement({ CLAIMS_BILLING_ENFORCEMENT: "on" })).toThrow(
      /CLAIMS_BILLING_ENFORCEMENT/,
    );
  });
  it("an unconfigured gate enforces: a process that never calls configure is not log-only", async () => {
    vi.resetModules();
    const fresh = await import("../claims-billing-gate");
    expect(fresh.claimsBillingEnforcementMode()).toBe("enforce");
  });
});

describe("the log-only reason (a deliberate, audited way to run below enforce)", () => {
  const REASON = "CW-AC-24 log-only until the 2027-01 rollout review";
  const env = (reason?: string) => ({ [CLAIMS_BILLING_LOG_ONLY_REASON_ENV]: reason });

  it("enforce needs no reason; shadow and off need one", () => {
    expect(claimsBillingLogOnlyReasonProblem("enforce", env())).toBeNull();
    for (const mode of ["shadow", "off"] as const) {
      expect(claimsBillingLogOnlyReasonProblem(mode, env()), mode).toMatch(/is required/);
      expect(claimsBillingLogOnlyReasonProblem(mode, env("   ")), mode).toMatch(/is required/);
      expect(claimsBillingLogOnlyReasonProblem(mode, env(REASON)), mode).toBeNull();
    }
  });

  it("refuses a reason too short to say anything, or too long to be a reason", () => {
    expect(claimsBillingLogOnlyReasonProblem("shadow", env("because"))).toMatch(/20-200/);
    expect(claimsBillingLogOnlyReasonProblem("shadow", env("x".repeat(201)))).toMatch(/20-200/);
  });

  it("trims the reason and reads a blank one as unset", () => {
    expect(parseClaimsBillingLogOnlyReason(env(`  ${REASON}  `))).toBe(REASON);
    expect(parseClaimsBillingLogOnlyReason(env(" "))).toBeUndefined();
    expect(parseClaimsBillingLogOnlyReason({})).toBeUndefined();
  });

  it("withholds a reason shaped like an SSN or an MBI (synthetic values) and refuses it in production", () => {
    for (const text of [
      "owner 123-45-6789 reviews the gate in January",
      "ticket for 1EG4-TE5-MK73 until the rollout review",
    ]) {
      expect(parseClaimsBillingLogOnlyReason(env(text)), text).toBe(
        "[withheld: looked like a patient identifier]",
      );
      expect(claimsBillingLogOnlyReasonProblem("shadow", env(text)), text).toMatch(
        /must not look like a patient identifier/,
      );
    }
    // ordinary reasons with digits are fine
    expect(parseClaimsBillingLogOnlyReason(env("CW-AC-24 log-only until 2027-01-31 review"))).toBe(
      "CW-AC-24 log-only until 2027-01-31 review",
    );
  });

  it("strips control characters and cuts an over-long reason (it lands in an append-only audit row in every environment)", () => {
    expect(parseClaimsBillingLogOnlyReason(env("CW-AC-24\nlog-only\u0000until review\t"))).toBe(
      "CW-AC-24 log-only until review",
    );
    const clamped = parseClaimsBillingLogOnlyReason(env("x".repeat(5_000)));
    expect(clamped).toHaveLength(201);
    // still seen as over-long, so a production boot refuses it
    expect(claimsBillingLogOnlyReasonProblem("shadow", env("x".repeat(5_000)))).toMatch(/20-200/);
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

  it("enforce: the 402 message and detail say why, not always that the add-on is missing", () => {
    const wording = [
      ["clearinghouse_not_chosen", "has not chosen a clearinghouse"],
      ["clearinghouse_outside", "bills outside ChartWarden"],
      ["clearinghouse_not_active", "clearinghouse is set up but not active"],
      ["clearinghouse_baa_revoked", "vendor BAA was revoked"],
      ["never_purchased", "has not purchased the claims-billing add-on"],
      ["lapsed", "claims-billing add-on has ended"],
      ["subscription_suspended", "subscription is suspended"],
      ["subscription_canceled", "subscription is canceled"],
      ["subscription_paused", "subscription is paused"],
    ] as const;
    for (const [reason, phrase] of wording) {
      const refusal = claimsBillingAddonRequired(reason);
      expect(refusal.statusCode, reason).toBe(402);
      expect(refusal.message, reason).toContain(phrase);
      expect(refusal.details?.[0], reason).toMatchObject({ code: reason });
      expect(refusal.details?.[0]?.message, reason).toContain(phrase);
    }
  });

  it("a gated route reached with no org is refused 403 in shadow and enforce, untouched in off", async () => {
    bindReader({ entitled: true });
    for (const mode of ["shadow", "enforce"] as const) {
      configureClaimsBillingGate({ mode });
      const app = await gatedApp(null);
      const res = await app.inject({ method: "POST", url: "/claims/submit" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
      await app.close();
    }
    expect(calls).toBe(0);
    configureClaimsBillingGate({ mode: "off" });
    const app = await gatedApp(null);
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

describe("the route gate — a rule's exemption (a void claim stays submittable)", () => {
  async function exemptApp(exempt: () => Promise<boolean>) {
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
    withClaimsBillingGate(
      app,
      [{ cls: "new_work", method: "POST", path: "/claims/:id/submit", exempt }],
      () => {
        app.post("/claims/:id/submit", { preHandler: [async () => {}] }, async () => ({
          ok: true,
        }));
      },
    );
    await app.ready();
    return app;
  }

  it("enforce + not entitled: an exempt request passes, a non-exempt one is refused 402", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindReader({ entitled: false, reason: "never_purchased" });
    let isVoid = true;
    const app = await exemptApp(async () => isVoid);
    expect((await app.inject({ method: "POST", url: "/claims/c1/submit" })).statusCode).toBe(200);
    isVoid = false;
    expect((await app.inject({ method: "POST", url: "/claims/c2/submit" })).statusCode).toBe(402);
    await app.close();
  });

  it("enforce: a failed exemption lookup fails closed (gated as normal)", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindReader({ entitled: false, reason: "lapsed" });
    const app = await exemptApp(async () => {
      throw new Error("db down");
    });
    expect((await app.inject({ method: "POST", url: "/claims/c1/submit" })).statusCode).toBe(402);
    await app.close();
  });

  it("an entitled org never pays for the exemption lookup", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindReader({ entitled: true });
    let looked = 0;
    const app = await exemptApp(async () => {
      looked += 1;
      return false;
    });
    expect((await app.inject({ method: "POST", url: "/claims/c1/submit" })).statusCode).toBe(200);
    expect(looked).toBe(0);
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
      holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit", { now: () => 1_000 }),
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

  it("enforce + not entitled: an exempt job (a void claim) runs; a failed exemption lookup holds", async () => {
    configureClaimsBillingGate({ mode: "enforce", log: () => {} });
    bindReader({ entitled: false, reason: "never_purchased" });
    const j = job();
    await holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit", {
      exempt: async () => true,
    });
    expect(j.moves).toEqual([]);
    await expect(
      holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit", {
        exempt: async () => false,
      }),
    ).rejects.toBeInstanceOf(DelayedError);
    await expect(
      holdUnlessClaimsBillingEntitled(j, "tok", ORG, "claim.submit", {
        exempt: async () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(j.moves).toHaveLength(2);
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

// A production deployment running anything but the enforcing default (a deliberate, reasoned choice) says so at boot.
describe("claimsBillingEnforcementBootWarning", () => {
  it("warns on a production deployment in shadow or off, naming the mode and the variable", () => {
    for (const mode of ["shadow", "off"] as const) {
      const warning = claimsBillingEnforcementBootWarning(mode, "production");
      expect(warning, mode).toContain(mode);
      expect(warning, mode).toContain("CLAIMS_BILLING_ENFORCEMENT");
    }
  });

  it("says what each mode leaves behind: shadow records would_block findings, off records nothing", () => {
    expect(claimsBillingEnforcementBootWarning("shadow", "production")).toContain(
      "m23.claims_billing_gate.would_block",
    );
    const off = claimsBillingEnforcementBootWarning("off", "production");
    expect(off).toContain("nothing is evaluated, logged or recorded");
    expect(off).not.toContain("only logged and recorded");
  });

  it("is silent for enforce in production, and outside production whatever the mode", () => {
    expect(claimsBillingEnforcementBootWarning("enforce", "production")).toBeNull();
    for (const env of ["development", "test", undefined]) {
      expect(claimsBillingEnforcementBootWarning("shadow", env)).toBeNull();
      expect(claimsBillingEnforcementBootWarning("off", env)).toBeNull();
    }
  });
});

// CW-AC-24 — every outcome of the decision itself, in the enforcing default.
describe("claimsBillingVerdict and claimsBillingAllowsWork (enforce, the default)", () => {
  it("the mode a configure binds is the mode the gate reports", () => {
    expect(claimsBillingEnforcementMode()).toBe("enforce");
    configureClaimsBillingGate({ mode: "off" });
    expect(claimsBillingEnforcementMode()).toBe("off");
  });

  it("entitled → allow; not entitled → deny with each reason; unreadable → 503", async () => {
    bindReader({ entitled: true });
    expect(await claimsBillingVerdict(ORG, {})).toEqual({ allow: true });
    for (const reason of [
      "clearinghouse_not_chosen",
      "clearinghouse_outside",
      "clearinghouse_not_active",
      "clearinghouse_baa_revoked",
      "subscription_suspended",
      "subscription_paused",
      "subscription_canceled",
    ] as const) {
      bindReader({ entitled: false, reason });
      expect(await claimsBillingVerdict(ORG, {}), reason).toEqual({ allow: false, reason });
    }
    bindReader(new Error("db down"));
    await expect(claimsBillingVerdict(ORG, {})).rejects.toMatchObject({
      statusCode: 503,
      code: "BILLING_ENTITLEMENT_UNAVAILABLE",
    });
  });

  it("an exemption rescues a refused org and an unreadable one, but only when it says yes", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_not_active" });
    expect(await claimsBillingVerdict(ORG, {}, async () => true)).toEqual({ allow: true });
    expect(await claimsBillingVerdict(ORG, {}, async () => false)).toEqual({
      allow: false,
      reason: "clearinghouse_not_active",
    });
    bindReader(new Error("db down"));
    expect(await claimsBillingVerdict(ORG, {}, async () => true)).toEqual({ allow: true });
    await expect(claimsBillingVerdict(ORG, {}, async () => false)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("claimsBillingAllowsWork never throws: entitled true, refused false, unreadable false", async () => {
    bindReader({ entitled: true });
    expect(await claimsBillingAllowsWork(ORG, { queue: "q" })).toBe(true);
    bindReader({ entitled: false, reason: "subscription_suspended" });
    expect(await claimsBillingAllowsWork(ORG, { queue: "q" })).toBe(false);
    bindReader(new Error("db down"));
    expect(await claimsBillingAllowsWork(ORG, { queue: "q" })).toBe(false);
  });

  it("enforce records nothing: the refusal is the outcome, not a finding", async () => {
    const findings: GateFinding[] = [];
    configureClaimsBillingGate({
      mode: "enforce",
      log: () => {},
      recordFinding: async (f) => {
        findings.push(f);
      },
    });
    bindReader({ entitled: false, reason: "clearinghouse_not_chosen" });
    await claimsBillingVerdict(ORG, { route: "POST /claims/submit" });
    bindReader(new Error("db down"));
    await claimsBillingVerdict(ORG, { route: "POST /claims/submit" }).catch(() => undefined);
    expect(findings).toEqual([]);
  });
});

// CW-AC-24 — log-only is evidence: what `enforce` would have blocked, recorded once per window.
describe("log-only findings (what shadow would have blocked)", () => {
  const SITE = { route: "POST /claims/submit" };
  const OTHER_ORG = "a1000000-0000-4000-8000-000000000002";
  let findings: GateFinding[];
  let logs: Array<[string, Record<string, unknown>]>;
  let sinkFails: boolean;

  beforeEach(() => {
    findings = [];
    logs = [];
    sinkFails = false;
    configureClaimsBillingGate({
      mode: "shadow",
      log: (message, detail) => logs.push([message, detail]),
      recordFinding: async (finding) => {
        if (sinkFails) throw new Error("audit down");
        findings.push(finding);
      },
    });
  });

  it("records a would_deny with the org, the site and the reason, and lets the work through", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_outside" });
    expect(await claimsBillingVerdict(ORG, SITE)).toEqual({ allow: true });
    expect(findings).toEqual([
      { organizationId: ORG, ...SITE, outcome: "would_deny", reason: "clearinghouse_outside" },
    ]);
  });

  it("records a would_fail_closed when the entitlement read fails, and lets the work through", async () => {
    bindReader(new Error("db down"));
    expect(await claimsBillingVerdict(ORG, { queue: "claim.submit" })).toEqual({ allow: true });
    expect(findings).toEqual([
      {
        organizationId: ORG,
        queue: "claim.submit",
        outcome: "would_fail_closed",
        reason: ENTITLEMENT_UNAVAILABLE_REASON,
      },
    ]);
  });

  it("an entitled org leaves no finding", async () => {
    bindReader({ entitled: true });
    await claimsBillingVerdict(ORG, SITE);
    expect(findings).toEqual([]);
  });

  it("writes one finding per org, site and reason per window, and another once the window turns over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    bindReader({ entitled: false, reason: "clearinghouse_not_chosen" });
    await claimsBillingVerdict(ORG, SITE);
    await claimsBillingVerdict(ORG, SITE);
    expect(findings).toHaveLength(1);
    await claimsBillingVerdict(ORG, { route: "POST /claims/:id/replace" }); // another site
    await claimsBillingVerdict(ORG, { queue: "claim.submit" }); // another site kind
    await claimsBillingVerdict(OTHER_ORG, SITE); // another org
    bindReader({ entitled: false, reason: "clearinghouse_not_active" });
    await claimsBillingVerdict(ORG, SITE); // another reason
    expect(findings).toHaveLength(5);
    vi.setSystemTime(new Date(Date.now() + FINDING_DEDUPE_MS + 1));
    await claimsBillingVerdict(ORG, SITE);
    expect(findings).toHaveLength(6);
    // the log line is not throttled: every would-deny is logged
    expect(logs.filter(([m]) => m === "claims-billing would deny (shadow)")).toHaveLength(7);
  });

  it("two concurrent hits write one row", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_not_chosen" });
    await Promise.all([claimsBillingVerdict(ORG, SITE), claimsBillingVerdict(ORG, SITE)]);
    expect(findings).toHaveLength(1);
  });

  it("a void claim a rule exempts leaves no finding (shadow records what enforce would block)", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_not_chosen" });
    expect(await claimsBillingVerdict(ORG, SITE, async () => true)).toEqual({ allow: true });
    expect(findings).toEqual([]);
    expect(await claimsBillingVerdict(ORG, SITE, async () => false)).toEqual({ allow: true });
    expect(findings).toHaveLength(1);
    // a failed exemption lookup gates as normal: it is a finding too
    await claimsBillingVerdict(OTHER_ORG, SITE, async () => {
      throw new Error("db down");
    });
    expect(findings.map((f) => f.organizationId)).toEqual([ORG, OTHER_ORG]);
  });

  it("a failing sink is logged, never blocks the work, and is retried after the retry delay, not on every hit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    bindReader({ entitled: false, reason: "clearinghouse_not_chosen" });
    let attempts = 0;
    configureClaimsBillingGate({
      mode: "shadow",
      log: (message, detail) => logs.push([message, detail]),
      recordFinding: async (finding) => {
        attempts += 1;
        if (sinkFails) throw new Error("audit down");
        findings.push(finding);
      },
    });
    sinkFails = true;
    expect(await claimsBillingVerdict(ORG, SITE)).toEqual({ allow: true });
    expect(findings).toEqual([]);
    expect(logs.find(([m]) => m === "claims-billing finding not recorded")?.[1]).toMatchObject({
      organizationId: ORG,
      reason: "clearinghouse_not_chosen",
      error: "audit down",
    });
    // while the audit write keeps failing, a busy org is one attempt per retry delay, not one per request
    expect(await claimsBillingVerdict(ORG, SITE)).toEqual({ allow: true });
    expect(attempts).toBe(1);
    sinkFails = false;
    vi.setSystemTime(new Date(Date.now() + FINDING_RETRY_MS + 1));
    await claimsBillingVerdict(ORG, SITE);
    expect(attempts).toBe(2);
    expect(findings).toHaveLength(1);
    await claimsBillingVerdict(ORG, SITE); // recorded: now it waits a full window
    expect(attempts).toBe(2);
  });

  it("past the key bound the oldest key is evicted, so a busy gate neither grows without limit nor re-writes everything", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_not_chosen" });
    const orgs = Array.from({ length: MAX_FINDING_KEYS + 1 }, (_, i) => `org-${i}`);
    for (const org of orgs) await claimsBillingVerdict(org, SITE);
    expect(findings).toHaveLength(MAX_FINDING_KEYS + 1);
    await claimsBillingVerdict(orgs.at(-1) as string, SITE); // newest: still remembered
    expect(findings).toHaveLength(MAX_FINDING_KEYS + 1);
    await claimsBillingVerdict(orgs[0] as string, SITE); // oldest: evicted, written again
    expect(findings).toHaveLength(MAX_FINDING_KEYS + 2);
  });

  it("a request with no matched route template names no raw URL in the finding", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_outside" });
    await claimsBillingPreHandler({
      method: "POST",
      url: "/api/v1/claims/9f1c0000-0000-4000-8000-000000000001/submit?token=x",
      routeOptions: {},
      context: { organizationId: ORG },
    } as never);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.route).toBe("POST (unmatched route)");
  });

  it("a finding names ids, a route or queue and a reason code, nothing else", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_baa_revoked" });
    await claimsBillingVerdict(ORG, SITE);
    expect(Object.keys(findings[0] ?? {}).sort()).toEqual([
      "organizationId",
      "outcome",
      "reason",
      "route",
    ]);
  });

  it("is recorded for every shadow caller: the route gate, the worker hold and the sweep check", async () => {
    bindReader({ entitled: false, reason: "subscription_paused" });
    const app = await gatedApp();
    expect((await app.inject({ method: "POST", url: "/claims/submit" })).statusCode).toBe(200);
    await app.close();
    const moves: number[] = [];
    await holdUnlessClaimsBillingEntitled(
      { moveToDelayed: async (ts) => void moves.push(ts) },
      "tok",
      ORG,
      "claim.submit",
    );
    expect(await claimsBillingAllowsWork(ORG, { queue: "m41.submission-drain" })).toBe(true);
    expect(await isClaimsBillingEntitled(ORG, { queue: "claimmd-webhook-sweep" })).toBe(true);
    expect(moves).toEqual([]);
    expect(findings.map((f) => f.route ?? f.queue)).toEqual([
      "POST /claims/submit",
      "claim.submit",
      "m41.submission-drain",
      "claimmd-webhook-sweep",
    ]);
  });

  it("a reconfigure without a sink drops the previous one, and off and enforce never call it", async () => {
    bindReader({ entitled: false, reason: "clearinghouse_not_chosen" });
    configureClaimsBillingGate({ mode: "shadow", log: () => {} });
    await claimsBillingVerdict(ORG, SITE);
    expect(findings).toEqual([]);
    for (const mode of ["off", "enforce"] as const) {
      configureClaimsBillingGate({
        mode,
        recordFinding: async (f) => {
          findings.push(f);
        },
      });
      await claimsBillingVerdict(ORG, SITE);
    }
    expect(findings).toEqual([]);
  });
});
