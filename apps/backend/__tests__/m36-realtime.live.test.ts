/**
 * ADR-0054 / WP 1.1 — the Socket.IO transport against a real Valkey, across TWO server instances sharing it.
 * Needs WARDENX_TEST_REDIS_URL (a private valkey/valkey:8 container). No Postgres: authentication and rooms are
 * injected exactly as the composition root injects them, so this proves the transport rules, not the session store.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { userRoom } from "@chartwarden/messaging";
import { Redis } from "ioredis";
import { type Socket, io as connect } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RealtimeHandle,
  type RealtimePrincipal,
  createRealtimeEmitter,
  startRealtimeServer,
} from "../src/bootstrap/realtime";

const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
const ORIGIN = "https://app.wardenx.test";
const ORG_ID = "org_1";
const HINT = { kind: "message.new", cursor: "c1", ids: { channelId: "ch_1", messageId: "msg_1" } };

const PRINCIPALS: Record<string, RealtimePrincipal> = {
  tok_u1: { userId: "u1", organizationId: "org_1", sessionId: "s_u1" },
  tok_u2: { userId: "u2", organizationId: "org_1", sessionId: "s_u2" },
  tok_dead: { userId: "u3", organizationId: "org_1", sessionId: "s_dead" },
};
const tokenOf = (cookie: string | undefined) =>
  /session_token=([^;]+)/.exec(cookie ?? "")?.[1] ?? "";

describe.skipIf(!REDIS_URL)("M36 realtime transport — LIVE Valkey, two nodes", () => {
  const redis: Redis[] = [];
  const servers: Server[] = [];
  const handles: RealtimeHandle[] = [];
  const clients: Socket[] = [];
  const urls: string[] = [];
  let emitter: ReturnType<typeof createRealtimeEmitter>;
  let aliveSessions: Set<string>;

  const newRedis = () => {
    const r = new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
    r.on("error", () => {});
    redis.push(r);
    return r;
  };

  async function node(
    options: { max?: number; perSession?: number } = {},
  ): Promise<{ url: string; handle: RealtimeHandle; pub: Redis; sub: Redis }> {
    const httpServer = createServer();
    servers.push(httpServer);
    const pub = newRedis();
    const sub = pub.duplicate();
    sub.on("error", () => {});
    redis.push(sub);
    const handle = startRealtimeServer({
      httpServer,
      pubClient: pub,
      subClient: sub,
      trustedOrigins: [ORIGIN],
      maxSocketsPerUser: options.max ?? 8,
      recheckIntervalMs: 150,
      ...(options.perSession ? { handshakesPerSessionPerMinute: options.perSession } : {}),
      authenticate: async (headers) => PRINCIPALS[tokenOf(headers.cookie)] ?? null,
      resolveRooms: async (p) => [userRoom(p.organizationId, p.userId), `org:${p.organizationId}`],
      stillValid: async (p) => aliveSessions.has(p.sessionId),
    });
    handles.push(handle);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`,
      handle,
      pub,
      sub,
    };
  }

  const open = (url: string, token: string, origin: string | undefined = ORIGIN) => {
    const socket = connect(url, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: {
        cookie: `better-auth.session_token=${token}; junk=${Math.random()}; session_token_x=${Math.random()}`, // junk varies per request: must not mint a new throttle bucket
        ...(origin ? { origin } : {}),
      },
    });
    clients.push(socket);
    return socket;
  };
  const connected = (s: Socket) =>
    new Promise<void>((resolve, reject) => {
      s.once("connect", () => resolve());
      s.once("connect_error", (e) => reject(e));
    });
  const refused = (s: Socket) =>
    new Promise<string>((resolve) => s.once("connect_error", (e) => resolve(e.message)));
  const disconnected = (s: Socket) =>
    new Promise<void>((resolve) => s.once("disconnect", () => resolve()));
  const nextHint = (s: Socket, ms = 1500) =>
    new Promise<unknown>((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      s.once("hint", (h) => {
        clearTimeout(t);
        resolve(h);
      });
    });
  const settle = () => new Promise((r) => setTimeout(r, 250)); // let the adapter subscriptions land

  beforeAll(async () => {
    aliveSessions = new Set(["s_u1", "s_u2", "s_dead"]);
    emitter = createRealtimeEmitter(newRedis());
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    for (const h of handles) await h.close();
    for (const s of servers) s.close();
    for (const r of redis) r.disconnect();
  });

  it("refuses an unauthenticated handshake and a foreign Origin; accepts an absent Origin (non-browser)", async () => {
    const { url } = await node();
    expect(await refused(open(url, "nope"))).toMatch(/unauthorized|xhr poll|websocket/i);
    expect(await refused(open(url, "tok_u1", "https://evil.example"))).toBeTruthy();
    const ok = open(url, "tok_u1", undefined);
    await connected(ok);
  });

  it("delivers a hint to the addressed user on either node, and to nobody else", async () => {
    const a = await node();
    const b = await node();
    const u1a = open(a.url, "tok_u1");
    const u1b = open(b.url, "tok_u1");
    const u2 = open(b.url, "tok_u2");
    await Promise.all([connected(u1a), connected(u1b), connected(u2)]);
    await settle();

    const got = [nextHint(u1a), nextHint(u1b), nextHint(u2, 600)];
    await emitter.emit([userRoom(ORG_ID, "u1")], "hint", HINT);
    const [h1, h2, h3] = await Promise.all(got);
    expect(h1).toEqual(HINT);
    expect(h2).toEqual(HINT); // cross-node
    expect(h3).toBeNull(); // another user in the same org
  });

  it("refuses a flood of handshakes on one session cookie before any authentication work", async () => {
    const a = await node({ perSession: 3 });
    const attempts = Array.from({ length: 6 }, () => open(a.url, "tok_u2"));
    const results = await Promise.allSettled(attempts.map((s) => connected(s)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
  });

  it("ignores a client trying to choose its own room", async () => {
    const a = await node();
    const u2 = open(a.url, "tok_u2");
    await connected(u2);
    for (const evt of ["join", "subscribe", "join_room"]) u2.emit(evt, userRoom(ORG_ID, "u1"));
    await settle();
    const got = nextHint(u2, 600);
    await emitter.emit([userRoom(ORG_ID, "u1")], "hint", HINT);
    expect(await got).toBeNull();
  });

  it("drops a user's sockets on every node when the worker disconnects their room (<= 5 s)", async () => {
    const a = await node();
    const b = await node();
    const u1a = open(a.url, "tok_u1");
    const u1b = open(b.url, "tok_u1");
    const u2 = open(b.url, "tok_u2");
    await Promise.all([connected(u1a), connected(u1b), connected(u2)]);
    await settle();
    const started = Date.now();
    const down = Promise.all([disconnected(u1a), disconnected(u1b)]);
    await emitter.disconnectRoom(userRoom(ORG_ID, "u1"));
    await down;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(u2.connected).toBe(true); // another user is untouched
  });

  it("disconnects a socket whose session has ended, without any socket activity extending it", async () => {
    const a = await node();
    const dead = open(a.url, "tok_dead");
    await connected(dead);
    aliveSessions.delete("s_dead");
    await disconnected(dead);
    aliveSessions.add("s_dead");
  });

  it("caps connections per user", async () => {
    const a = await node({ max: 2 });
    const one = open(a.url, "tok_u1");
    const two = open(a.url, "tok_u1");
    await Promise.all([connected(one), connected(two)]);
    const three = open(a.url, "tok_u1");
    await disconnected(three);
    expect(one.connected && two.connected).toBe(true);
  });

  it("reports degraded when the adapter's Valkey connections are gone", async () => {
    const a = await node();
    await settle();
    expect(a.handle.state()).toBe("ready");
    a.pub.disconnect();
    a.sub.disconnect();
    await settle();
    expect(a.handle.state()).toBe("degraded");
  });
});
