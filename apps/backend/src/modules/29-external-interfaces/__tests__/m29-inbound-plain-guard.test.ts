// F-182 (#248) — an INBOUND `mllp_plain` listener is cleartext PHI: refused in production, opt-in elsewhere,
// and FAIL CLOSED (no option ⇒ environment-derived). Proven at three layers: the pure policy, the supervisor's
// boot gate, and the REAL registry with a REAL socket ("binds nothing").
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ExternalInterfaceBaaResult } from "../feed/baa-gate";
import {
  PLAIN_LISTENER_REFUSAL,
  PlainListenerRefusedError,
  type SupervisorAlert,
  type SupervisorDeps,
  type SupervisorFeedDescriptor,
  createTlsListenerRegistry,
  inboundPlainAllowed,
  listenerProtocolRefusal,
  startFeedListener,
} from "../listener";

const feed = (over: Partial<SupervisorFeedDescriptor> = {}): SupervisorFeedDescriptor => ({
  id: "feed-plain-1",
  organizationId: "org-1",
  kind: "adt_inbound",
  displayName: "Partner ADT",
  port: 0,
  protocol: "mllp_plain",
  status: "active",
  baaContractRef: "baa-1",
  sendingFacilityAllowlist: ["SENDFAC"],
  ...over,
});

describe("inboundPlainAllowed (pure policy)", () => {
  it("production is NEVER allowed — the opt-in is ignored", () => {
    expect(inboundPlainAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(inboundPlainAllowed({ NODE_ENV: "production", M29_ALLOW_MLLP_PLAIN: "true" })).toBe(false);
  });
  it("non-production requires the explicit opt-in", () => {
    expect(inboundPlainAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(inboundPlainAllowed({ NODE_ENV: "test" })).toBe(false);
    expect(inboundPlainAllowed({ NODE_ENV: "development", M29_ALLOW_MLLP_PLAIN: "false" })).toBe(false);
    expect(inboundPlainAllowed({ NODE_ENV: "development", M29_ALLOW_MLLP_PLAIN: "true" })).toBe(true);
    expect(inboundPlainAllowed({ M29_ALLOW_MLLP_PLAIN: "true" })).toBe(true);
  });
  it("only mllp_plain is ever refused", () => {
    expect(listenerProtocolRefusal("mllp_tls", false)).toBeNull();
    expect(listenerProtocolRefusal("mllp_plain", false)).toBe(PLAIN_LISTENER_REFUSAL);
    expect(listenerProtocolRefusal("mllp_plain", true)).toBeNull();
  });
});

describe("supervisor boot gate", () => {
  const activeBaa: ExternalInterfaceBaaResult = {
    isActive: true,
    status: "executed",
  } as ExternalInterfaceBaaResult;

  function harness(allowPlainProtocol?: boolean) {
    const started: string[] = [];
    const alerts: SupervisorAlert[] = [];
    const logs: { event: string; fields: Record<string, unknown> }[] = [];
    const calls = { baa: 0 };
    const deps: SupervisorDeps = {
      loadActiveInboundFeeds: async () => [],
      loadFeedById: async () => null,
      baaGate: {
        baaStatusBySendingFacility: async () => {
          calls.baa += 1;
          return activeBaa;
        },
        baaStatusByMdmEntity: async () => {
          calls.baa += 1;
          return activeBaa;
        },
      },
      registry: {
        start: async (f) => {
          started.push(f.id);
        },
        stop: async () => {},
        boundFeedIds: () => [...started],
      },
      dispatchAlert: async (a) => {
        alerts.push(a);
      },
      drainInflight: async () => {},
      emitShutdownAudit: async () => {},
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      log: (_l, event, fields) => {
        logs.push({ event, fields });
      },
      ...(allowPlainProtocol === undefined ? {} : { allowPlainProtocol }),
    };
    return { deps, started, alerts, logs, calls };
  }

  it("refuses a plain feed when not allowed: not started, critical PHI-free alert, BAA gate never consulted", async () => {
    const h = harness(false);
    const out = await startFeedListener(feed(), h.deps);
    expect(out).toEqual({ feedId: "feed-plain-1", started: false, reason: PLAIN_LISTENER_REFUSAL });
    expect(h.started).toEqual([]);
    expect(h.calls.baa).toBe(0);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ severity: "critical", channel: "compliance", feedId: "feed-plain-1" });
    // no allowlist / partner-facility detail leaks into the alert or the log
    expect(JSON.stringify([h.alerts, h.logs])).not.toContain("SENDFAC");
    expect(h.logs.map((l) => l.event)).toContain("hl7.listener.plain_refuse");
  });

  it("starts a plain feed only when explicitly allowed", async () => {
    const h = harness(true);
    const out = await startFeedListener(feed(), h.deps);
    expect(out).toEqual({ feedId: "feed-plain-1", started: true });
    expect(h.started).toEqual(["feed-plain-1"]);
    expect(h.alerts).toEqual([]);
  });

  it("FAIL CLOSED: with no option it derives from the environment (no opt-in set) ⇒ refused", async () => {
    const saved = process.env.M29_ALLOW_MLLP_PLAIN;
    delete process.env.M29_ALLOW_MLLP_PLAIN;
    try {
      const h = harness();
      const out = await startFeedListener(feed(), h.deps);
      expect(out).toMatchObject({ started: false, reason: PLAIN_LISTENER_REFUSAL });
      expect(h.started).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.M29_ALLOW_MLLP_PLAIN = saved;
    }
  });

  it("a TLS feed is unaffected by the plain policy", async () => {
    const h = harness(false);
    const out = await startFeedListener(feed({ protocol: "mllp_tls" }), h.deps);
    expect(out).toEqual({ feedId: "feed-plain-1", started: true });
  });
});

