// M26 backend unit tests — the §4.7 ABAC predicate resolvers (over an injected resolver, no DB), the §4.10
// outbox-event catalog conformance (naming / owner / declared consumers), and the §4.6 permission surface.
import type { AbacContext, AbacTarget } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import { buildM26AbacPredicates, type ReadingM26AbacResolver } from "../abac-predicates";
import { M26_OUTBOX_EVENTS } from "../events-by-m26";
import { M26_PERMISSION_KEY_LIST } from "../permission-keys";

const ctx = (roles: string[] = []): AbacContext =>
  ({ organizationId: "org-1", userId: "u-1", roles, attributes: {} }) as unknown as AbacContext;
const target = (capPeriodId?: string): AbacTarget => ({ capPeriodId }) as AbacTarget;

function resolver(period: { status: string; methodology: string | null } | null, settlement: string | null): ReadingM26AbacResolver {
  return { async loadPeriod() { return period; }, async loadSettlementStatus() { return settlement; } };
}

describe("M26 §4.7 ABAC predicates", () => {
  it("cap_period_open accepts the accrual-eligible states only", async () => {
    for (const status of ["open", "active", "reopened"]) {
      const p = buildM26AbacPredicates({ resolver: resolver({ status, methodology: null }, null) });
      expect(await p.cap_period_open!(ctx(), target("cp-1"))).toBe(true);
    }
    const p = buildM26AbacPredicates({ resolver: resolver({ status: "settled", methodology: null }, null) });
    expect(await p.cap_period_open!(ctx(), target("cp-1"))).toBe(false);
    // No target id → deny.
    expect(await p.cap_period_open!(ctx(), target(undefined))).toBe(false);
  });

  it("cap_period_in_settlement is the period-state gate (propose creates the first settlement)", async () => {
    const p = buildM26AbacPredicates({ resolver: resolver({ status: "in_settlement", methodology: "streamlined" }, null) });
    expect(await p.cap_period_in_settlement!(ctx(), target("cp-1"))).toBe(true);
    const q = buildM26AbacPredicates({ resolver: resolver({ status: "active", methodology: "streamlined" }, null) });
    expect(await q.cap_period_in_settlement!(ctx(), target("cp-1"))).toBe(false);
  });

  it("cap_period_settled requires status=settled AND a final settlement", async () => {
    const yes = buildM26AbacPredicates({ resolver: resolver({ status: "settled", methodology: "streamlined" }, "final") });
    expect(await yes.cap_period_settled!(ctx(), target("cp-1"))).toBe(true);
    const no = buildM26AbacPredicates({ resolver: resolver({ status: "settled", methodology: "streamlined" }, "proposed") });
    expect(await no.cap_period_settled!(ctx(), target("cp-1"))).toBe(false);
  });

  it("cap_period_methodology_unlocked requires methodology null AND status open", async () => {
    const yes = buildM26AbacPredicates({ resolver: resolver({ status: "open", methodology: null }, null) });
    expect(await yes.cap_period_methodology_unlocked!(ctx(), target("cp-1"))).toBe(true);
    const locked = buildM26AbacPredicates({ resolver: resolver({ status: "open", methodology: "streamlined" }, null) });
    expect(await locked.cap_period_methodology_unlocked!(ctx(), target("cp-1"))).toBe(false);
  });

  it("cap_platform_admin checks the role (no period target)", async () => {
    const p = buildM26AbacPredicates({ resolver: resolver(null, null) });
    expect(await p.cap_platform_admin!(ctx(["platform_admin"]), target())).toBe(true);
    expect(await p.cap_platform_admin!(ctx(["billing_manager"]), target())).toBe(false);
  });

  it("a deny-stub resolver (no db) fails closed", async () => {
    const p = buildM26AbacPredicates({});
    expect(await p.cap_period_open!(ctx(), target("cp-1"))).toBe(false);
    expect(await p.cap_period_settled!(ctx(), target("cp-1"))).toBe(false);
  });
});

describe("M26 §4.10 outbox-event catalog", () => {
  it("declares nine m26.cap.* events, all owned by m26 with real declared consumers", () => {
    expect(M26_OUTBOX_EVENTS).toHaveLength(9);
    const valid = new Set(["m23", "m25", "m26", "m27", "m30", "m33", "m34", "m36"]);
    for (const e of M26_OUTBOX_EVENTS) {
      expect(e.eventName).toMatch(/^m26\.cap\.[a-z_]+$/);
      expect(e.moduleOwner).toBe("m26");
      expect(e.declaredConsumers.length).toBeGreaterThan(0);
      for (const c of e.declaredConsumers) expect(valid.has(c)).toBe(true);
    }
  });
});

describe("M26 §4.6 permission keys", () => {
  it("exposes the fourteen cap.* keys", () => {
    expect(M26_PERMISSION_KEY_LIST).toHaveLength(14);
    expect(M26_PERMISSION_KEY_LIST.every((k) => k.startsWith("cap."))).toBe(true);
  });
});
