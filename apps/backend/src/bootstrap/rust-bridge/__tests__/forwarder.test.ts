// CW-RUST-M02 P1 — the shadow/serve forwarder, the Rust client and header hygiene (AT-M02-04 header, 09, 10 unit
// level; the end-to-end versions run on the local Bun+Rust stack).
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, type RustCallResult, type RustClient, createRustClient } from "../client";
import { parseRustBridgeConfig } from "../config";
import {
  type BridgeLogger,
  CIRCUIT_FAILURES_TO_OPEN,
  CIRCUIT_OPEN_MS,
  type MePermissionsBridgeInput,
  SERVE_MAX_IN_FLIGHT,
  SHADOW_MAX_IN_FLIGHT,
  createMePermissionsBridge,
} from "../forwarder";
import { applyAssertionHeaderHygiene } from "../header-hygiene";
import type { AssertionSigner } from "../signer";

const KEY = `k1=${Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 3)]).toString("base64url")}`;
const ACTOR = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  sessionId: "s-1",
  sessionClass: "staff",
  requestId: "r-1",
};
const SECRET_KEYS = ["patient.read", "visit.read", "encounter.read", "role.manage"];

function capture(): BridgeLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (o, m) => lines.push(JSON.stringify({ ...o, m })),
    warn: (o, m) => lines.push(JSON.stringify({ ...o, m })),
  };
}

const signer: AssertionSigner = { sign: () => "signed.token.value" };
const okBody = (permissions: string[]): RustCallResult => ({
  ok: true,
  status: 200,
  contentType: "application/json",
  body: { permissions },
});

function setup(mode: "shadow" | "serve", client: RustClient, routes = "me-permissions") {
  const logger = capture();
  const bridge = createMePermissionsBridge({
    config: parseRustBridgeConfig({
      RUST_ROUTES: routes,
      RUST_ROUTE_MODE: mode,
      CW_ACTOR_SIGNING_KEY: KEY,
    }),
    signer,
    client,
    logger,
  });
  return { bridge, logger };
}

