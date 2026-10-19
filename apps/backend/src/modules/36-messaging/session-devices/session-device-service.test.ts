// M36 WP 5.5 (ADR-0082) - the service rules over fake ports: own list marks the current session and never leaks tokens/IP/user agent;
// revoke is one transaction (delete + endpoint expiry + audit), a foreign / unknown / repeated revoke is the SAME 404 and writes nothing,
// the socket is closed only AFTER the commit and its failure does not undo the revoke, the admin variant is bounded to the organisation.
import { NotFoundError } from "@wardenx/types";
import { describe, expect, it, vi } from "vitest";
import { createSessionDeviceService } from "./session-device-service";
import type {
  EndpointLinkPort,
  SessionAuditEntry,
  SessionDeviceDeps,
  SessionStorePort,
  StoredSession,
  Tx,
} from "./session-device-types";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-10-19T12:00:00.000Z");

interface Row extends StoredSession {
  readonly orgId: string | null;
  readonly pushLinked: boolean;
}

const row = (id: string, userId: string, over: Partial<Row> = {}): Row => ({
  id,
  userId,
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  createdAt: new Date("2026-10-18T08:00:00.000Z"),
  lastActivityAt: new Date("2026-10-19T11:30:00.000Z"),
  orgId: ORG,
  pushLinked: false,
  ...over,
});

function harness(initial: readonly Row[], opts: { disconnect?: () => Promise<void> } = {}) {
  let rows = [...initial];
  const events: string[] = [];
  const audits: SessionAuditEntry[] = [];
  let expiredFor: string[] = [];
  let committed = 0;

  const sessions: SessionStorePort = {
    async listStaff(_tx, q) {
      return rows.filter(
        (r) => r.userId === q.userId && (q.organizationId === null || r.orgId === q.organizationId),
      );
    },
    async findStaffOwner(_tx, q) {
      return rows.find((r) => r.id === q.sessionId && r.orgId === q.organizationId)?.userId ?? null;
    },
    async deleteStaff(_tx, q) {
      const hit = rows.find(
        (r) =>
          r.id === q.sessionId &&
          r.userId === q.userId &&
          (q.organizationId === null || r.orgId === q.organizationId),
      );
      if (!hit) return false;
      rows = rows.filter((r) => r !== hit);
      events.push("delete");
      return true;
    },
  };
  const endpoints: EndpointLinkPort = {
    async linkedPushSessionIds(_tx, userId, ids) {
      return new Set(
        ids.filter((id) => initial.find((r) => r.id === id && r.userId === userId)?.pushLinked),
      );
    },
    async expireForSession(_tx, _userId, sessionId) {
      events.push("expire");
      expiredFor = [...expiredFor, sessionId];
      return initial.find((r) => r.id === sessionId)?.pushLinked ? 1 : 0;
    },
  };
  const disconnect = vi.fn(async (_sessionId: string) => {
    events.push("disconnect");
    await opts.disconnect?.();
  });
  const warn = vi.fn();
  const deps: SessionDeviceDeps = {
    async transact(_scope, fn) {
      const out = await fn({} as Tx);
      committed += 1;
      events.push("commit");
      return out;
    },
    sessions,
    endpoints,
    async audit(_tx, entry) {
      events.push("audit");
      audits.push(entry);
    },
    disconnectSession: disconnect,
    now: () => NOW,
    warn,
  };
  return {
    service: createSessionDeviceService(deps),
    events,
    audits,
    disconnect,
    warn,
    remaining: () => rows.map((r) => r.id),
    expiredFor: () => expiredFor,
    committed: () => committed,
  };
}

const me = { organizationId: ORG, userId: ME, sessionId: "s-current" };

describe("listOwn", () => {
  it("marks the current session, orders it first, and exposes only the safe fields", async () => {
    const h = harness([
      row("s-old", ME, { lastActivityAt: new Date("2026-10-10T00:00:00.000Z"), pushLinked: true }),
      row("s-current", ME),
      row("s-theirs", THEM),
    ]);
    const { devices } = await h.service.listOwn(me);
    expect(devices.map((d) => d.id)).toEqual(["s-current", "s-old"]);
    expect(devices[0]).toEqual({
      id: "s-current",
      label: "Chrome · macOS",
      current: true,
      created_at: "2026-10-18T08:00:00.000Z",
      last_used_at: "2026-10-19T11:30:00.000Z",
      push_registered: false,
    });
    expect(devices[1]?.current).toBe(false);
    expect(devices[1]?.push_registered).toBe(true);
    const json = JSON.stringify(devices);
    expect(json).not.toMatch(/Mozilla|userAgent|user_agent|token|ip/i);
  });

  it("falls back to the creation time when the session has no activity stamp yet", async () => {
    const h = harness([row("s-current", ME, { lastActivityAt: null })]);
    const { devices } = await h.service.listOwn(me);
    expect(devices[0]?.last_used_at).toBe("2026-10-18T08:00:00.000Z");
  });
});

