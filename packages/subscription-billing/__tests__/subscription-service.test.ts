// M35-T03 — §2.2 subscription lifecycle service (D7 status graph over an in-memory store).
import { beforeEach, describe, expect, it } from "vitest";
import {
  SubscriptionLifecycleService,
  SubscriptionTransitionError,
} from "../src/service/subscription-service";
import type {
  PlanEligibilityFacts,
  SubscriptionRecord,
  SubscriptionStateHistoryInsert,
  SubscriptionStore,
} from "../src/service/ports";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function plan(overrides: Partial<PlanEligibilityFacts> = {}): PlanEligibilityFacts {
  return {
    planId: "plan-pro",
    slug: "professional-monthly",
    tier: "professional",
    cadence: "monthly",
    basePriceCents: 50000,
    trialPeriodDays: 14,
    isActive: true,
    isDeprecated: false,
    ...overrides,
  };
}

class FakeSubscriptionStore implements SubscriptionStore {
  rows = new Map<string, SubscriptionRecord>();
  history: SubscriptionStateHistoryInsert[] = [];
  plans = new Map<string, PlanEligibilityFacts>();
  seq = 0;

  async loadForUpdate(id: string) {
    return this.rows.get(id) ?? null;
  }
  async activeForOrg(org: string) {
    for (const r of this.rows.values()) {
      if (r.organizationId === org && r.status !== "canceled" && r.status !== "paused") return r;
    }
    return null;
  }
  async planEligibility(planId: string) {
    return this.plans.get(planId) ?? null;
  }
  async insertSubscription(input: { organizationId: string; plan: PlanEligibilityFacts; status: SubscriptionRecord["status"] }) {
    const id = `sub-${++this.seq}`;
    const rec: SubscriptionRecord = {
      id,
      organizationId: input.organizationId,
      planId: input.plan.planId,
      planSlug: input.plan.slug,
      planTier: input.plan.tier,
      status: input.status,
      cadence: input.plan.cadence,
      basePriceCents: input.plan.basePriceCents,
      cancelAtPeriodEnd: false,
    };
    this.rows.set(id, rec);
    return rec;
  }
  async updateStatus(input: { subscriptionId: string; toStatus: SubscriptionRecord["status"]; cancelAtPeriodEnd?: boolean }) {
    const r = this.rows.get(input.subscriptionId)!;
    this.rows.set(input.subscriptionId, { ...r, status: input.toStatus, cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? r.cancelAtPeriodEnd });
  }
  async updatePlan(input: { subscriptionId: string; plan: PlanEligibilityFacts }) {
    const r = this.rows.get(input.subscriptionId)!;
    this.rows.set(input.subscriptionId, { ...r, planId: input.plan.planId, planSlug: input.plan.slug, planTier: input.plan.tier });
  }
  async appendStateHistory(row: SubscriptionStateHistoryInsert) {
    this.history.push(row);
  }
}

describe("SubscriptionLifecycleService.createSubscription", () => {
  let store: FakeSubscriptionStore;
  let svc: SubscriptionLifecycleService;
  beforeEach(() => {
    store = new FakeSubscriptionStore();
    svc = new SubscriptionLifecycleService(store);
  });

  it("starts trialing when the plan has trial days, and emits m35.subscription.created", async () => {
    store.plans.set("plan-pro", plan({ trialPeriodDays: 14 }));
    const res = await svc.createSubscription({ organizationId: "org-1", planId: "plan-pro", actorMembershipId: "mem-1", now: NOW });
    expect(res.subscription.status).toBe("trialing");
    expect(res.outbox.map((o) => o.eventName)).toEqual(["m35.subscription.created"]);
    expect(store.history[0]).toMatchObject({ fromStatus: null, toStatus: "trialing", reasonCode: "subscription_created" });
  });

  it("starts active when trial days are zero", async () => {
    store.plans.set("plan-pro", plan({ trialPeriodDays: 0 }));
    const res = await svc.createSubscription({ organizationId: "org-1", planId: "plan-pro", actorMembershipId: null, now: NOW });
    expect(res.subscription.status).toBe("active");
  });

  it("rejects a new subscription on a deprecated plan (§2.3 grandfathering)", async () => {
    store.plans.set("plan-old", plan({ planId: "plan-old", isActive: false, isDeprecated: true }));
    await expect(
      svc.createSubscription({ organizationId: "org-1", planId: "plan-old", actorMembershipId: null, now: NOW }),
    ).rejects.toMatchObject({ code: "plan_not_eligible" });
  });
});