describe("real registry — the bind point refuses, and binds NOTHING", () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  /** Grab a free port, release it, and hand it to the registry so a bind can be probed afterwards. */
  async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
  }
  function canConnect(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const s = net.connect({ port, host: "127.0.0.1" });
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
  }
  const registry = (allowPlainProtocol?: boolean) =>
    createTlsListenerRegistry({
      loadCredential: async () => {
        throw new Error("plain feeds must never load a credential");
      },
      connectionDeps: () => {
        throw new Error("a refused feed must not reach connection setup");
      },
      log: () => {},
      ...(allowPlainProtocol === undefined ? {} : { allowPlainProtocol }),
    });

  it("production-style policy: start throws PlainListenerRefusedError, no listener is bound, the port stays closed", async () => {
    const port = await freePort();
    const reg = registry(false);
    await expect(reg.start(feed({ port }))).rejects.toBeInstanceOf(PlainListenerRefusedError);
    expect(reg.boundFeedIds()).toEqual([]);
    expect(await canConnect(port)).toBe(false);
  });

  it("the refusal error carries no host/port detail", async () => {
    const err = await registry(false)
      .start(feed({ port: 65000 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlainListenerRefusedError);
    expect((err as Error).message).not.toMatch(/65000|127\.0\.0\.1|SENDFAC/);
    expect((err as PlainListenerRefusedError).code).toBe("M29_LISTENER_PLAIN_REFUSED");
  });

  it("FAIL CLOSED: no option and no opt-in in the environment ⇒ refused, nothing bound", async () => {
    const saved = process.env.M29_ALLOW_MLLP_PLAIN;
    delete process.env.M29_ALLOW_MLLP_PLAIN;
    const port = await freePort();
    try {
      const reg = registry();
      await expect(reg.start(feed({ port }))).rejects.toBeInstanceOf(PlainListenerRefusedError);
      expect(await canConnect(port)).toBe(false);
    } finally {
      if (saved !== undefined) process.env.M29_ALLOW_MLLP_PLAIN = saved;
    }
  });

  it("explicit non-production opt-in: the plain listener DOES bind (control), and stop unbinds it", async () => {
    const port = await freePort();
    const reg = createTlsListenerRegistry({
      loadCredential: async () => {
        throw new Error("unused");
      },
      // `canConnect` below opens a real socket, which reaches `handleMllpConnection` — and that calls
      // `socket.setTimeout(deps.readTimeoutMs)`. A stub without it throws inside the server's connection
      // callback (an uncaught exception that fails the whole vitest run even though every test passes).
      connectionDeps: () => ({ log: () => {}, readTimeoutMs: 60_000 }) as never,
      log: () => {},
      allowPlainProtocol: true,
    });
    await reg.start(feed({ port }));
    expect(reg.boundFeedIds()).toEqual(["feed-plain-1"]);
    expect(await canConnect(port)).toBe(true);
    await reg.stop("feed-plain-1", "shutdown");
    expect(await canConnect(port)).toBe(false);
  });
});
