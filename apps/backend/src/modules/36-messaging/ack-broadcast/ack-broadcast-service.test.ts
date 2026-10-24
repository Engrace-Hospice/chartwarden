// M36 WP 6.8 (ADR-0097) - unit tests: the pure state rule, and the route's flag-first ordering with a fake service.
import { ACK_BROADCAST_FLAG_KEY } from "@chartwarden/types";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createAckBroadcastService, classifyRecipient } from "./ack-broadcast-service";

describe("classifyRecipient", () => {
  const at = new Date("2026-10-23T10:00:00Z");
  it("acknowledged wins over everything else", () => {
    expect(classifyRecipient({ acknowledgedAt: at, eligible: false, openedAt: null })).toBe("acknowledged");
  });
  it("a recipient who is no longer active is ineligible, not a silent non-reader", () => {
    expect(classifyRecipient({ acknowledgedAt: null, eligible: false, openedAt: at })).toBe("ineligible");
  });
  it("opening alone leaves the person pending as 'opened'", () => {
    expect(classifyRecipient({ acknowledgedAt: null, eligible: true, openedAt: at })).toBe("opened");
  });
  it("never opened is 'not_opened'", () => {
    expect(classifyRecipient({ acknowledgedAt: null, eligible: true, openedAt: null })).toBe("not_opened");
  });
});

describe("createAckBroadcastService.enabled", () => {
  const db = {} as never;
  it("is off without a flag reader and when the key is absent or false", async () => {
    expect(await createAckBroadcastService({ db }).enabled("o")).toBe(false);
    for (const flags of [{} as Record<string, boolean>, { [ACK_BROADCAST_FLAG_KEY]: false }]) {
      expect(await createAckBroadcastService({ db, flags: { forOrg: async () => flags } }).enabled("o")).toBe(false);
    }
  });
  it("is on only for an explicit true, and is read on every call", async () => {
    const forOrg = vi.fn(async () => ({ [ACK_BROADCAST_FLAG_KEY]: true }));
    const service = createAckBroadcastService({ db, flags: { forOrg } });
    expect(await service.enabled("o")).toBe(true);
    await service.enabled("o");
    expect(forOrg).toHaveBeenCalledTimes(2);
  });
});

describe("ack broadcast routes: flag before parse", () => {
  it("flag off answers 404 for a malformed id and a malformed query, and never reaches the service", async () => {
    vi.resetModules();
    vi.doMock("@chartwarden/auth", () => ({ requirePermission: () => async () => undefined }));
    const { registerAckBroadcastRoutes } = await import("../routes/ack-broadcast-routes");
    const service = {
      enabled: async () => false,
      create: vi.fn(),
      detail: vi.fn(),
      list: vi.fn(),
      mine: vi.fn(),
      acknowledge: vi.fn(),
    };
    const app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (req) => {
      (req as unknown as { context: unknown }).context = { organizationId: "o", userId: "u" };
    });
    app.setErrorHandler((err, _req, reply) => {
      void reply.code((err as { statusCode?: number }).statusCode ?? 500).send({ code: (err as { code?: string }).code });
    });
    registerAckBroadcastRoutes(app, { service });
    const bad = await app.inject({ method: "GET", url: "/api/v1/messaging/announcements/zzz/ack-broadcast?limit=-1" });
    const ack = await app.inject({ method: "POST", url: "/api/v1/messaging/announcements/zzz/ack" });
    expect([bad.statusCode, ack.statusCode]).toEqual([404, 404]);
    expect(service.detail).not.toHaveBeenCalled();
    expect(service.acknowledge).not.toHaveBeenCalled();
    vi.doUnmock("@chartwarden/auth");
    await app.close();
  });
});