describe("SubscriptionLifecycleService.transition (D7)", () => {
  let store: FakeSubscriptionStore;
  let svc: SubscriptionLifecycleService;
  beforeEach(async () => {
    store = new FakeSubscriptionStore();
    svc = new SubscriptionLifecycleService(store);
    store.plans.set("plan-pro", plan({ trialPeriodDays: 0 }));
    await svc.createSubscription({ organizationId: "org-1", planId: "plan-pro", actorMembershipId: null, now: NOW });
  });

  it("active → past_due emits status_changed", async () => {
    const res = await svc.transition({ subscriptionId: "sub-1", toStatus: "past_due", actorMembershipId: null, reasonCode: "payment_failed", stripeEventId: "evt_1", now: NOW });
    expect(res.from).toBe("active");
    expect(res.outbox.map((o) => o.eventName)).toContain("m35.subscription.status_changed");
    expect(store.rows.get("sub-1")!.status).toBe("past_due");
  });

  it("suspend emits both suspended and tenant.billing_blocked with the dunning stage", async () => {
    await svc.transition({ subscriptionId: "sub-1", toStatus: "past_due", actorMembershipId: null, reasonCode: "pf", stripeEventId: null, now: NOW });
    await svc.transition({ subscriptionId: "sub-1", toStatus: "at_risk", actorMembershipId: null, reasonCode: "dunning", stripeEventId: null, now: NOW });
    const res = await svc.transition({ subscriptionId: "sub-1", toStatus: "suspended", actorMembershipId: null, reasonCode: "day_28", stripeEventId: null, dunning: { dunningStage: "day_28_suspend" }, now: NOW });
    const names = res.outbox.map((o) => o.eventName);
    expect(names).toContain("m35.subscription.suspended");
    expect(names).toContain("m35.tenant.billing_blocked");
    const blocked = res.outbox.find((o) => o.eventName === "m35.tenant.billing_blocked")!;
    expect((blocked.payload as { dunningStage: string }).dunningStage).toBe("day_28_suspend");
  });

  it("rejects an illegal edge (active → at_risk)", async () => {
    await expect(
      svc.transition({ subscriptionId: "sub-1", toStatus: "at_risk", actorMembershipId: null, reasonCode: "x", stripeEventId: null, now: NOW }),
    ).rejects.toBeInstanceOf(SubscriptionTransitionError);
  });

  it("refuses to leave the terminal canceled status", async () => {
    await svc.transition({ subscriptionId: "sub-1", toStatus: "canceled", actorMembershipId: null, reasonCode: "closed", stripeEventId: null, now: NOW });
    await expect(
      svc.transition({ subscriptionId: "sub-1", toStatus: "active", actorMembershipId: null, reasonCode: "x", stripeEventId: null, now: NOW }),
    ).rejects.toMatchObject({ code: "terminal_status" });
  });

  it("trialing → active emits activated", async () => {
    store.plans.set("plan-trial", plan({ planId: "plan-trial", trialPeriodDays: 14 }));
    await svc.createSubscription({ organizationId: "org-2", planId: "plan-trial", actorMembershipId: null, now: NOW });
    const res = await svc.transition({ subscriptionId: "sub-2", toStatus: "active", actorMembershipId: null, reasonCode: "converted", stripeEventId: null, now: NOW });
    expect(res.outbox.map((o) => o.eventName)).toContain("m35.subscription.activated");
  });
});

describe("SubscriptionLifecycleService.changePlan", () => {
  it("allows moving an existing subscription onto a deprecated plan (grandfathering)", async () => {
    const store = new FakeSubscriptionStore();
    const svc = new SubscriptionLifecycleService(store);
    store.plans.set("plan-pro", plan({ trialPeriodDays: 0 }));
    store.plans.set("plan-dep", plan({ planId: "plan-dep", slug: "legacy", isActive: false, isDeprecated: true }));
    await svc.createSubscription({ organizationId: "org-1", planId: "plan-pro", actorMembershipId: null, now: NOW });
    const res = await svc.changePlan({ subscriptionId: "sub-1", toPlanId: "plan-dep", prorationBehavior: "create_prorations", actorMembershipId: "mem-1", now: NOW });
    expect(res.toPlanSlug).toBe("legacy");
    expect(res.outbox.map((o) => o.eventName)).toEqual(["m35.subscription.plan_changed"]);
    expect(store.rows.get("sub-1")!.planId).toBe("plan-dep");
  });
});
