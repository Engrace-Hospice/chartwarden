import {
  type ClearinghouseBinding,
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
  UNBOUND_OUTSIDE,
} from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { DelayedError } from "bullmq";
import { describe, expect, it } from "vitest";
import { CLAIMS_BILLING_HOLD_MS } from "../../../bootstrap/claims-billing-gate";
import type { M23TransportDeps } from "./clearinghouse-submission";
import {
  CLEARINGHOUSE_UNBOUND_ALERT,
  clearinghouseStateFor,
  holdJobWhileUnbound,
} from "./clearinghouse-unbound-hold";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function transportDeps(forOrg: (org: string) => ClearinghouseBinding): {
  transport: M23TransportDeps;
} {
  return {
    transport: {
      binding: { ...UNBOUND_NOT_CHOSEN, forOrg: async (org) => forOrg(org) },
      contexts: { contextFor: async () => ({}) as never, providerEntitiesFor: async () => [] },
    },
  };
}

describe("clearinghouseStateFor", () => {
  it("is bound for a legacy single-binding deployment and for an org with a live vendor", async () => {
    expect(await clearinghouseStateFor({}, ORG)).toEqual({ state: "bound" });
    const live: ClearinghouseBinding = { vendor: "stedi", transport: new InMemoryClearinghouse() };
    expect(await clearinghouseStateFor(transportDeps(() => live), ORG)).toEqual({
      state: "bound",
    });
  });

  it("carries the unbound reason of the org's own binding", async () => {
    const deps = transportDeps((org) => (org === ORG ? UNBOUND_OUTSIDE : UNBOUND_NOT_ACTIVE));
    expect(await clearinghouseStateFor(deps, ORG)).toEqual({
      state: "unbound",
      reason: "outside",
    });
    expect(await clearinghouseStateFor(deps, OTHER)).toEqual({
      state: "unbound",
      reason: "not_active",
    });
  });
});

describe("holdJobWhileUnbound", () => {
  const alertsOf = () => {
    const sent: { alertCode: string; organizationId: string; severity: string }[] = [];
    return { sent, port: { dispatch: async (a: (typeof sent)[number]) => void sent.push(a) } };
  };

  it("moves the job back to delayed without spending an attempt, and raises ONE alert per org and reason", async () => {
    const { sent, port } = alertsOf();
    const moved: number[] = [];
    const job = { moveToDelayed: async (at: number) => void moved.push(at) };
    const clock = Date.parse("2026-11-06T10:00:00Z");
    const hold = () =>
      holdJobWhileUnbound({
        deps: { alerts: port },
        job,
        token: "t",
        queue: "claim.submit",
        organizationId: ORG,
        reason: "not_chosen",
        now: () => clock,
      });
    await expect(hold()).rejects.toBeInstanceOf(DelayedError);
    await expect(hold()).rejects.toBeInstanceOf(DelayedError);
    expect(moved).toEqual([clock + CLAIMS_BILLING_HOLD_MS, clock + CLAIMS_BILLING_HOLD_MS]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ alertCode: CLEARINGHOUSE_UNBOUND_ALERT, organizationId: ORG });
  });

  it("alerts again for a different org, and again after the quiet window", async () => {
    const { sent, port } = alertsOf();
    const job = { moveToDelayed: async () => undefined };
    let clock = Date.parse("2026-11-06T10:00:00Z");
    const hold = (organizationId: string) =>
      holdJobWhileUnbound({
        deps: { alerts: port },
        job,
        token: undefined,
        queue: "claim.submit",
        organizationId,
        reason: "not_active",
        now: () => clock,
      }).catch(() => undefined);
    await hold("33333333-3333-4333-8333-333333333333");
    await hold("44444444-4444-4444-8444-444444444444");
    expect(sent).toHaveLength(2);
    clock += 7 * 60 * 60_000;
    await hold("33333333-3333-4333-8333-333333333333");
    expect(sent).toHaveLength(3);
  });
});