/** Input whose afterResponse callbacks are collected so the test decides when "the response is sent". */
function input(over: Partial<MePermissionsBridgeInput> = {}) {
  const after: (() => void)[] = [];
  let bunCalls = 0;
  const i: MePermissionsBridgeInput = {
    actor: ACTOR,
    bun: async () => {
      bunCalls++;
      return { permissions: ["patient.read", "visit.read"] };
    },
    fresh: async () => ({ permissions: ["patient.read", "visit.read"] }),
    afterResponse: (cb) => after.push(cb),
    ...over,
  };
  return {
    i,
    flush: async () => {
      for (const cb of after.splice(0)) cb();
      await new Promise((r) => setTimeout(r, 5));
    },
    bunCalls: () => bunCalls,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("route not enabled / not forwardable", () => {
  it("calls only Bun when the route is not in RUST_ROUTES", async () => {
    let called = false;
    const { bridge } = setup(
      "serve",
      {
        get: async () => {
          called = true;
          return okBody([]);
        },
      },
      "",
    );
    const t = input();
    expect(await bridge.handle(t.i)).toEqual({ permissions: ["patient.read", "visit.read"] });
    expect(called).toBe(false);
  });

  it.each([
    [{ userId: "system" }],
    [{ organizationId: "not-a-uuid" }],
    [{ sessionId: "" }],
    [{ sessionClass: "" }],
  ])("serves Bun and never forwards a non-forwardable actor %j", async (patch) => {
    let called = false;
    const { bridge } = setup("serve", {
      get: async () => {
        called = true;
        return okBody([]);
      },
    });
    const t = input({ actor: { ...ACTOR, ...patch } });
    expect((await bridge.handle(t.i)).permissions).toEqual(["patient.read", "visit.read"]);
    expect(called).toBe(false);
    expect(bridge.stats().skipped).toBe(1);
  });
});

describe("shadow", () => {
  it("returns Bun's answer and calls Rust only after the response is sent", async () => {
    let calls = 0;
    const { bridge } = setup("shadow", {
      get: async () => {
        calls++;
        return okBody(["visit.read", "patient.read"]);
      },
    });
    const t = input();
    expect(await bridge.handle(t.i)).toEqual({ permissions: ["patient.read", "visit.read"] });
    await tick();
    expect(calls).toBe(0);
    await t.flush();
    expect(calls).toBe(1);
    expect(bridge.stats().match).toBe(1);
  });

  it("classifies a difference explained by the fresh (uncached) resolution as stale-cache", async () => {
    const { bridge } = setup("shadow", {
      get: async () => okBody(["patient.read", "visit.read", "role.manage"]),
    });
    const t = input({
      fresh: async () => ({ permissions: ["role.manage", "patient.read", "visit.read"] }),
    });
    await bridge.handle(t.i);
    await t.flush();
    expect(bridge.stats()).toMatchObject({ staleCache: 1, unexplained: 0 });
  });

  it("reports an unexplained difference with counts only, never a key", async () => {
    const { bridge, logger } = setup("shadow", {
      get: async () => okBody(["patient.read", "encounter.read", "role.manage"]),
    });
    const t = input();
    await bridge.handle(t.i);
    await t.flush();
    expect(bridge.stats().unexplained).toBe(1);
    const line = logger.lines.find((l) => l.includes("unexplained"));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toMatchObject({
      only_bun: 1,
      only_rust: 2,
      user_id: ACTOR.userId,
    });
    for (const k of SECRET_KEYS) expect(logger.lines.join("\n")).not.toContain(k);
    expect(logger.lines.join("\n")).not.toContain("signed.token.value");
  });

  it("records a Rust error without affecting the response", async () => {
    const { bridge } = setup("shadow", { get: async () => ({ ok: false, reason: "connect" }) });
    const t = input();
    expect((await bridge.handle(t.i)).permissions).toHaveLength(2);
    await t.flush();
    expect(bridge.stats().rustError).toBe(1);
  });

  it(`never has more than ${SHADOW_MAX_IN_FLIGHT} in flight and drops (not queues) the rest`, async () => {
    const pending: ((r: RustCallResult) => void)[] = [];
    const { bridge } = setup("shadow", { get: () => new Promise((res) => pending.push(res)) });
    const runs = Array.from({ length: 20 }, () => input());
    for (const r of runs) await bridge.handle(r.i);
    for (const r of runs) await r.flush();
    expect(bridge.inFlight()).toBe(SHADOW_MAX_IN_FLIGHT);
    expect(bridge.stats().dropped).toBe(20 - SHADOW_MAX_IN_FLIGHT);
    for (const res of pending) res(okBody(["patient.read", "visit.read"]));
    await tick();
    expect(bridge.inFlight()).toBe(0);
    expect(bridge.stats().match).toBe(SHADOW_MAX_IN_FLIGHT);
  });
});

describe("serve", () => {
  it("returns Rust's validated body without calling Bun", async () => {
    const { bridge } = setup("serve", { get: async () => okBody(["encounter.read"]) });
    const t = input();
    expect(await bridge.handle(t.i)).toEqual({ permissions: ["encounter.read"] });
    expect(t.bunCalls()).toBe(0);
    expect(bridge.stats().served).toBe(1);
  });

  it.each<[string, RustCallResult | "throw-sign"]>([
    ["connect", { ok: false, reason: "connect" }],
    ["timeout", { ok: false, reason: "timeout" }],
    ["bad_json", { ok: false, reason: "bad_json" }],
    [
      "status",
      {
        ok: true,
        status: 401,
        contentType: "application/json",
        body: { error: { code: "UNAUTHORIZED" } },
      },
    ],
    [
      "status",
      { ok: true, status: 500, contentType: "application/json", body: { permissions: [] } },
    ],
    [
      "content_type",
      { ok: true, status: 200, contentType: "text/plain", body: { permissions: [] } },
    ],
    ["content_type", { ok: true, status: 200, contentType: null, body: { permissions: [] } }],
    [
      "schema",
      {
        ok: true,
        status: 200,
        contentType: "application/json",
        body: { permissions: [], extra: 1 },
      },
    ],
    [
      "schema",
      { ok: true, status: 200, contentType: "application/json", body: { permissions: ["a", "a"] } },
    ],
    [
      "schema",
      { ok: true, status: 200, contentType: "application/json", body: { permissions: [1] } },
    ],
    ["schema", { ok: true, status: 200, contentType: "application/json", body: ["a"] }],
    ["schema", { ok: true, status: 200, contentType: "application/json", body: null }],
    ["sign", "throw-sign"],
  ])("falls back to Bun on %s", async (reason, result) => {
    const logger = capture();
    const bridge = createMePermissionsBridge({
      config: parseRustBridgeConfig({
        RUST_ROUTES: "me-permissions",
        RUST_ROUTE_MODE: "serve",
        CW_ACTOR_SIGNING_KEY: KEY,
      }),
      signer:
        result === "throw-sign"
          ? {
              sign: () => {
                throw new Error("x");
              },
            }
          : signer,
      client: { get: async () => (result === "throw-sign" ? okBody([]) : result) },
      logger,
    });
    const t = input();
    expect(await bridge.handle(t.i)).toEqual({ permissions: ["patient.read", "visit.read"] });
    expect(t.bunCalls()).toBe(1);
    expect(bridge.stats().fallback[reason]).toBe(1);
    expect(logger.lines.join("\n")).toContain(`fallback:${reason}`);
  });

  it("accepts application/json with a charset parameter", async () => {
    const { bridge } = setup("serve", {
      get: async () => ({
        ok: true,
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: { permissions: [] },
      }),
    });
    expect(await bridge.handle(input().i)).toEqual({ permissions: [] });
  });
});

describe("createRustClient", () => {
  const fetchOk = async () =>
    new Response(JSON.stringify({ permissions: [] }), {
      headers: { "content-type": "application/json" },
    });

  it("dials the socket with the assertion header and returns status, type and body", async () => {
    let seen: { url: string; init: RequestInit & { unix: string } } | undefined;
    const client = createRustClient("/run/x.sock", 300, async (url, init) => {
      seen = { url, init };
      return fetchOk();
    });
    expect(await client.get("/api/v1/me/permissions", "tok")).toEqual({
      ok: true,
      status: 200,
      contentType: "application/json",
      body: { permissions: [] },
    });
    expect(seen?.init.unix).toBe("/run/x.sock");
    expect(seen?.url).toBe("http://localhost/api/v1/me/permissions");
    expect(new Headers(seen?.init.headers).get("x-cw-actor-assertion")).toBe("tok");
  });

  it("maps a refused connection, a timeout and a non-JSON body to reasons, never a throw", async () => {
    expect(
      await createRustClient("/s", 300, async () => {
        throw new Error("ECONNREFUSED");
      }).get("/p", "t"),
    ).toEqual({
      ok: false,
      reason: "connect",
    });
    const slow = createRustClient(
      "/s",
      20,
      (_u, init) =>
        new Promise((_res, rej) =>
          init.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        ),
    );
    expect(await slow.get("/p", "t")).toEqual({ ok: false, reason: "timeout" });
    expect(
      await createRustClient("/s", 300, async () => new Response("<html>")).get("/p", "t"),
    ).toEqual({
      ok: false,
      reason: "bad_json",
    });
  });
});

describe("applyAssertionHeaderHygiene", () => {
  it("deletes a client-supplied X-CW-Actor-Assertion, in any casing, before any other hook or handler", async () => {
    const app = Fastify();
    applyAssertionHeaderHygiene(app);
    let seenInHook: unknown = "unset";
    app.addHook("onRequest", async (req) => {
      seenInHook = req.headers["x-cw-actor-assertion"];
    });
    app.get("/echo", async (req) => ({ present: "x-cw-actor-assertion" in req.headers }));
    for (const name of ["X-CW-Actor-Assertion", "x-cw-actor-assertion", "X-Cw-Actor-Assertion"]) {
      const res = await app.inject({
        method: "GET",
        url: "/echo",
        headers: { [name]: "forged.token.sig" },
      });
      expect(res.json()).toEqual({ present: false });
      expect(seenInHook).toBeUndefined();
    }
    await app.close();
  });
});

describe("review round 1 hardening", () => {
  const serveCfg = () =>
    parseRustBridgeConfig({
      RUST_ROUTES: "me-permissions",
      RUST_ROUTE_MODE: "serve",
      CW_ACTOR_SIGNING_KEY: KEY,
    });

  it("falls back to Bun when the client throws instead of returning a reason", async () => {
    const bridge = createMePermissionsBridge({
      config: serveCfg(),
      signer,
      client: {
        get: async () => {
          throw new Error("boom");
        },
      },
      logger: capture(),
    });
    const t = input();
    expect(await bridge.handle(t.i)).toEqual({ permissions: ["patient.read", "visit.read"] });
    expect(bridge.stats().fallback.connect).toBe(1);
    bridge.close();
  });

  it("opens the circuit after consecutive failures, answers from Bun meanwhile, then retries", async () => {
    let now = 1_000;
    let calls = 0;
    const bridge = createMePermissionsBridge({
      config: serveCfg(),
      signer,
      client: {
        get: async () => {
          calls++;
          return { ok: false, reason: "timeout" };
        },
      },
      logger: capture(),
      nowMs: () => now,
    });
    for (let i = 0; i < CIRCUIT_FAILURES_TO_OPEN; i++) await bridge.handle(input().i);
    expect(calls).toBe(CIRCUIT_FAILURES_TO_OPEN);
    await bridge.handle(input().i);
    expect(calls).toBe(CIRCUIT_FAILURES_TO_OPEN);
    expect(bridge.stats().fallback.circuit_open).toBe(1);
    now += CIRCUIT_OPEN_MS + 1;
    await bridge.handle(input().i);
    expect(calls).toBe(CIRCUIT_FAILURES_TO_OPEN + 1);
    bridge.close();
  });

  it(`sends at most ${SERVE_MAX_IN_FLIGHT} serve calls at once and answers the rest from Bun immediately`, async () => {
    const pending: ((r: RustCallResult) => void)[] = [];
    const bridge = createMePermissionsBridge({
      config: serveCfg(),
      signer,
      client: { get: () => new Promise((res) => pending.push(res)) },
      logger: capture(),
    });
    const inflight = Array.from({ length: SERVE_MAX_IN_FLIGHT }, () => bridge.handle(input().i));
    await tick();
    expect(await bridge.handle(input().i)).toEqual({ permissions: ["patient.read", "visit.read"] });
    expect(bridge.stats().fallback.busy).toBe(1);
    for (const res of pending) res(okBody(["x"]));
    await Promise.all(inflight);
    expect(bridge.inFlight()).toBe(0);
    bridge.close();
  });

  it("never signs a request-path actor carrying the reserved sweep class", async () => {
    let signed = 0;
    const bridge = createMePermissionsBridge({
      config: serveCfg(),
      signer: {
        sign: () => {
          signed++;
          return "t";
        },
      },
      client: { get: async () => okBody([]) },
      logger: capture(),
    });
    await bridge.handle(input({ actor: { ...ACTOR, sessionClass: "parity-sweep" } }).i);
    expect(signed).toBe(0);
    expect(bridge.stats().skipped).toBe(1);
    bridge.close();
  });
});

describe("createRustClient body cap", () => {
  it("refuses an oversized body by declared length and by actual length", async () => {
    const big = JSON.stringify({ permissions: ["x".repeat(MAX_BODY_BYTES)] });
    const declared = createRustClient(
      "/s",
      300,
      async () =>
        new Response("{}", {
          headers: {
            "content-length": String(MAX_BODY_BYTES + 1),
            "content-type": "application/json",
          },
        }),
    );
    expect(await declared.get("/p", "t")).toEqual({ ok: false, reason: "bad_json" });
    const actual = createRustClient(
      "/s",
      300,
      async () => new Response(big, { headers: { "content-type": "application/json" } }),
    );
    expect(await actual.get("/p", "t")).toEqual({ ok: false, reason: "bad_json" });
  });
});
