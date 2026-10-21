// GAP-107 — the early-exit branches of M37's overlay writer/retirer that need no database. The insert,
// idempotency, cross-tenant and gate behaviour are proven on real Postgres in
// `m37-iv-safety-overlay.live.test.ts`.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import {
  type IvOverlayOrderFacts,
  buildM37IvOverlayOnOrderEndedConsumer,
  buildM37IvOverlayOnOrderSignedConsumer,
} from "../src/modules/37-ipu/consumers/m12-medication-order-iv-overlay";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const db = {} as DbClient; // never reached on these paths: any DB use would throw on `{}`

const order = (over: Partial<IvOverlayOrderFacts> = {}): IvOverlayOrderFacts => ({
  orderId: ORDER,
  patientId: "p",
  admissionId: "a",
  route: "oral",
  drugName: "morphine",
  rxnormRxcui: null,
  sigStructured: {},
  ...over,
});

const signed = (orderContext: (o: string, id: string) => Promise<IvOverlayOrderFacts | null>) =>
  buildM37IvOverlayOnOrderSignedConsumer({
    db,
    outbox: { publish: vi.fn(async () => {}) },
    orderContext,
  });

const ev = (organizationId: string, payload: unknown) => ({ id: "e", organizationId, payload });

describe("M37 IV overlay writer — no-DB branches", () => {
  it("binds exactly m12.medication_order.signed", () => {
    expect(signed(async () => null).eventTypes).toEqual(["m12.medication_order.signed"]);
  });

  it("is a no-op for an order that is not a continuous infusion (no DB touched)", async () => {
    const orderContext = vi.fn(async () => order({ route: "oral" }));
    await expect(signed(orderContext).handle(ev(ORG, { orderId: ORDER }))).resolves.toBeUndefined();
    expect(orderContext).toHaveBeenCalledWith(ORG, ORDER);
  });

  it("resolves the order in the ENVELOPE's org, not one named in the payload", async () => {
    const orderContext = vi.fn(async () => order());
    await signed(orderContext).handle(ev(ORG, { orderId: ORDER, organizationId: "evil" }));
    expect(orderContext).toHaveBeenCalledWith(ORG, ORDER);
  });

  it("throws on an order it cannot resolve (dead-letter, never a silently skipped overlay)", async () => {
    await expect(signed(async () => null).handle(ev(ORG, { orderId: ORDER }))).rejects.toThrow(
      /does not resolve/,
    );
  });

  it("throws on a malformed payload or a missing organization", async () => {
    const c = signed(async () => order());
    await expect(c.handle(ev(ORG, {}))).rejects.toThrow(/orderId/);
    await expect(c.handle(ev(ORG, null))).rejects.toThrow(/orderId/);
    await expect(c.handle(ev("", { orderId: ORDER }))).rejects.toThrow(/organization/);
  });
});

describe("M37 IV overlay retirer — no-DB branches", () => {
  const ended = buildM37IvOverlayOnOrderEndedConsumer({ db });

  it("binds the discontinued and completed events", () => {
    expect(ended.eventTypes).toEqual([
      "m12.medication_order.discontinued",
      "m12.medication_order.completed",
    ]);
  });

  it("throws on a malformed payload or a missing organization", async () => {
    await expect(ended.handle(ev(ORG, {}))).rejects.toThrow(/orderId/);
    await expect(ended.handle(ev("", { orderId: ORDER }))).rejects.toThrow(/organization/);
  });
});