describe("revokeOwn", () => {
  it("deletes the session, expires its endpoint and audits in one transaction, then closes the socket", async () => {
    const h = harness([row("s-current", ME), row("s-phone", ME, { pushLinked: true })]);
    const out = await h.service.revokeOwn(me, "s-phone");
    expect(out).toEqual({ revoked: true, current: false, push_endpoints_expired: 1 });
    expect(h.events).toEqual(["delete", "expire", "audit", "commit", "disconnect"]);
    expect(h.remaining()).toEqual(["s-current"]);
    expect(h.audits[0]).toMatchObject({
      action: "m36.session.revoked",
      organizationId: ORG,
      actorUserId: ME,
      targetUserId: ME,
      sessionId: "s-phone",
      byAdmin: false,
      current: false,
      endpointsExpired: 1,
    });
  });

  it("says plainly when the revoked session is the current one", async () => {
    const h = harness([row("s-current", ME)]);
    const out = await h.service.revokeOwn(me, "s-current");
    expect(out.current).toBe(true);
    expect(h.disconnect).toHaveBeenCalledWith("s-current");
  });

  it("answers a foreign session exactly like an unknown one, and changes nothing", async () => {
    const h = harness([row("s-theirs", THEM), row("s-current", ME)]);
    const foreign = await h.service.revokeOwn(me, "s-theirs").catch((e: unknown) => e);
    const unknown = await h.service.revokeOwn(me, "s-nope").catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(unknown).toBeInstanceOf(NotFoundError);
    expect((foreign as Error).message.replace("s-theirs", "X")).toBe(
      (unknown as Error).message.replace("s-nope", "X"),
    );
    expect(h.remaining()).toEqual(["s-theirs", "s-current"]);
    expect(h.audits).toEqual([]);
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it("is a 404 on a repeat (the row is gone), with no second audit row or disconnect", async () => {
    const h = harness([row("s-phone", ME)]);
    await h.service.revokeOwn(me, "s-phone");
    await expect(h.service.revokeOwn(me, "s-phone")).rejects.toBeInstanceOf(NotFoundError);
    expect(h.audits).toHaveLength(1);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
  });

  it("still reports the revoke when the socket close fails (the session is already dead; the recheck is the backstop)", async () => {
    const h = harness([row("s-phone", ME)], {
      disconnect: async () => {
        throw new Error("valkey down");
      },
    });
    const out = await h.service.revokeOwn(me, "s-phone");
    expect(out.revoked).toBe(true);
    expect(h.warn).toHaveBeenCalledWith("session_revoke_socket_close_failed", expect.any(Object));
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("valkey down");
  });

  it("does not run the socket close when the transaction fails", async () => {
    const h = harness([row("s-phone", ME)]);
    const failing = createSessionDeviceService({
      ...({} as SessionDeviceDeps),
      transact: async () => {
        throw new Error("db down");
      },
      sessions: {} as SessionStorePort,
      endpoints: {} as EndpointLinkPort,
      audit: async () => {},
      disconnectSession: h.disconnect,
    });
    await expect(failing.revokeOwn(me, "s-phone")).rejects.toThrow("db down");
    expect(h.disconnect).not.toHaveBeenCalled();
  });
});

describe("admin variant", () => {
  it("lists only the target's sessions bound to the admin's organisation, and audits the read", async () => {
    const h = harness([
      row("s-a", THEM),
      row("s-other-org", THEM, { orgId: OTHER_ORG }),
      row("s-pre-org", THEM, { orgId: null }),
    ]);
    const { devices } = await h.service.listForUser(me, THEM);
    expect(devices.map((d) => d.id)).toEqual(["s-a"]);
    expect(devices[0]?.current).toBe(false);
    expect(h.audits[0]).toMatchObject({
      action: "m36.session.admin_listed",
      actorUserId: ME,
      targetUserId: THEM,
      byAdmin: true,
    });
  });

  it("returns an empty list (not an error) for a user with nothing in this organisation", async () => {
    const h = harness([row("s-other-org", THEM, { orgId: OTHER_ORG })]);
    expect((await h.service.listForUser(me, THEM)).devices).toEqual([]);
  });

  it("revokes another user's session in the organisation: audited with actor and target, socket closed", async () => {
    const h = harness([row("s-a", THEM, { pushLinked: true })]);
    const out = await h.service.revokeForUser(me, "s-a");
    expect(out).toEqual({ revoked: true, current: false, push_endpoints_expired: 1 });
    expect(h.audits[0]).toMatchObject({
      action: "m36.session.revoked",
      actorUserId: ME,
      targetUserId: THEM,
      byAdmin: true,
    });
    expect(h.disconnect).toHaveBeenCalledWith("s-a");
  });

  it("refuses a session of another organisation or pre-org session as 404 and writes nothing", async () => {
    const h = harness([
      row("s-other-org", THEM, { orgId: OTHER_ORG }),
      row("s-pre-org", THEM, { orgId: null }),
    ]);
    await expect(h.service.revokeForUser(me, "s-other-org")).rejects.toBeInstanceOf(NotFoundError);
    await expect(h.service.revokeForUser(me, "s-pre-org")).rejects.toBeInstanceOf(NotFoundError);
    expect(h.remaining()).toEqual(["s-other-org", "s-pre-org"]);
    expect(h.audits).toEqual([]);
    expect(h.disconnect).not.toHaveBeenCalled();
  });
});
