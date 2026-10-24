// M36 WP 6.8 (ADR-0097) - unit tests: the pure state rule, and the route's flag-first ordering with a fake service.
import { ACK_BROADCAST_FLAG_KEY } from "@chartwarden/types";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  classifyRecipient,
  createAckBroadcastService,
  isPastDeadline,
  parseDeadline,
} from "./ack-broadcast-service";

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
      withdraw: vi.fn(),
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

describe("ack broadcast routes: unreadable flag fails closed", () => {
  it("a flag reader that throws answers the uniform 404 and never reaches the service", async () => {
    vi.resetModules();
    vi.doMock("@chartwarden/auth", () => ({ requirePermission: () => async () => undefined }));
    const { registerAckBroadcastRoutes } = await import("../routes/ack-broadcast-routes");
    const service = {
      enabled: async () => {
        throw new Error("flag store down");
      },
      create: vi.fn(),
      withdraw: vi.fn(),
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
    const res = await app.inject({ method: "GET", url: "/api/v1/messaging/ack-broadcasts" });
    expect(res.statusCode).toBe(404);
    expect(service.list).not.toHaveBeenCalled();
    vi.doUnmock("@chartwarden/auth");
    await app.close();
  });
});

describe("parseDeadline (ADR-0097 D13)", () => {
  const now = new Date("2026-10-23T10:00:00Z");
  const code = (fn: () => unknown): string => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return `${(e as { statusCode?: number }).statusCode}:${(e as { code?: string }).code}`;
    }
  };
  it("no deadline is null", () => {
    expect(parseDeadline(undefined, now)).toBeNull();
  });
  it("accepts an instant between the minimum lead and the maximum horizon", () => {
    expect(parseDeadline("2026-10-24T10:00:00Z", now)?.toISOString()).toBe("2026-10-24T10:00:00.000Z");
  });
  it("refuses unparseable, past, too-soon and too-far deadlines with a typed 422", () => {
    for (const raw of ["tomorrow", "2026-10-23T09:00:00Z", "2026-10-23T10:01:00Z", "2027-06-01T10:00:00Z"]) {
      expect(code(() => parseDeadline(raw, now))).toBe("422:ACK_BROADCAST_DEADLINE_INVALID");
    }
  });
});

describe("isPastDeadline: a marker only (ADR-0097 D13)", () => {
  const now = new Date("2026-10-23T10:00:00Z");
  const past = new Date("2026-10-23T09:00:00Z");
  const future = new Date("2026-10-23T11:00:00Z");
  it("is true only when the deadline passed, nothing was withdrawn and somebody eligible is still pending", () => {
    expect(isPastDeadline({ deadlineAt: past, withdrawnAt: null, pending: 2 }, now)).toBe(true);
    expect(isPastDeadline({ deadlineAt: future, withdrawnAt: null, pending: 2 }, now)).toBe(false);
    expect(isPastDeadline({ deadlineAt: null, withdrawnAt: null, pending: 2 }, now)).toBe(false);
    expect(isPastDeadline({ deadlineAt: past, withdrawnAt: past, pending: 2 }, now)).toBe(false);
    expect(isPastDeadline({ deadlineAt: past, withdrawnAt: null, pending: 0 }, now)).toBe(false);
  });
});

describe("ack broadcast routes: withdraw is flag-first and creator-keyed", () => {
  it("flag off answers 404 for a malformed id and never reaches the service; flag on passes only the caller's own id", async () => {
    vi.resetModules();
    vi.doMock("@chartwarden/auth", () => ({ requirePermission: () => async () => undefined }));
    const { registerAckBroadcastRoutes } = await import("../routes/ack-broadcast-routes");
    const withdraw = vi.fn(async () => {
      throw Object.assign(new Error("x"), { statusCode: 404 });
    });
    let on = false;
    const service = {
      enabled: async () => on,
      create: vi.fn(),
      withdraw,
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
    const off = await app.inject({ method: "POST", url: "/api/v1/messaging/announcements/zzz/ack-broadcast/withdraw" });
    expect(off.statusCode).toBe(404);
    expect(withdraw).not.toHaveBeenCalled();
    on = true;
    const id = "11111111-1111-4111-8111-111111111111";
    await app.inject({
      method: "POST",
      url: `/api/v1/messaging/announcements/${id}/ack-broadcast/withdraw`,
      payload: { userId: "someone-else" },
    });
    expect(withdraw).toHaveBeenCalledWith("o", { userId: "u", messageId: id });
    vi.doUnmock("@chartwarden/auth");
    await app.close();
  });
});
