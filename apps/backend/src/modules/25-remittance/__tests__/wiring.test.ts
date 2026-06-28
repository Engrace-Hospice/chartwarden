// M25 — boot-wiring unit tests: the consumer dispatch routing + subscription map, the consumer
// register-surface (module-only when no registrar), and the eraser registration over the injected hook.
import { describe, expect, it, vi } from "vitest";
import type { DataClass, DataEraser } from "@wardenx/types";
import type { DenialSeedStore } from "../consumers/handlers";
import {
  type M25ConsumerPorts,
  dispatchM25UpstreamEvent,
  M25_SUBSCRIPTION_MAP,
  M25_UPSTREAM_SUBSCRIPTIONS,
  registerM25Consumers,
} from "../consumers/index";
import { REMITTANCE_DATA_CLASS, registerRemittanceErasers } from "../erasers/remittance-eraser";

function fakePorts(): { ports: M25ConsumerPorts; seeds: string[] } {
  const seeds: string[] = [];
  const seen = new Set<string>();
  const seedStore: DenialSeedStore = {
    async seedDenial(input) {
      if (seen.has(input.idempotencyKey)) return { denialCaseId: "x", created: false };
      seen.add(input.idempotencyKey);
      seeds.push(input.source);
      return { denialCaseId: `new:${input.idempotencyKey}`, created: true };
    },
    async backrefDocument() {
      return { updated: true };
    },
  };
  return { ports: { seedStore }, seeds };
}

describe("consumer dispatch (§4.4)", () => {
  it("the subscription map lists exactly the three upstream topics", () => {
    expect(M25_UPSTREAM_SUBSCRIPTIONS).toEqual([
      "m23.claim.rejected",
      "m18.evv.aggregator_rejected",
      "m22.document.rendered",
    ]);
    expect(Object.keys(M25_SUBSCRIPTION_MAP)).toEqual(M25_UPSTREAM_SUBSCRIPTIONS);
  });

  it("routes m23.claim.rejected → a 277CA denial seed", async () => {
    const { ports, seeds } = fakePorts();
    const r = await dispatchM25UpstreamEvent(
      {
        topic: "m23.claim.rejected",
        payload: { organizationId: "o1", providerEntityId: "pe1", claimId: "c1", rejectionCodes: ["50"], occurredAt: "2026-06-20T00:00:00Z" },
      },
      ports,
    );
    expect(r.handled).toBe(true);
    expect(r.denialOpened?.source).toBe("claim_rejection_277ca");
    expect(seeds).toEqual(["claim_rejection_277ca"]);
  });

  it("routes m18.evv.aggregator_rejected → an EVV denial seed", async () => {
    const { ports } = fakePorts();
    const r = await dispatchM25UpstreamEvent(
      { topic: "m18.evv.aggregator_rejected", payload: { organizationId: "o1", providerEntityId: "pe1", aggregatorSubmissionId: "s1" } },
      ports,
    );
    expect(r.denialOpened?.source).toBe("evv_aggregator_rejection");
  });

  it("ignores a m22.document.rendered for a non-M25 aggregate", async () => {
    const { ports } = fakePorts();
    const r = await dispatchM25UpstreamEvent(
      { topic: "m22.document.rendered", payload: { aggregateType: "claim", aggregateId: "x", documentId: "d" } },
      ports,
    );
    expect(r.handled).toBe(false);
  });

  it("ignores an unsubscribed topic", async () => {
    const { ports } = fakePorts();
    expect((await dispatchM25UpstreamEvent({ topic: "m99.nope.x", payload: {} }, ports)).handled).toBe(false);
  });
});

describe("registerM25Consumers", () => {
  it("binds one handler per topic when a registrar + ports are supplied", () => {
    const { ports } = fakePorts();
    const bound: string[] = [];
    const subs = registerM25Consumers({ ports, bind: (topic) => bound.push(topic) });
    expect(bound).toEqual([...M25_UPSTREAM_SUBSCRIPTIONS]);
    expect(subs).toEqual(M25_UPSTREAM_SUBSCRIPTIONS);
  });

  it("is module-only (binds nothing) when no registrar is supplied", () => {
    const subs = registerM25Consumers();
    expect(subs).toEqual(M25_UPSTREAM_SUBSCRIPTIONS);
  });
});

describe("registerRemittanceErasers", () => {
  it("registers the `remittance` eraser over the injected hook (in-memory store default)", async () => {
    const registered = new Map<DataClass, DataEraser>();
    const registerEraser = vi.fn((dc: DataClass, e: DataEraser) => registered.set(dc, e));
    registerRemittanceErasers({ registerEraser });
    expect(registerEraser).toHaveBeenCalledOnce();
    const eraser = registered.get(REMITTANCE_DATA_CLASS);
    expect(eraser).toBeDefined();
    // the in-memory slice store counts zero erased (persists nothing) but the eraser EXISTS (not a deny-stub)
    expect(await eraser!.erase({ orgId: "o1" }, "patient-1")).toEqual({ erased: 0 });
  });
});
